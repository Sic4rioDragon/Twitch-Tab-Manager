(() => {
  if (window.__TTM_STATUS_LOADED__) return;
  window.__TTM_STATUS_LOADED__ = true;

  const startedAt = Date.now();
  const STARTUP_OFFLINE_GRACE_MS = 12000;

  function currentLogin() {
    return location.pathname.replace(/^\/+/, "").split("/")[0]?.toLowerCase() || "";
  }

  function hasOfflineText(node) {
    if (!node) return false;
    const text = (node.textContent || "").trim().toLowerCase();
    return /(?:\boffline\b|\blast live\b|check out this .{0,120} stream)/i.test(text);
  }

  function isOfflineNow() {
    const liveBadge = document.querySelector('[data-a-target="stream-live-indicator"], .live-time, .tw-indicator-live');
    if (liveBadge) return false;

    const selectors = [
      ".channel-status-info--offline strong",
      '[data-a-target="channel-status-text"]',
      '[data-test-selector="channel-status-text"]',
      '[data-a-target="player-overlay-offline-channel-text"]',
      '[data-test-selector="player-overlay-offline-channel-text"]',
      '[data-a-target="offline-channel-main-content"]',
      '[data-test-selector="offline-channel-main-content"]'
    ];

    for (const selector of selectors) {
      const node = document.querySelector(selector);
      if (node && hasOfflineText(node)) return true;
    }

    return false;
  }

  function hasRaidText(text) {
    const value = String(text || "").toLowerCase();
    return (
      value.includes("being raided by") ||
      value.includes("join raid") ||
      value.includes("leave raid") ||
      value.includes("starting raid") ||
      value.includes("you are being raided") ||
      value.includes("raiding")
    );
  }

  function detectRaid() {
    const raidBanner =
      document.querySelector('[data-a-target="raid-banner"]') ||
      document.querySelector('[data-test-selector="raid-banner"]') ||
      document.querySelector(".raid-banner");

    const leaveButton =
      document.querySelector('button[data-a-target="raid-leave-button"]') ||
      document.querySelector('button[data-test-selector="raid-leave-button"]') ||
      Array.from(document.querySelectorAll("button")).find((btn) => hasRaidText(btn.textContent));

    if (raidBanner || leaveButton) return true;

    const textSelectors = [
      '[data-a-target="raid-banner"]',
      '[data-test-selector="raid-banner"]',
      '[data-a-target="raid-notification"]',
      '[data-test-selector="raid-notification"]'
    ];

    return textSelectors.some((selector) => {
      const node = document.querySelector(selector);
      return !!(node && hasRaidText(node.textContent));
    });
  }

  let lastOffline = null;
  let raidSent = false;
  let lastLogin = currentLogin();

  function send(type, payload) {
    const login = currentLogin();
    if (!login) return;

    try {
      chrome.runtime.sendMessage({ type, login, ...(payload || {}) }, () => {});
    } catch {}
  }

  function check() {
    const login = currentLogin();
    if (!login) return;

    if (login !== lastLogin) {
      lastLogin = login;
      lastOffline = null;
      raidSent = false;
    }

    const offline = isOfflineNow();
    const withinStartupGrace = Date.now() - startedAt < STARTUP_OFFLINE_GRACE_MS;

    if (offline !== lastOffline) {
      lastOffline = offline;

      if (offline && withinStartupGrace) {
        return;
      }

      send("channel_status", { isOffline: !!offline });
    }

    if (!raidSent && detectRaid()) {
      raidSent = true;
      send("raid_detected");
    }
  }

  const obs = new MutationObserver(() => check());
  obs.observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true
  });

  setInterval(check, 5000);
  setTimeout(check, 1500);
  setTimeout(check, STARTUP_OFFLINE_GRACE_MS + 250);
})();