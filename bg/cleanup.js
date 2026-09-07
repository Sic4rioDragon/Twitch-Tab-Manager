import { state, log } from "./core.js";
import { normalizeName, uniqNames, pruneTempWhitelistEntries, writeConfigMirrorsVerified } from "./config.js";
import { listManaged, ensureClosed, releaseOwnedTab } from "./tabs.js";
import {
  getManagerWindowInfo,
  isManagerWindowUnfocused,
  settleManagerWindowOnHolder
} from "./manager-window.js";

const T = (globalThis.TTM = globalThis.TTM || {});

const OPEN_GRACE_MS = 20000;
const REOPEN_COOLDOWN_MS = 90000;
const RAID_CLOSE_DELAY_MS = 60000;
const RAID_REOPEN_COOLDOWN_MS = 5 * 60 * 1000;
const OFFLINE_CLOSE_DELAY_MS = 20000;
const ORPHAN_OFFLINE_CLOSE_DELAY_MS = 90_000;

const openedAtByChannel = new Map();
const reopenBlockedUntilByChannel = new Map();
const raidTimers = new Map();
const raidTabTimers = new Map();
const offlineTimers = new Map();
const offlinePendingSinceByChannel = new Map();
const orphanOfflineSeenAtByTabId = new Map();

function getTempWhitelistEntries() {
  const pruned = pruneTempWhitelistEntries(state.settings);
  state.settings.temp_whitelist_entries = pruned;
  return pruned;
}

function isConfiguredAnywhere(login) {
  const key = normalizeName(login);
  if (!key) return false;
  return ["favorites", "priority", "follows", "rotation", "low_priority", "blacklist"]
    .some((bucket) => Array.isArray(state.settings[bucket]) && state.settings[bucket].includes(key));
}

function isTemporarilyAllowed(login) {
  const key = normalizeName(login);
  if (!key || isConfiguredAnywhere(key)) return false;
  const entries = getTempWhitelistEntries();
  const expiresAt = Number(entries[key] || 0);
  return !!expiresAt && Date.now() < expiresAt;
}

async function tempAllowChannel(login) {
  const key = normalizeName(login);
  if (!key) return false;

  if (isConfiguredAnywhere(key)) {
    const entries = getTempWhitelistEntries();
    if (entries[key]) delete entries[key];
    state.settings.temp_whitelist_entries = entries;
    try { await writeConfigMirrorsVerified(state.settings); } catch {}
    log("temp_whitelist_skip_configured", { login: key });
    return false;
  }

  const hours = Math.max(1, Number(state.settings.temp_whitelist_hours || 12) || 12);
  const entries = getTempWhitelistEntries();
  entries[key] = Date.now() + (hours * 60 * 60 * 1000);
  state.settings.temp_whitelist_entries = entries;

  await writeConfigMirrorsVerified(state.settings);
  log("temp_whitelist_added", { login: key, hours });
  return true;
}

function isRaidLikeUrl(url = "") {
  const value = String(url || "").toLowerCase();
  return value.includes("referrer=raid");
}

function channelFromTwitchUrl(url = "") {
  try {
    const parsed = new URL(String(url || ""));
    if (!/^(www\.)?twitch\.tv$/i.test(parsed.hostname)) return "";
    const first = parsed.pathname.replace(/^\/+/, "").split("/")[0] || "";
    const key = normalizeName(first);
    if (!key) return "";
    if ([
      "directory", "downloads", "jobs", "p", "settings", "subscriptions",
      "inventory", "wallet", "videos", "schedule", "about"
    ].includes(key)) return "";
    return key;
  } catch {
    return "";
  }
}

function isManagerEnabled() {
  return state.settings.enabled !== false;
}

function noteManagedOpen(login) {
  const key = normalizeName(login);
  if (!key) return;

  openedAtByChannel.set(key, Date.now());
  reopenBlockedUntilByChannel.delete(key);
  clearRaidTimer(key);
  clearOfflineTimer(key);
}

function noteManagedClosed(login, cooldownMs = REOPEN_COOLDOWN_MS) {
  const key = normalizeName(login);
  if (!key) return;

  reopenBlockedUntilByChannel.set(key, Date.now() + cooldownMs);
  openedAtByChannel.delete(key);
  clearRaidTimer(key);
  clearOfflineTimer(key);
}

