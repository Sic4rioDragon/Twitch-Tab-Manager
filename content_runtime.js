(() => {
  if (window.__TTM_RUNTIME_V3__) return;
  window.__TTM_RUNTIME_V3__ = true;

  const blockedRoutes = new Set([
    "directory", "p", "videos", "friends", "inventory", "drops", "settings",
    "messages", "login", "logout", "downloads", "moderator", "subscriptions"
  ]);

  let lastPageSignature = "";
  let lastSidebarSignature = "";
  let pageTimer = null;
  let sidebarTimer = null;

  function channelFromLocation() {
    try {
      const u = new URL(location.href);
      if (!/(^|\.)twitch\.tv$/i.test(u.hostname)) return "";
      const first = u.pathname.split("/").filter(Boolean)[0]?.toLowerCase() || "";
      return first && !blockedRoutes.has(first) ? first : "";
    } catch {
      return "";
    }
  }

  function offlineDom() {
    const liveBadge = document.querySelector(
      '[data-a-target="stream-live-indicator"], [data-test-selector="stream-live-indicator"], .live-time'
    );
    if (liveBadge) return false;

    const direct = [
      '[data-a-target="channel-offline-info"]',
      '[data-a-target="offline-channel-main-content"]',
      '[data-a-target="player-overlay-offline-channel-text"]',
      '[data-test-selector="player-overlay-offline-channel-text"]',
      '[data-a-target="channel-status-text"]',
      '[data-test-selector="channel-status-text"]'
    ].some((selector) => {
      const node = document.querySelector(selector);
      return !!(node && /(?:\bis offline\b|\boffline\b|last live|check out this)/i.test(node.textContent || ""));
    });
    if (direct) return true;

    return [...document.querySelectorAll("p,h1,h2,h3,strong")].some((el) =>
      /(?:\bis offline\b|\bcurrently offline\b|\blast live\b)/i.test((el.textContent || "").trim())
    );
  }

  function playerElement() {
    return !!(
      document.querySelector('[data-a-target="video-player"]') ||
      document.querySelector(".video-player") ||
      document.querySelector("video")
    );
  }

  function runtimeSnapshot() {
    const video = document.querySelector("video");
    let raid = false;
    try { raid = new URL(location.href).searchParams.get("referrer") === "raid"; } catch {}

    return {
      ok: true,
      url: location.href,
      title: document.title,
      channel: channelFromLocation(),
      readyState: document.readyState,
      documentReady: document.readyState === "interactive" || document.readyState === "complete",
      documentHidden: !!document.hidden,
      documentFocused: !!document.hasFocus(),
      offlineDom: offlineDom(),
      raid,
      playerElement: playerElement(),
      hasVideo: !!video,
      paused: !!video?.paused,
      muted: !!video?.muted,
      videoReadyState: Number(video?.readyState ?? -1),
      networkState: Number(video?.networkState ?? -1),
      currentTime: Number(video?.currentTime || 0)
    };
  }

  function pageSignature(snap) {
    return JSON.stringify({
      url: snap.url,
      channel: snap.channel,
      readyState: snap.readyState,
      documentReady: snap.documentReady,
      offlineDom: snap.offlineDom,
      raid: snap.raid,
      playerElement: snap.playerElement,
      hasVideo: snap.hasVideo
    });
  }

  function sendPageState(force = false) {
    const snap = runtimeSnapshot();
    const signature = pageSignature(snap);
    if (!force && signature === lastPageSignature) return;
    lastPageSignature = signature;
    try { chrome.runtime.sendMessage({ type: "TTM_PAGE_STATE", ...snap }, () => {}); } catch {}
  }

  function scanSidebarLive(force = false) {
    const live = [];
    const streaks = [];

    for (const a of document.querySelectorAll('a[data-test-selector="followed-channel"], a[data-a-id^="followed-channel-"]')) {
      const href = a.getAttribute("href") || "";
      const login = href.split("?")[0].split("/").filter(Boolean)[0]?.toLowerCase() || "";
      if (!login) continue;

      const liveStatus = a.querySelector('[data-a-target="side-nav-live-status"]');
      const isLive = !!liveStatus && /\blive\b/i.test(liveStatus.textContent || "");
      if (isLive) live.push(login);

      const streakEl = a.querySelector('[title^="Watch Streak "]');
      if (streakEl) {
        const m = String(streakEl.getAttribute("title") || "").match(/^Watch Streak\s+(\d+)$/i);
        if (m) streaks.push({ login, streak: Number(m[1]) });
      }
    }

    const uniqLive = [...new Set(live)];
    const normalizedStreaks = streaks
      .filter((x) => x.login && Number.isFinite(x.streak))
      .sort((a, b) => a.login.localeCompare(b.login));

    const signature = JSON.stringify({ live: uniqLive.slice().sort(), streaks: normalizedStreaks });
    if (!force && signature === lastSidebarSignature) return;
    lastSidebarSignature = signature;

    try {
      chrome.runtime.sendMessage({
        type: "TTM_SIDEBAR_STATE",
        live: uniqLive,
        streaks: normalizedStreaks,
        sourceUrl: location.href
      }, () => {});
    } catch {}
  }

  function schedulePage(delay = 500) {
    if (pageTimer) return;
    pageTimer = setTimeout(() => {
      pageTimer = null;
      sendPageState(false);
    }, delay);
  }

  function scheduleSidebar(delay = 900) {
    if (sidebarTimer) return;
    sidebarTimer = setTimeout(() => {
      sidebarTimer = null;
      scanSidebarLive(false);
    }, delay);
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "TTM_RUNTIME_SNAPSHOT") {
      sendResponse(runtimeSnapshot());
      return true;
    }
  });

  // Twitch is extremely mutation-heavy (chat, viewer count, 7TV, etc.). Never
  // send one extension message per DOM mutation; coalesce observations instead.
  const observer = new MutationObserver(() => {
    schedulePage();
    scheduleSidebar();
  });
  observer.observe(document.documentElement, { subtree: true, childList: true });

  window.addEventListener("pageshow", () => {
    sendPageState(true);
    scanSidebarLive(true);
  });
  window.addEventListener("popstate", () => {
    setTimeout(() => sendPageState(true), 150);
    setTimeout(() => scanSidebarLive(true), 350);
  });

  // Heartbeat catches background SPA/player changes even when no useful DOM
  // mutation occurs. It is intentionally low-frequency to stay lightweight.
  setInterval(() => sendPageState(true), 15_000);
  setInterval(() => scanSidebarLive(true), 30_000);

  setTimeout(() => {
    sendPageState(true);
    scanSidebarLive(true);
  }, 400);
})();
