(() => {
  if (window.__TTM_STREAK_HELPER__) return;
  window.__TTM_STREAK_HELPER__ = true;

  let rescueActive = false;
  let rescueTarget = null;
  let lastVideoTime = 0;
  let lastPlayAttemptAt = 0;
  let scanTimer = null;

  function send(type, payload = {}) {
    try {
      chrome.runtime.sendMessage({ type, ...payload }, () => {});
    } catch {}
  }

  function parseStreakAnchor(anchor) {
    const label = String(anchor?.getAttribute("aria-label") || "").trim();
    const match = label.match(/^Save your Streak,\s*streak of\s*(\d+)\s*streams?\s*on\s*(.+)$/i);
    if (!match) return null;

    const channel = String(match[2] || "").trim().toLowerCase();
    const href = anchor?.href || anchor?.getAttribute("href") || "";
    if (!channel || !href) return null;

    return {
      channel,
      streak: Number(match[1] || 0) || 0,
      url: href
    };
  }

  function collectStreaks() {
    const group = document.querySelector('[role="group"][aria-label="Watch Streaks at risk"]');
    const anchors = group
      ? Array.from(group.querySelectorAll('a[aria-label^="Save your Streak"]'))
      : Array.from(document.querySelectorAll('a[aria-label^="Save your Streak"]'));

    const streaks = anchors.map(parseStreakAnchor).filter(Boolean);
    const sidebarPresent = !!document.querySelector(
      '[data-test-selector="side-nav"], [data-a-target="side-nav"], [data-a-id^="followed-channel-"], [aria-label="Watch Streaks at risk"]'
    );

    return {
      streaks,
      group_present: !!group,
      sidebar_present: sidebarPresent,
      scan_ready: document.readyState === "complete" && (sidebarPresent || !!group)
    };
  }

  function scanNow() {
    const result = collectStreaks();
    send("TTM_STREAK_SCAN", {
      ...result,
      url: location.href,
      at: Date.now()
    });
  }

  function scheduleScan(delay = 1200) {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scanNow, delay);
  }

  function isVodPage() {
    return /^\/videos\/\d+(?:\/|$)/i.test(location.pathname);
  }

  function isAdPlaying() {
    return !!(
      document.querySelector('[data-test-selector="ad-banner-default-text"]') ||
      document.querySelector('[data-a-player-state="advertising"]')
    );
  }

  async function tryPlay(video) {
    if (!video || !rescueActive) return;
    if (Date.now() - lastPlayAttemptAt < 30000) return;
    lastPlayAttemptAt = Date.now();

    try {
      const button = document.querySelector('[data-a-target="player-play-pause-button"]');
      const label = String(button?.getAttribute("aria-label") || "");
      if (/play/i.test(label)) button.click();
    } catch {}

    if (video.paused) {
      try {
        await video.play();
      } catch {}
    }
  }

  async function playbackTick() {
    if (!rescueActive || !isVodPage()) {
      lastVideoTime = 0;
      return;
    }

    const video = document.querySelector("video");
    if (!video) {
      send("TTM_STREAK_PLAYBACK", {
        url: location.href,
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
    const advancing = deltaSeconds > 0.05 && deltaSeconds <= 10;
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
    if (rescueActive) playbackTick().catch(() => {});
    sendResponse?.({ ok: true });
  });

  const observer = new MutationObserver(() => scheduleScan());
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true
  });

  window.addEventListener("popstate", () => scheduleScan(500));
  window.addEventListener("pageshow", () => scheduleScan(500));

  setInterval(scanNow, 30000);
  setInterval(() => playbackTick().catch(() => {}), 5000);

  scheduleScan(700);
})();