function clearRaidTimer(login) {
  const key = normalizeName(login);
  const timer = raidTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    raidTimers.delete(key);
  }
}

function clearOfflineTimer(login) {
  const key = normalizeName(login);
  const timer = offlineTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    offlineTimers.delete(key);
  }
  offlinePendingSinceByChannel.delete(key);
}

function isInOpenGrace(login) {
  const key = normalizeName(login);
  const openedAt = openedAtByChannel.get(key);
  if (!openedAt) return false;
  return Date.now() - openedAt < OPEN_GRACE_MS;
}

function isReopenBlocked(login) {
  const key = normalizeName(login);
  const until = reopenBlockedUntilByChannel.get(key) || 0;
  return until > Date.now();
}

async function closeManagedChannelTab(login, reason = "manual", cooldownMs = REOPEN_COOLDOWN_MS) {
  const key = normalizeName(login);
  if (!key) return false;

  const managedChannels = await listManaged();
  if (!managedChannels.includes(key)) {
    return false;
  }

  try {
    const closed = await ensureClosed(key, reason);
    if (closed) {
      noteManagedClosed(key, cooldownMs);
      log("closed_channel_tab", { login: key, reason, cooldownMs });
      return true;
    }
  } catch (e) {
    log("close_channel_tab_error", { login: key, reason, error: String(e) });
  }

  return false;
}

function scheduleOfflineClose(login) {
  if (!isManagerEnabled()) return;

  const key = normalizeName(login);
  if (!key) return;

  if (raidTimers.has(key)) {
    log("offline_close_skipped_raid_pending", { login: key });
    return;
  }

  if (isInOpenGrace(key)) {
    log("offline_ignored_in_open_grace", { login: key, graceMs: OPEN_GRACE_MS });
    return;
  }

  if (Array.isArray(state.lastLive) && state.lastLive.includes(key)) {
    log("offline_ignored_still_in_last_live", { login: key });
    return;
  }

  if (offlineTimers.has(key)) {
    return;
  }

  offlinePendingSinceByChannel.set(key, Date.now());

  const timer = setTimeout(async () => {
    offlineTimers.delete(key);

    const pendingSince = offlinePendingSinceByChannel.get(key) || Date.now();
    offlinePendingSinceByChannel.delete(key);

    if (raidTimers.has(key)) {
      log("offline_close_cancelled_raid_pending", { login: key });
      return;
    }

    if (isInOpenGrace(key)) {
      log("offline_close_cancelled_open_grace", { login: key });
      return;
    }

    if (Array.isArray(state.lastLive) && state.lastLive.includes(key)) {
      log("offline_close_cancelled_still_in_last_live", {
        login: key,
        pendingMs: Date.now() - pendingSince
      });
      return;
    }

    const closed = await closeManagedChannelTab(key, "offline", REOPEN_COOLDOWN_MS);
    log("offline_close_fired", {
      login: key,
      delayMs: OFFLINE_CLOSE_DELAY_MS,
      pendingMs: Date.now() - pendingSince,
      closed
    });
  }, OFFLINE_CLOSE_DELAY_MS);

  offlineTimers.set(key, timer);
  log("offline_close_scheduled", { login: key, delayMs: OFFLINE_CLOSE_DELAY_MS });
}

function scheduleRaidClose(login) {
  if (!isManagerEnabled()) return;

  const key = normalizeName(login);
  if (!key) return;

  clearRaidTimer(key);

  const timer = setTimeout(async () => {
    raidTimers.delete(key);
    await closeManagedChannelTab(key, "raid", RAID_REOPEN_COOLDOWN_MS);
    log("raid_close_fired", { login: key, delayMs: RAID_CLOSE_DELAY_MS });
  }, RAID_CLOSE_DELAY_MS);

  raidTimers.set(key, timer);
  log("raid_close_scheduled", { login: key, delayMs: RAID_CLOSE_DELAY_MS });
}

