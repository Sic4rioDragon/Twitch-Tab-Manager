import { state, log } from "./core.js";

const T = (globalThis.TTM = globalThis.TTM || {});

const TTM_REPOKE_ALARM = "ttm-repoke";
const REPOKE_DELAYS_MS = [1500, 4500, 9000, 15000, 30000, 60000];

const SOFT_WAKE_MIN_STUCK_MS = 12000;
const SOFT_WAKE_COOLDOWN_MS = 60000;
const BACKGROUND_RELOAD_MIN_STUCK_MS = 30000;
const BACKGROUND_RELOAD_COOLDOWN_MS = 3 * 60 * 1000;

const playerStatusByTab = new Map();
const softWakeByTab = new Map();
const backgroundReloadByTab = new Map();

globalThis.__TTM_PLAYER_STATUS_MAP__ = playerStatusByTab;

function rememberPlayerStatus(tabId, status) {
  const prev = playerStatusByTab.get(tabId) || {};
  playerStatusByTab.set(tabId, {
    ...prev,
    ...status,
    seenAt: Date.now()
  });
}

function getPlayerStatus(tabId) {
  return playerStatusByTab.get(tabId) || null;
}

async function injectHelpers(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content_unmute.js", "content_status.js", "content_streaks.js"]
    });
  } catch {}
}

async function sendEnforce(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "TTM_ENFORCE",
      settings: {
        force_unmute: !!state.settings.force_unmute,
        unmute_streams: !!state.settings.unmute_streams,
        force_resume: !!state.settings.force_resume,
        autoplay_streams: !!state.settings.autoplay_streams
      }
    });
  } catch {}
}

async function pokeChannelTab(tabId) {
  await injectHelpers(tabId);
  await sendEnforce(tabId);
}

function scheduleTabRepokes(tabId) {
  for (const delay of REPOKE_DELAYS_MS) {
    setTimeout(async () => {
      try {
        if (!T.isManagerEnabled()) return;
        await pokeChannelTab(tabId);
      } catch {}
    }, delay);
  }
}

function getBadStateInfo(tabId) {
  const status = getPlayerStatus(tabId);
  if (!status) return { status: null, isBad: false, firstSeenBadAt: 0 };

  const isBad =
    !status.hasVideo ||
    !!status.paused ||
    !!status.muted ||
    !!status.stalledStart;

  const firstSeenBadAt = Number(status.firstSeenBadAt || 0);

  return { status, isBad, firstSeenBadAt };
}

function shouldSoftWake(tabId) {
  if (!state.settings.soft_wake_tabs) return false;

  const { status, isBad, firstSeenBadAt } = getBadStateInfo(tabId);
  if (!status) return false;
  if (status.adPlaying) return false;
  if (!isBad) return false;

  const now = Date.now();
  const seenBadAt = firstSeenBadAt || now;
  const lastWakeAt = softWakeByTab.get(tabId) || 0;

  if (now - seenBadAt < SOFT_WAKE_MIN_STUCK_MS) return false;
  if (now - lastWakeAt < SOFT_WAKE_COOLDOWN_MS) return false;

  return true;
}

function shouldBackgroundReload(tabId) {
  if (!state.settings.soft_wake_tabs) return false;

  const { status, isBad, firstSeenBadAt } = getBadStateInfo(tabId);
  if (!status) return false;
  if (status.adPlaying) return false;
  if (!isBad) return false;

  const now = Date.now();
  const seenBadAt = firstSeenBadAt || now;
  const lastReloadAt = backgroundReloadByTab.get(tabId) || 0;

  if (now - seenBadAt < BACKGROUND_RELOAD_MIN_STUCK_MS) return false;
  if (now - lastReloadAt < BACKGROUND_RELOAD_COOLDOWN_MS) return false;

  return true;
}

async function canSoftWakeWithoutStealingFromOtherApps() {
  if (!state.settings.soft_wake_tabs) return false;
  if (!state.settings.soft_wake_only_when_browser_focused) return true;

  try {
    const currentWindow = await chrome.windows.getLastFocused();
    return !!currentWindow?.focused;
  } catch {
    return false;
  }
}

