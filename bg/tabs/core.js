import { log } from "../core.js";
import { makeBackgroundSafe } from "../browser/tabs.js";

export const RE_CHAN = /^https?:\/\/(?:www\.)?twitch\.tv\/([a-z0-9_]+)(?:\/|$)/i;
export const NON_CHANNEL_ROUTES = new Set([
  "directory",
  "downloads",
  "jobs",
  "p",
  "settings",
  "subscriptions",
  "inventory",
  "wallet",
  "videos",
  "schedule",
  "about"
]);

export const CHANNEL_KEY = "ttm.managed.channels";
export const OWNED_KEY = "ttm.managed.owned";
export const ROTATION_SLOTS_KEY = "ttm.rotation.slots";
export const OPENING_TTL_MS = 5000;

export const tabState = {
  managedChannels: {},
  ownedTabs: {},
  rotationSlots: {}
};

export const opening = new Map();

export function now() {
  return Date.now();
}

export function norm(value) {
  return String(value || "").trim().toLowerCase();
}

export function isRaidLikeUrl(url) {
  return String(url || "").toLowerCase().includes("referrer=raid");
}

export function chanFromUrl(url) {
  const match = String(url || "").match(RE_CHAN);
  if (!match) return null;

  const ch = norm(match[1]);
  if (!ch || NON_CHANNEL_ROUTES.has(ch)) return null;
  return ch;
}

export function isChannelUrl(url) {
  if (isRaidLikeUrl(url)) return false;
  return !!chanFromUrl(url);
}

export function purgeOpening() {
  const t = now();
  for (const [channel, expiresAt] of opening.entries()) {
    if (expiresAt <= t) opening.delete(channel);
  }
}

export async function loadManagedState() {
  const bag = await chrome.storage.session.get([CHANNEL_KEY, OWNED_KEY, ROTATION_SLOTS_KEY]);

  tabState.managedChannels =
    bag?.[CHANNEL_KEY] && typeof bag[CHANNEL_KEY] === "object"
      ? bag[CHANNEL_KEY]
      : {};

  tabState.ownedTabs =
    bag?.[OWNED_KEY] && typeof bag[OWNED_KEY] === "object"
      ? bag[OWNED_KEY]
      : {};

  tabState.rotationSlots =
    bag?.[ROTATION_SLOTS_KEY] && typeof bag[ROTATION_SLOTS_KEY] === "object"
      ? bag[ROTATION_SLOTS_KEY]
      : {};
}

export async function saveManagedState() {
  await chrome.storage.session.set({
    [CHANNEL_KEY]: tabState.managedChannels,
    [OWNED_KEY]: tabState.ownedTabs,
    [ROTATION_SLOTS_KEY]: tabState.rotationSlots
  });
}

export function getRotationSlot(tabId) {
  return tabState.rotationSlots[String(tabId)] || null;
}

export async function setRotationSlot(tabId, data) {
  if (!tabId) return;

  tabState.rotationSlots[String(tabId)] = {
    role: "rotation",
    current_channel: "",
    last_rotated_at: 0,
    recently_used: {},
    ...(tabState.rotationSlots[String(tabId)] || {}),
    ...(data || {})
  };

  await saveManagedState();
}

export async function clearRotationSlot(tabId) {
  if (!tabId) return;
  delete tabState.rotationSlots[String(tabId)];
  await saveManagedState();
}

export function wasRecentlyUsedInRotation(tabId, channel, cooldownMin = 30) {
  const slot = getRotationSlot(tabId);
  if (!slot) return false;

  const ts = Number(slot.recently_used?.[channel] || 0);
  if (!ts) return false;

  const cooldownMs = Math.max(5, Number(cooldownMin || 30)) * 60 * 1000;
  return Date.now() - ts < cooldownMs;
}

export async function markRotationChannelUsed(tabId, channel) {
  const slot = getRotationSlot(tabId) || {
    role: "rotation",
    current_channel: "",
    last_rotated_at: 0,
    recently_used: {}
  };

  slot.current_channel = channel || "";
  slot.last_rotated_at = Date.now();
  slot.recently_used = {
    ...(slot.recently_used || {}),
    [channel]: Date.now()
  };

  tabState.rotationSlots[String(tabId)] = slot;
  await saveManagedState();
}