async function closeManagedChannelsThatAreNowBlocked() {
  if (!isManagerEnabled()) return;

  const managedChannels = await listManaged();
  if (!managedChannels.length) return;

  const allowed = new Set(uniqNames(state.settings.followUnion || []));
  const blacklist = new Set(uniqNames(state.settings.blacklist || []));

  for (const login of managedChannels) {
    const key = normalizeName(login);
    if (!key) continue;
    if (isTemporarilyAllowed(key)) continue;

    if (blacklist.has(key)) {
      await closeManagedChannelTab(key, "blacklist", RAID_REOPEN_COOLDOWN_MS);
      continue;
    }

    if (state.settings.close_unfollowed_tabs !== false && !allowed.has(key)) {
      await closeManagedChannelTab(key, "not_followed_or_priority", RAID_REOPEN_COOLDOWN_MS);
    }
  }
}


async function closeOwnedRaidTab(tabId, reason = "owned_raid_redirect") {
  const id = Number(tabId);
  if (!id || !T.isManaged?.(id)) return false;

  let tab;
  try { tab = await chrome.tabs.get(id); } catch { return false; }
  const url = tab?.url || tab?.pendingUrl || "";
  if (!isRaidLikeUrl(url)) return false;

  if (tab?.active && !(await isManagerWindowUnfocused(tab.windowId))) {
    log("raid_tab_close_suppressed_active", { tabId: id, url, reason });
    return false;
  }

  try {
    await chrome.tabs.remove(id);
    await releaseOwnedTab(id, reason);
    log("owned_raid_tab_closed", { tabId: id, url, reason });
    return true;
  } catch (e) {
    log("owned_raid_tab_close_error", { tabId: id, url, reason, error: String(e) });
    return false;
  }
}

function clearOwnedRaidTabTimer(tabId) {
  const id = Number(tabId);
  const timer = raidTabTimers.get(id);
  if (timer) clearTimeout(timer);
  raidTabTimers.delete(id);
}

function scheduleOwnedRaidTabClose(tabId, delayMs = 30000) {
  const id = Number(tabId);
  if (!id || !isManagerEnabled()) return;
  clearOwnedRaidTabTimer(id);

  const timer = setTimeout(async () => {
    raidTabTimers.delete(id);
    const closed = await closeOwnedRaidTab(id, "raid_redirect_timer");
    if (!closed) {
      // If the user was looking at the raid tab, do not fight their selection.
      // Try again later after they have moved away.
      try {
        const tab = await chrome.tabs.get(id);
        if (tab?.active && isRaidLikeUrl(tab?.url || tab?.pendingUrl || "")) {
          scheduleOwnedRaidTabClose(id, 30000);
        }
      } catch {}
    }
  }, Math.max(5000, Number(delayMs || 30000)));

  raidTabTimers.set(id, timer);
  log("owned_raid_tab_close_scheduled", { tabId: id, delayMs: Math.max(5000, Number(delayMs || 30000)) });
}

async function closeManagerWindowOrphanRaidTab(tabId, reason = "manager_orphan_raid") {
  const id = Number(tabId || 0);
  if (!id || T.isManaged?.(id)) return false;

  const managerInfo = await getManagerWindowInfo().catch(() => null);
  if (!managerInfo?.exists) return false;

  let tab;
  try { tab = await chrome.tabs.get(id); } catch { return false; }
  const url = tab?.url || tab?.pendingUrl || "";
  if (Number(tab?.windowId) !== Number(managerInfo.windowId)) return false;
  if (!isRaidLikeUrl(url)) return false;

  // The dedicated playback window is entirely TTM-owned space. Unlike normal
  // user windows, an unmanaged raid redirect here is always safe to remove.
  // Put manager.html back on top first so closing an internally-active raid
  // never leaves another random Twitch tab selected.
  if (tab.active) {
    await settleManagerWindowOnHolder("orphan_raid_cleanup").catch(() => false);
  }

  try {
    await chrome.tabs.remove(id);
    log("manager_orphan_raid_closed", {
      tabId: id,
      windowId: managerInfo.windowId,
      url,
      reason
    });
    return true;
  } catch (e) {
    log("manager_orphan_raid_close_error", {
      tabId: id,
      windowId: managerInfo.windowId,
      url,
      reason,
      error: String(e)
    });
    return false;
  }
}