async function softWakeTab(tabId) {
  if (!(await canSoftWakeWithoutStealingFromOtherApps())) return false;

  try {
    // Hands-off only: re-inject + re-enforce without focusing windows/tabs
    await pokeChannelTab(tabId);

    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: () => {
          try {
            document.dispatchEvent(new Event("visibilitychange"));
            window.dispatchEvent(new Event("focus"));
            window.dispatchEvent(new Event("pageshow"));
          } catch {}
        }
      });
    } catch {}

    softWakeByTab.set(tabId, Date.now());
    log("soft_wake_ok", { tabId, mode: "hands_off" });
    return true;
  } catch (e) {
    log("soft_wake_error", { tabId, error: String(e) });
    return false;
  }
}

async function backgroundReloadTab(tabId) {
  if (!(await canSoftWakeWithoutStealingFromOtherApps())) return false;

  try {
    await chrome.tabs.reload(tabId);
    backgroundReloadByTab.set(tabId, Date.now());
    log("soft_wake_background_reload", { tabId });

    setTimeout(() => {
      pokeChannelTab(tabId).catch(() => {});
      scheduleTabRepokes(tabId);
    }, 2500);

    return true;
  } catch (e) {
    log("soft_wake_background_reload_error", { tabId, error: String(e) });
    return false;
  }
}

async function reviewManagedTabsForSoftWake() {
  const managedChannels = new Set(await T.listManaged());
  if (!managedChannels.size) return;

  try {
    const tabs = await chrome.tabs.query({
      url: ["*://www.twitch.tv/*", "*://twitch.tv/*"]
    });

    for (const tab of tabs) {
      const ch = T.channelFromUrl(tab.url || tab.pendingUrl || "");
      if (!ch || !managedChannels.has(ch)) continue;

      const status = getPlayerStatus(tab.id);
      if (!status) continue;

      if (
        (!status.hasVideo || status.paused || status.muted || status.stalledStart) &&
        !status.adPlaying
      ) {
        if (!status.firstSeenBadAt) {
          rememberPlayerStatus(tab.id, { firstSeenBadAt: Date.now() });
        }
      } else {
        rememberPlayerStatus(tab.id, { firstSeenBadAt: 0 });
      }

      if (shouldSoftWake(tab.id)) {
        await softWakeTab(tab.id);
      }

      if (shouldBackgroundReload(tab.id)) {
        await backgroundReloadTab(tab.id);
      }
    }
  } catch (e) {
    log("soft_wake_review_error", String(e));
  }
}

async function repokeManagedTabs() {
  const managedChannels = new Set(await T.listManaged());
  if (!managedChannels.size) return;
  if (!T.isManagerEnabled()) return;

  try {
    const tabs = await chrome.tabs.query({
      url: ["*://www.twitch.tv/*", "*://twitch.tv/*"]
    });

    for (const tab of tabs) {
      const ch = T.channelFromUrl(tab.url || tab.pendingUrl || "");
      if (!ch || !managedChannels.has(ch)) continue;
      await pokeChannelTab(tab.id);
    }

    await reviewManagedTabsForSoftWake();
  } catch (e) {
    log("repoke_error", String(e));
  }
}

T.TTM_REPOKE_ALARM = TTM_REPOKE_ALARM;
T.rememberPlayerStatus = rememberPlayerStatus;
T.getPlayerStatus = getPlayerStatus;
T.pokeChannelTab = pokeChannelTab;
T.scheduleTabRepokes = scheduleTabRepokes;
T.shouldSoftWake = shouldSoftWake;
T.softWakeTab = softWakeTab;
T.reviewManagedTabsForSoftWake = reviewManagedTabsForSoftWake;
T.repokeManagedTabs = repokeManagedTabs;

export {
  TTM_REPOKE_ALARM,
  rememberPlayerStatus,
  getPlayerStatus,
  pokeChannelTab,
  scheduleTabRepokes,
  shouldSoftWake,
  softWakeTab,
  reviewManagedTabsForSoftWake,
  repokeManagedTabs
};