(() => {
  const VERSION = 2;
  if (Number(window.__TTM_STREAK_HELPER_VERSION__ || 0) >= VERSION) return;
  window.__TTM_STREAK_HELPER_VERSION__ = VERSION;
  window.__TTM_STREAK_HELPER__ = true;

  let rescueActive = false;
  let rescueTarget = null;
  let lastVideoTime = 0;
  let lastPlayAttemptAt = 0;
  let scanTimer = null;

  const BLOCKED_CHANNEL_ROUTES = new Set([
    "directory", "p", "videos", "friends", "inventory", "drops", "settings",
    "messages", "login", "logout", "downloads", "moderator", "subscriptions",
    "wallet", "jobs", "schedule", "about"
  ]);

  function send(type, payload = {}) {
    try { chrome.runtime.sendMessage({ type, ...payload }, () => {}); } catch {}
  }

  function normalizeUrl(value) {
    try { return new URL(String(value || ""), location.origin).href; }
    catch { return ""; }
  }

  function twitchPathFirst(value) {
    try {
      const u = new URL(String(value || ""), location.origin);
      if (!/(^|\.)twitch\.tv$/i.test(u.hostname)) return "";
      const first = u.pathname.split("/").filter(Boolean)[0]?.toLowerCase() || "";
      return first && !BLOCKED_CHANNEL_ROUTES.has(first) ? first : "";
    } catch {
      return "";
    }
  }

  function textOf(node) {
    if (!node) return "";
    return [
      node.getAttribute?.("aria-label"),
      node.getAttribute?.("title"),
      node.textContent
    ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  }

  function extractStreakNumber(text) {
    const value = String(text || "");
    const patterns = [
      /streak\s+of\s+(\d+)/i,
      /watch\s+streak\s*[:#-]?\s*(\d+)/i,
      /(\d+)\s*(?:stream|streams)?\s*streak/i,
      /streak\s*[:#-]?\s*(\d+)/i
    ];
    for (const re of patterns) {
      const m = value.match(re);
      if (m) return Number(m[1] || 0) || 0;
    }
    return 0;
  }

  function candidateContainer(anchor) {
    let node = anchor;
    for (let i = 0; i < 5 && node; i += 1, node = node.parentElement) {
      const txt = textOf(node);
      if (/save\s+your\s+streak|watch\s+streak/i.test(txt)) return node;
      if (node.getAttribute?.("role") === "listitem") return node;
    }
    return anchor?.parentElement || anchor;
  }

  function extractChannel(text, anchor, container) {
    const fromHref = twitchPathFirst(anchor?.href || anchor?.getAttribute?.("href") || "");
    if (fromHref) return fromHref;

    const value = String(text || "");
    for (const re of [
      /\bon\s+([a-z0-9_]{2,25})\b/i,
      /\bfor\s+([a-z0-9_]{2,25})\b/i,
      /@([a-z0-9_]{2,25})\b/i
    ]) {
      const m = value.match(re);
      if (m) return String(m[1] || "").toLowerCase();
    }

    const links = Array.from(container?.querySelectorAll?.("a[href]") || []);
    for (const link of links) {
      const ch = twitchPathFirst(link.href || link.getAttribute("href") || "");
      if (ch) return ch;
    }

    const labels = Array.from(container?.querySelectorAll?.("[aria-label],[title],img[alt]") || []);
    for (const node of labels.slice(0, 30)) {
      const label = [node.getAttribute?.("aria-label"), node.getAttribute?.("title"), node.getAttribute?.("alt")]
        .filter(Boolean).join(" ");
      const m = label.match(/(?:on|for|channel)\s+([a-z0-9_]{2,25})\b/i);
      if (m) return String(m[1] || "").toLowerCase();
    }

    return "";
  }

  function parseStreakCandidate(anchor) {
    if (!anchor) return null;
    const href = normalizeUrl(anchor.href || anchor.getAttribute?.("href") || "");
    if (!href) return null;
    try {
      const u = new URL(href);
      if (!/(^|\.)twitch\.tv$/i.test(u.hostname)) return null;
    } catch {
      return null;
    }

    const container = candidateContainer(anchor);
    const text = `${textOf(anchor)} ${textOf(container)}`.replace(/\s+/g, " ").trim();
    const isSaveEntry = /save\s+your\s+streak/i.test(text);
    const isRiskEntry = /watch\s+streak/i.test(text) && /(?:at\s+risk|risk|save)/i.test(text);
    if (!isSaveEntry && !isRiskEntry) return null;

    const channel = extractChannel(text, anchor, container);
    if (!channel) return null;

    return {
      channel,
      streak: extractStreakNumber(text),
      url: href
    };
  }

  function collectRiskGroups() {
    const groups = [];
    for (const node of document.querySelectorAll('[role="group"], [aria-label]')) {
      const label = String(node.getAttribute?.("aria-label") || "");
      if (/watch\s+streak/i.test(label) && /risk/i.test(label)) groups.push(node);
    }

    for (const node of document.querySelectorAll("h1,h2,h3,h4,span,p")) {
      if (!/watch\s+streaks?\s+at\s+risk/i.test(String(node.textContent || ""))) continue;
      const parent = node.closest?.('[role="group"],section,div');
      if (parent) groups.push(parent);
    }

    return [...new Set(groups)];
  }

  function collectAtRiskStreaks() {
    const anchors = new Set();
    const groups = collectRiskGroups();

    for (const group of groups) {
      for (const a of group.querySelectorAll?.("a[href]") || []) anchors.add(a);
    }

    // Twitch has changed this surface a few times. Do not depend on one exact
    // aria-label; inspect accessible text/title and nearby card text instead.
    for (const a of document.querySelectorAll("a[href]")) {
      const txt = `${textOf(a)} ${textOf(a.parentElement)}`;
      if (/save\s+your\s+streak/i.test(txt)) anchors.add(a);
    }

    const parsed = [...anchors].map(parseStreakCandidate).filter(Boolean);
    const deduped = new Map();
    for (const item of parsed) {
      const key = `${item.channel}|${item.url}`;
      const prev = deduped.get(key);
      if (!prev || Number(item.streak || 0) > Number(prev.streak || 0)) deduped.set(key, item);
    }

    return {
      streaks: [...deduped.values()],
      candidate_count: anchors.size,
      group_count: groups.length
    };
  }

  function collectWatchStreakBadges() {
    const out = [];
    const cards = Array.from(document.querySelectorAll(
      'a[data-test-selector="followed-channel"], a[data-a-id^="followed-channel-"]'
    ));

    for (const card of cards) {
      const badge = Array.from(card.querySelectorAll?.("[title],[aria-label]") || []).find((node) =>
        /watch\s+streak/i.test(String(node.getAttribute?.("title") || node.getAttribute?.("aria-label") || ""))
      );
      if (!badge) continue;

      const label = String(badge.getAttribute("title") || badge.getAttribute("aria-label") || badge.textContent || "").trim();
      const streak = extractStreakNumber(label);
      const channel = twitchPathFirst(card.href || card.getAttribute("href") || "");
      if (!channel) continue;
      out.push({ channel, streak });
    }

    const byChannel = new Map();
    for (const item of out) byChannel.set(item.channel, item);
    return [...byChannel.values()];
  }

  function collectStreaks() {
    const risk = collectAtRiskStreaks();
    const sidebarPresent = !!document.querySelector(
      '[data-test-selector="side-nav"], [data-a-target="side-nav"], [data-a-id^="followed-channel-"], a[data-test-selector="followed-channel"]'
    );
    const followedCardsPresent = !!document.querySelector(
      'a[data-test-selector="followed-channel"], a[data-a-id^="followed-channel-"]'
    );
    const complete = document.readyState === "complete";

    return {
      streaks: risk.streaks,
      watch_streaks: collectWatchStreakBadges(),
      watch_streak_scan_ready: complete && followedCardsPresent,
      group_present: risk.group_count > 0,
      sidebar_present: sidebarPresent,
      scan_ready: complete && (sidebarPresent || risk.group_count > 0 || risk.candidate_count > 0),
      candidate_count: risk.candidate_count,
      group_count: risk.group_count,
      helper_version: VERSION
    };
  }

  function scanNow() {
    const result = collectStreaks();
    send("TTM_STREAK_SCAN", { ...result, url: location.href, at: Date.now() });
  }

  function scheduleScan(delay = 900) {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scanNow, delay);
  }

  function isRescueMediaPage() {
    if (!rescueActive) return false;
    if (/^\/videos\/\d+(?:\/|$)/i.test(location.pathname)) return true;
    try {
      if (rescueTarget?.url) {
        const target = new URL(rescueTarget.url, location.origin);
        if (target.hostname === location.hostname && target.pathname === location.pathname) return true;
      }
    } catch {}
    return !!document.querySelector("video");
  }

  function isAdPlaying() {
    return !!(
      document.querySelector('[data-test-selector="ad-banner-default-text"]') ||
      document.querySelector('[data-a-player-state="advertising"]')
    );
  }

  async function tryPlay(video) {
    if (!video || !rescueActive) return;
    if (Date.now() - lastPlayAttemptAt < 15000) return;
    lastPlayAttemptAt = Date.now();

    try {
      const button = document.querySelector('[data-a-target="player-play-pause-button"]');
      const label = String(button?.getAttribute("aria-label") || "");
      if (/\bplay\b/i.test(label)) button.click();
    } catch {}

    if (video.paused) {
      try {
        await video.play();
      } catch {
        // A dedicated rescue page may need muted autoplay in a background tab.
        // This is the Twitch video element only; Chromium's browser-tab mute
        // state is never changed by this helper.
        try {
          video.muted = true;
          await video.play();
        } catch {}
      }
    }
  }

  async function playbackTick() {
    if (!rescueActive || !isRescueMediaPage()) {
      lastVideoTime = 0;
      return;
    }

    const video = document.querySelector("video");
    if (!video) {
      send("TTM_STREAK_PLAYBACK", {
        url: location.href,
        target_channel: rescueTarget?.channel || "",
        playing: false,
        delta_ms: 0,
        hasVideo: false,
        readyState: -1,
        currentTime: 0,
        adPlaying: false
      });
      return;
    }

    await tryPlay(video);

    const currentTime = Number(video.currentTime || 0);
    const deltaSeconds = lastVideoTime > 0 ? currentTime - lastVideoTime : 0;
    const advancing = deltaSeconds > 0.05 && deltaSeconds <= 12;
    const playing = !video.paused && !video.ended && Number(video.readyState || 0) >= 2;
    const adPlaying = isAdPlaying();

    send("TTM_STREAK_PLAYBACK", {
      url: location.href,
      target_channel: rescueTarget?.channel || "",
      playing,
      delta_ms: advancing && playing && !adPlaying ? Math.round(deltaSeconds * 1000) : 0,
      hasVideo: true,
      paused: !!video.paused,
      ended: !!video.ended,
      readyState: Number(video.readyState || -1),
      currentTime,
      adPlaying
    });

    lastVideoTime = currentTime;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== "TTM_STREAK_RESCUE_CONTROL") return;
    rescueActive = !!msg.active;
    rescueTarget = msg.target || null;
    lastVideoTime = 0;
    lastPlayAttemptAt = 0;
    if (rescueActive) {
      playbackTick().catch(() => {});
      scheduleScan(300);
    }
    sendResponse?.({ ok: true, helper_version: VERSION });
  });

  const observer = new MutationObserver(() => scheduleScan());
  observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true });

  window.addEventListener("popstate", () => scheduleScan(350));
  window.addEventListener("pageshow", () => scheduleScan(350));
  window.addEventListener("load", () => scheduleScan(350));
  document.addEventListener("visibilitychange", () => scheduleScan(350));

  setInterval(scanNow, 20000);
  setInterval(() => playbackTick().catch(() => {}), 5000);
  scheduleScan(500);
})();