async function cleanupManagerWindowOrphanRaidTabs(reason = "manager_raid_sweep") {
  if (!isManagerEnabled()) return { cleaned: 0, skipped: "disabled" };

  const managerInfo = await getManagerWindowInfo().catch(() => null);
  if (!managerInfo?.exists) return { cleaned: 0, skipped: "no_manager_window" };

  try {
    const tabs = await chrome.tabs.query({ windowId: Number(managerInfo.windowId) });
    const candidates = tabs.filter((tab) => {
      const url = tab?.url || tab?.pendingUrl || "";
      return !!tab?.id && !T.isManaged?.(tab.id) && isRaidLikeUrl(url);
    });

    if (!candidates.length) return { candidates: 0, cleaned: 0 };

    if (candidates.some((tab) => tab.active)) {
      await settleManagerWindowOnHolder("orphan_raid_sweep").catch(() => false);
    }

    let cleaned = 0;
    for (const tab of candidates.slice(0, 25)) {
      if (await closeManagerWindowOrphanRaidTab(tab.id, reason)) cleaned += 1;
    }

    log("manager_orphan_raid_cleanup", {
      windowId: managerInfo.windowId,
      candidates: candidates.length,
      cleaned,
      reason
    });
    return { candidates: candidates.length, cleaned };
  } catch (e) {
    log("manager_orphan_raid_cleanup_error", { reason, error: String(e) });
    return { cleaned: 0, error: String(e) };
  }
}

async function cleanupManagerWindowOrphanOfflineTabs({
  offline = [],
  unknown = [],
  live = []
} = {}, reason = "manager_orphan_offline_sweep") {
  if (!isManagerEnabled()) return { cleaned: 0, skipped: "disabled" };

  const managerInfo = await getManagerWindowInfo().catch(() => null);
  if (!managerInfo?.exists) return { cleaned: 0, skipped: "no_manager_window" };

  const offlineSet = new Set(uniqNames(offline));
  const unknownSet = new Set(uniqNames(unknown));
  const liveSet = new Set(uniqNames(live));
  const now = Date.now();

  try {
    const tabs = await chrome.tabs.query({ windowId: Number(managerInfo.windowId) });
    const seenIds = new Set(tabs.map((tab) => Number(tab?.id || 0)).filter(Boolean));

    for (const tabId of [...orphanOfflineSeenAtByTabId.keys()]) {
      if (!seenIds.has(Number(tabId))) orphanOfflineSeenAtByTabId.delete(Number(tabId));
    }

    let candidates = 0;
    let cleaned = 0;

    for (const tab of tabs) {
      const tabId = Number(tab?.id || 0);
      if (!tabId || T.isManaged?.(tabId)) {
        orphanOfflineSeenAtByTabId.delete(tabId);
        continue;
      }

      const url = tab?.url || tab?.pendingUrl || "";
      if (isRaidLikeUrl(url)) {
        orphanOfflineSeenAtByTabId.delete(tabId);
        continue;
      }

      const login = channelFromTwitchUrl(url);
      if (!login) {
        orphanOfflineSeenAtByTabId.delete(tabId);
        continue;
      }

      // Confirmed LIVE is the only result that clears an existing offline clock.
      // UNKNOWN preserves a clock that already started but cannot start/finish a
      // close by itself. This survives Twitch's OFFLINE -> UNKNOWN -> OFFLINE
      // probe wobble without treating UNKNOWN as proof that a stream ended.
      if (liveSet.has(login)) {
        orphanOfflineSeenAtByTabId.delete(tabId);
        continue;
      }
      if (unknownSet.has(login) || !offlineSet.has(login)) {
        continue;
      }

      candidates += 1;
      const firstSeen = Number(orphanOfflineSeenAtByTabId.get(tabId) || 0);
      if (!firstSeen) {
        orphanOfflineSeenAtByTabId.set(tabId, now);
        log("manager_orphan_offline_seen", {
          tabId,
          login,
          windowId: managerInfo.windowId,
          closeAfterMs: ORPHAN_OFFLINE_CLOSE_DELAY_MS,
          reason
        });
        continue;
      }

      if (now - firstSeen < ORPHAN_OFFLINE_CLOSE_DELAY_MS) continue;

      // If the user deliberately focused the playback window and selected this
      // tab, do not close it under their cursor. An internally-active tab in an
      // unfocused manager window is still manager-owned workspace and is safe.
      if (tab.active && managerInfo.focused) {
        log("manager_orphan_offline_close_suppressed_user_focused", {
          tabId,
          login,
          windowId: managerInfo.windowId,
          pendingMs: now - firstSeen,
          reason
        });
        continue;
      }

      try {
        await chrome.tabs.remove(tabId);
        orphanOfflineSeenAtByTabId.delete(tabId);
        cleaned += 1;
        noteManagedClosed(login, REOPEN_COOLDOWN_MS);
        log("manager_orphan_offline_closed", {
          tabId,
          login,
          windowId: managerInfo.windowId,
          pendingMs: now - firstSeen,
          reason
        });
      } catch (e) {
        log("manager_orphan_offline_close_error", {
          tabId,
          login,
          windowId: managerInfo.windowId,
          error: String(e),
          reason
        });
      }
    }

    if (candidates || cleaned) {
      log("manager_orphan_offline_cleanup", {
        windowId: managerInfo.windowId,
        candidates,
        cleaned,
        delayMs: ORPHAN_OFFLINE_CLOSE_DELAY_MS,
        reason
      });
    }

    return { candidates, cleaned };
  } catch (e) {
    log("manager_orphan_offline_cleanup_error", { reason, error: String(e) });
    return { cleaned: 0, error: String(e) };
  }
}