export async function makeTabBackgroundSafe(tabId, { muted = null } = {}) {
  const ok = await makeBackgroundSafe(tabId, { muted });
  // Background policy failure is non-fatal. Keep it in diagnostics without
  // polluting chrome://extensions with a console error entry.
  if (!ok) log("background_tab_policy_skipped", { tabId });
  return ok;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function ensureBackgroundTabLoaded(tabId, expectedChannel = "", opts = {}) {
  const timeoutMs = Math.max(8000, Number(opts.timeoutMs || 30000));
  const started = Date.now();
  await makeTabBackgroundSafe(tabId);

  while (Date.now() - started < timeoutMs) {
    let tab;
    try { tab = await chrome.tabs.get(tabId); } catch { return false; }

    const rawUrl = tab?.url || tab?.pendingUrl || "";
    const currentChannel = chanFromUrl(rawUrl);
    const channelMatches = !expectedChannel || currentChannel === norm(expectedChannel);

    if (tab?.discarded) {
      // v1.0.13.3: never reload a managed tab just to recover it. The
      // dedicated-window watchdog will mark it failed and retry non-destructively.
      log("background_tab_discarded_during_load", { tabId, channel: expectedChannel || "" });
      return false;
    } else if (tab?.status === "complete" && channelMatches) {
      await makeTabBackgroundSafe(tabId);
      try { await globalThis.TTM?.pokeChannelTab?.(tabId); } catch {}
      // "complete" only proves the document loaded. The v1.0.12 watchdog
      // separately verifies actual video playback progress.
      return true;
    }

    await sleep(750);
  }

  log("background_tab_load_timeout", { tabId, channel: expectedChannel || "", timeout_ms: timeoutMs });
  return false;
}

export async function rehydrateManagedFromReality() {
  const nextChannels = {};
  const nextOwned = {};

  // Preserve the channel TTM originally owned for each tab. A Twitch raid
  // changes the URL to the raid target, but it must NOT erase ownership or
  // make the original channel look free for a replacement tab.
  const priorChannelByTab = new Map();
  for (const [channel, tabIdRaw] of Object.entries(tabState.managedChannels || {})) {
    const tabId = Number(tabIdRaw);
    if (channel && tabId) priorChannelByTab.set(tabId, norm(channel));
  }

  for (const [tabIdRaw] of Object.entries(tabState.ownedTabs)) {
    const tabId = Number(tabIdRaw);
    if (!tabId) continue;

    try {
      const tab = await chrome.tabs.get(tabId);
      const rawUrl = tab.url || tab.pendingUrl || "";
      const actual = chanFromUrl(rawUrl);
      const prior = priorChannelByTab.get(tabId) || "";

      if (!actual) continue;

      nextOwned[String(tabId)] = true;

      if (isRaidLikeUrl(rawUrl)) {
        // Keep the original mapping until the owned raid tab is closed.
        if (prior) nextChannels[prior] = tabId;
        makeTabBackgroundSafe(tabId).catch(() => {});
        continue;
      }

      nextChannels[prior || actual] = tabId;
      makeTabBackgroundSafe(tabId).catch(() => {});
    } catch {}
  }

  tabState.managedChannels = nextChannels;
  tabState.ownedTabs = nextOwned;
  await saveManagedState();
}

export function isManaged(tabOrId) {
  const tabId = typeof tabOrId === "number" ? tabOrId : Number(tabOrId?.id);
  if (!tabId) return false;
  return !!tabState.ownedTabs[String(tabId)];
}

export async function findExistingChannelTab(channel) {
  const ch = norm(channel);
  if (!ch) return null;

  try {
    const tabs = await chrome.tabs.query({
      url: ["*://www.twitch.tv/*", "*://twitch.tv/*"]
    });

    for (const tab of tabs) {
      const rawUrl = tab.url || tab.pendingUrl || "";
      if (isRaidLikeUrl(rawUrl)) continue;
      if (chanFromUrl(rawUrl) === ch) return tab;
    }
  } catch {}

  return null;
}

export async function findPreferredTwitchWindow() {
  try {
    const tabs = await chrome.tabs.query({
      url: ["*://www.twitch.tv/*", "*://twitch.tv/*"]
    });
    if (!tabs.length) return null;

    const byWindow = new Map();
    for (const tab of tabs) {
      if (!tab.windowId || tab.windowId < 0) continue;
      const entry = byWindow.get(tab.windowId) || { count: 0, lastIndex: -1 };
      entry.count += 1;
      entry.lastIndex = Math.max(entry.lastIndex, Number(tab.index || 0));
      byWindow.set(tab.windowId, entry);
    }

    let best = null;
    for (const [windowId, info] of byWindow.entries()) {
      if (!best || info.count > best.count) {
        best = { windowId, lastIndex: info.lastIndex, count: info.count };
      }
    }
    return best;
  } catch {
    return null;
  }
}


export async function scanDesiredChannelOwnership(desiredList) {
  const desired = new Set((desiredList || []).map(norm).filter(Boolean));
  const managed = new Set();
  const external = new Set();
  const all = new Set();
  if (!desired.size) return { managed, external, all };

  try {
    const tabs = await chrome.tabs.query({
      url: ["*://www.twitch.tv/*", "*://twitch.tv/*"]
    });

    for (const tab of tabs) {
      const rawUrl = tab.url || tab.pendingUrl || "";
      if (isRaidLikeUrl(rawUrl)) continue;
      const ch = chanFromUrl(rawUrl);
      if (!ch || !desired.has(ch)) continue;
      all.add(ch);
      if (isManaged(tab.id)) managed.add(ch);
      else external.add(ch);
    }
  } catch {}

  return { managed, external, all };
}

export async function scanOpenDesiredChannels(desiredList) {
  const desired = new Set((desiredList || []).map(norm));
  const out = new Set();
  if (!desired.size) return out;

  try {
    const tabs = await chrome.tabs.query({
      url: ["*://www.twitch.tv/*", "*://twitch.tv/*"]
    });

    for (const tab of tabs) {
      const rawUrl = tab.url || tab.pendingUrl || "";
      if (isRaidLikeUrl(rawUrl)) continue;
      const ch = chanFromUrl(rawUrl);
      if (ch && desired.has(ch)) out.add(ch);
    }
  } catch {}

  return out;
}
