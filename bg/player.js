import { state, log } from "./core.js";
import { isManagerWindowUnfocused } from "./manager-window.js";
import { getTabRecord } from "./registry.js";

const T = (globalThis.TTM = globalThis.TTM || {});

const TTM_REPOKE_ALARM = "ttm-repoke";
const REPOKE_DELAYS_MS = [1500, 4500, 9000, 15000, 30000, 60000];
const playerStatusByTab = new Map();

globalThis.__TTM_PLAYER_STATUS_MAP__ = playerStatusByTab;

function rememberPlayerStatus(tabId, status) {
  if (tabId == null) return;
  const prev = playerStatusByTab.get(tabId) || {};
  playerStatusByTab.set(tabId, { ...prev, ...status, seenAt: Date.now() });
}

function forgetPlayerStatus(tabId) {
  playerStatusByTab.delete(Number(tabId));
}

function getPlayerStatus(tabId) {
  return playerStatusByTab.get(Number(tabId)) || null;
}

async function injectHelpers(tabId) {
  if (!T.isManaged?.(tabId)) return false;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content_runtime.js", "content_unmute.js", "content_status.js", "content_streaks.js"]
    });
    return true;
  } catch {
    return false;
  }
}

async function canControlManagedTab(tabId) {
  if (!T.isManaged?.(tabId)) return false;
  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch { return false; }
  if (!tab?.active) return true;
  return await isManagerWindowUnfocused(tab.windowId);
}

function shouldUseStartupMediaMute(tabId) {
  const rec = getTabRecord(tabId);
  // Media-element muting is only a temporary startup aid. Once this tab has
  // ever demonstrated real playback progress for its current target, never
  // re-mute the Twitch player during later recovery. Browser-tab mute state is
  // preserved independently and is never changed by this recovery path.
  return !Number(rec?.playbackStartedAt || 0);
}

async function sendEnforce(tabId) {
  if (!(await canControlManagedTab(tabId))) return false;

  // Keep the browser tab background-safe without changing its mute/unmute state.
  // Twitch's own player mute state is controlled separately below.
  try {
    await T.makeTabBackgroundSafe?.(tabId);
  } catch {}

  const startupMuted = shouldUseStartupMediaMute(tabId);

  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "TTM_ENFORCE",
      settings: {
        startup_muted: startupMuted,
        // After startup, restore/respect the user's Twitch-player preference.
        // Browser-tab mute/unmute state is preserved exactly as Chromium has it.
        force_unmute: startupMuted ? false : !!state.settings.force_unmute,
        unmute_streams: startupMuted ? false : !!state.settings.unmute_streams,
        force_resume: !!state.settings.force_resume,
        autoplay_streams: !!state.settings.autoplay_streams
      }
    });
    return true;
  } catch {
    return false;
  }
}

async function pokeChannelTab(tabId) {
  if (!(await canControlManagedTab(tabId))) return false;
  await injectHelpers(tabId);
  await sendEnforce(tabId);
  return true;
}

function scheduleTabRepokes(tabId) {
  for (const delay of REPOKE_DELAYS_MS) {
    setTimeout(async () => {
      try {
        if (!T.isManagerEnabled?.()) return;
        if (!T.isManaged?.(tabId)) return;
        await pokeChannelTab(tabId);
      } catch {}
    }, delay);
  }
}

async function repokeManagedTabs() {
  if (!T.isManagerEnabled?.()) return;

  let managedChannels = [];
  try { managedChannels = await T.listManaged?.(); } catch {}
  if (!Array.isArray(managedChannels) || !managedChannels.length) return;

  const managedSet = new Set(managedChannels);
  try {
    const tabs = await chrome.tabs.query({
      url: ["*://www.twitch.tv/*", "*://twitch.tv/*"]
    });

    for (const tab of tabs) {
      if (!tab?.id || !T.isManaged?.(tab.id)) continue;
      if (tab.active && !(await isManagerWindowUnfocused(tab.windowId))) continue;
      const ch = T.channelFromUrl?.(tab.url || tab.pendingUrl || "");
      if (!ch || !managedSet.has(ch)) continue;
      await pokeChannelTab(tab.id);
    }
  } catch (e) {
    log("repoke_error", String(e));
  }
}

T.TTM_REPOKE_ALARM = TTM_REPOKE_ALARM;
T.rememberPlayerStatus = rememberPlayerStatus;
T.forgetPlayerStatus = forgetPlayerStatus;
T.getPlayerStatus = getPlayerStatus;
T.pokeChannelTab = pokeChannelTab;
T.scheduleTabRepokes = scheduleTabRepokes;
T.repokeManagedTabs = repokeManagedTabs;

export {
  TTM_REPOKE_ALARM,
  rememberPlayerStatus,
  forgetPlayerStatus,
  getPlayerStatus,
  pokeChannelTab,
  scheduleTabRepokes,
  repokeManagedTabs
};