async function cleanupLegacyOrphanRaidTabs() {
  const FLAG = "ttm_v1013_orphan_raid_cleanup_done";
  try {
    const got = await chrome.storage.local.get(FLAG);
    if (got?.[FLAG]) return { cleaned: 0, skipped: "already_done" };

    const tabs = await chrome.tabs.query({
      url: ["*://www.twitch.tv/*", "*://twitch.tv/*"]
    });
    const candidates = tabs.filter((tab) => {
      const url = tab?.url || tab?.pendingUrl || "";
      return !!tab?.id && !tab.active && !T.isManaged?.(tab.id) && isRaidLikeUrl(url);
    });

    let cleaned = 0;
    // One stale raid URL may be a legitimate user tab. Multiple inactive raid
    // URLs are the v1.0.12 ownership-leak signature, so only auto-clean then.
    if (candidates.length >= 2) {
      for (const tab of candidates.slice(0, 25)) {
        try {
          await chrome.tabs.remove(tab.id);
          cleaned += 1;
          log("legacy_orphan_raid_closed", { tabId: tab.id, url: tab.url || tab.pendingUrl || "" });
        } catch {}
      }
    }

    await chrome.storage.local.set({ [FLAG]: true });
    log("legacy_orphan_raid_cleanup", { candidates: candidates.length, cleaned });
    return { candidates: candidates.length, cleaned };
  } catch (e) {
    log("legacy_orphan_raid_cleanup_error", String(e));
    return { cleaned: 0, error: String(e) };
  }
}

async function closeSenderTabIfNowUnwanted(sender, reason = "drifted_unwanted") {
  if (!isManagerEnabled()) return false;

  const tabId = sender?.tab?.id;
  const currentUrl = sender?.tab?.url || sender?.tab?.pendingUrl || "";
  const currentLogin = T.channelFromUrl(currentUrl);
  if (!tabId || !currentLogin) return false;

  if (sender?.tab?.active && !(await isManagerWindowUnfocused(sender?.tab?.windowId))) {
    log("sender_close_suppressed_active_user_tab", { tabId, login: currentLogin, reason });
    return false;
  }

  if (isTemporarilyAllowed(currentLogin)) {
    return false;
  }

  const allowed = new Set(uniqNames(state.settings.followUnion || []));
  const blacklist = new Set(uniqNames(state.settings.blacklist || []));

  const isBlocked = blacklist.has(currentLogin);
  const isAllowed = allowed.has(currentLogin);
  const raidLike = isRaidLikeUrl(currentUrl);

  if (isBlocked) {
    try {
      await chrome.tabs.remove(tabId);
      if (T.isManaged?.(tabId)) await releaseOwnedTab(tabId, "blacklist");
      noteManagedClosed(currentLogin, RAID_REOPEN_COOLDOWN_MS);
      log("closed_sender_tab_now_unwanted", { tabId, login: currentLogin, reason: "blacklist" });
      return true;
    } catch (e) {
      log("close_sender_tab_now_unwanted_error", { tabId, login: currentLogin, reason: "blacklist", error: String(e) });
      return false;
    }
  }

  if (!isAllowed) {
    if (state.settings.close_unfollowed_tabs === false) return false;

    if (state.settings.allow_extra_twitch_tabs !== false && !raidLike) {
      log("kept_extra_twitch_tab_open", { tabId, login: currentLogin, reason });
      return false;
    }

    try {
      await chrome.tabs.remove(tabId);
      if (T.isManaged?.(tabId)) await releaseOwnedTab(tabId, reason);
      noteManagedClosed(currentLogin, RAID_REOPEN_COOLDOWN_MS);
      log("closed_sender_tab_now_unwanted", { tabId, login: currentLogin, reason });
      return true;
    } catch (e) {
      log("close_sender_tab_now_unwanted_error", { tabId, login: currentLogin, reason, error: String(e) });
      return false;
    }
  }

  return false;
}

T.OPEN_GRACE_MS = OPEN_GRACE_MS;
T.REOPEN_COOLDOWN_MS = REOPEN_COOLDOWN_MS;
T.RAID_CLOSE_DELAY_MS = RAID_CLOSE_DELAY_MS;
T.RAID_REOPEN_COOLDOWN_MS = RAID_REOPEN_COOLDOWN_MS;
T.OFFLINE_CLOSE_DELAY_MS = OFFLINE_CLOSE_DELAY_MS;

T.getTempWhitelistEntries = getTempWhitelistEntries;
T.isTemporarilyAllowed = isTemporarilyAllowed;
T.tempAllowChannel = tempAllowChannel;
T.isRaidLikeUrl = isRaidLikeUrl;
T.isManagerEnabled = isManagerEnabled;
T.noteManagedOpen = noteManagedOpen;
T.noteManagedClosed = noteManagedClosed;
T.clearRaidTimer = clearRaidTimer;
T.clearOfflineTimer = clearOfflineTimer;
T.isInOpenGrace = isInOpenGrace;
T.isReopenBlocked = isReopenBlocked;
T.closeManagedChannelTab = closeManagedChannelTab;
T.scheduleOfflineClose = scheduleOfflineClose;
T.scheduleRaidClose = scheduleRaidClose;
T.closeOwnedRaidTab = closeOwnedRaidTab;
T.scheduleOwnedRaidTabClose = scheduleOwnedRaidTabClose;
T.closeManagerWindowOrphanRaidTab = closeManagerWindowOrphanRaidTab;
T.cleanupManagerWindowOrphanRaidTabs = cleanupManagerWindowOrphanRaidTabs;
T.cleanupManagerWindowOrphanOfflineTabs = cleanupManagerWindowOrphanOfflineTabs;
T.cleanupLegacyOrphanRaidTabs = cleanupLegacyOrphanRaidTabs;
T.closeManagedChannelsThatAreNowBlocked = closeManagedChannelsThatAreNowBlocked;
T.closeSenderTabIfNowUnwanted = closeSenderTabIfNowUnwanted;

export {
  OPEN_GRACE_MS,
  REOPEN_COOLDOWN_MS,
  RAID_CLOSE_DELAY_MS,
  RAID_REOPEN_COOLDOWN_MS,
  OFFLINE_CLOSE_DELAY_MS,
  ORPHAN_OFFLINE_CLOSE_DELAY_MS,
  getTempWhitelistEntries,
  isTemporarilyAllowed,
  tempAllowChannel,
  isRaidLikeUrl,
  isManagerEnabled,
  noteManagedOpen,
  noteManagedClosed,
  clearRaidTimer,
  clearOfflineTimer,
  isInOpenGrace,
  isReopenBlocked,
  closeManagedChannelTab,
  scheduleOfflineClose,
  scheduleRaidClose,
  closeOwnedRaidTab,
  scheduleOwnedRaidTabClose,
  closeManagerWindowOrphanRaidTab,
  cleanupManagerWindowOrphanRaidTabs,
  cleanupManagerWindowOrphanOfflineTabs,
  cleanupLegacyOrphanRaidTabs,
  closeManagedChannelsThatAreNowBlocked,
  closeSenderTabIfNowUnwanted
};