import { log } from "../core.js";
import { event } from "../events.js";
import {
  tabState,
  opening,
  OPENING_TTL_MS,
  now,
  norm,
  purgeOpening,
  loadManagedState,
  saveManagedState,
  clearRotationSlot,
  rehydrateManagedFromReality,
  findExistingChannelTab,
  makeTabBackgroundSafe,
  ensureBackgroundTabLoaded
} from "./core.js";
import { createBackgroundTab, closeBackgroundTab } from "../browser/tabs.js";
import { ensureManagerWindow, isManagerWindowId, getManagerWindowInfo } from "../manager-window.js";
import { watchTab } from "../watchdog.js";
import { unregisterTab } from "../registry.js";

export async function noteManaged(channel, tabId, via = "manager") {
  const ch = norm(channel);
  if (!ch || !tabId) return;

  tabState.ownedTabs[String(tabId)] = true;
  tabState.managedChannels[ch] = tabId;
  await saveManagedState();
  await makeTabBackgroundSafe(tabId);

  if (globalThis.TTM_STAB?.setTab) globalThis.TTM_STAB.setTab(ch, tabId, via);
  if (globalThis.TTM_STAB?.markAction) globalThis.TTM_STAB.markAction(ch);
  if (globalThis.TTM?.scheduleTabRepokes) globalThis.TTM.scheduleTabRepokes(tabId);
  if (globalThis.TTM?.noteManagedOpen) globalThis.TTM.noteManagedOpen(ch);
}

export async function unnoteManaged(channel, tabId) {
  const ch = norm(channel);
  if (ch) delete tabState.managedChannels[ch];
  if (tabId) delete tabState.ownedTabs[String(tabId)];
  await saveManagedState();
}

export async function adoptOpenTabs(allowedChannels = []) {
  // v1.0.13.3: managed streams belong in the dedicated TTM window only.
  // Legacy TTM-owned tabs in the user's normal window are either released
  // (when active) or closed (when inactive) so they cannot steal focus later.
  await loadManagedState();

  const existingOwned = Object.keys(tabState.managedChannels || {}).length;
  let manager = null;
  if (existingOwned) {
    try { manager = await ensureManagerWindow(); } catch (e) {
      log("manager_window_boot_error", { error: String(e) });
    }
  }

  let migratedClosed = 0;
  let migratedReleased = 0;

  if (manager?.windowId) {
    const entries = Object.entries({ ...(tabState.managedChannels || {}) });
    for (const [channel, tabIdRaw] of entries) {
      const tabId = Number(tabIdRaw);
      if (!tabId) continue;
      let tab;
      try { tab = await chrome.tabs.get(tabId); } catch { continue; }
      if (isManagerWindowId(tab.windowId)) continue;

      if (tab.active) {
        await releaseOwnedTab(tabId, "legacy_active_tab_released_to_user");
        await event("LEGACY_MANAGED_TAB_RELEASED", {
          tabId,
          channel,
          windowId: tab.windowId,
          active: true
        });
        migratedReleased += 1;
      } else {
        await closeBackgroundTab(tabId, "move_to_dedicated_manager_window");
        await releaseOwnedTab(tabId, "move_to_dedicated_manager_window");
        await event("LEGACY_MANAGED_TAB_CLOSED", {
          tabId,
          channel,
          windowId: tab.windowId,
          active: false
        });
        migratedClosed += 1;
      }
    }
  }

  await rehydrateManagedFromReality();

  const allowed = new Set((allowedChannels || []).map(norm).filter(Boolean));
  let restored = 0;

  for (const [channel, tabId] of Object.entries(tabState.managedChannels)) {
    if (!tabId) continue;
    if (allowed.size && !allowed.has(channel)) continue;
    try {
      const tab = await chrome.tabs.get(tabId);
      if (manager?.windowId && !isManagerWindowId(tab.windowId)) continue;
      await makeTabBackgroundSafe(tabId);
      await watchTab(tabId, channel, { role: "restored_owned", reason: "boot_restored_owned" });
      ensureBackgroundTabLoaded(tabId, channel).catch(() => {});
      restored += 1;
    } catch {}
  }

  const managerInfo = await getManagerWindowInfo().catch(() => null);
  log("restore_owned_tabs", {
    restored,
    migratedClosed,
    migratedReleased,
    managed_total: Object.keys(tabState.managedChannels).length,
    arbitrary_adoption: false,
    manager_window: managerInfo
  });

  return {
    adopted: 0,
    restored,
    migratedClosed,
    migratedReleased,
    total: Object.keys(tabState.managedChannels).length
  };
}

export async function ensureOpen(channel, via = "manager") {
  const ch = norm(channel);
  if (!ch) return null;

  purgeOpening();
  log("ensure_open_start", { ch, via });

  if (tabState.managedChannels[ch]) {
    try {
      const tabId = tabState.managedChannels[ch];
      await chrome.tabs.get(tabId);
      await makeTabBackgroundSafe(tabId);
      await watchTab(tabId, ch, { role: "stable", reason: via });
      ensureBackgroundTabLoaded(tabId, ch).catch(() => {});
      return tabId;
    } catch {
      delete tabState.managedChannels[ch];
      await saveManagedState();
    }
  }

  const existing = await findExistingChannelTab(ch);
  if (existing?.id) {
    if (tabState.ownedTabs[String(existing.id)]) {
      await noteManaged(ch, existing.id, `${via}:restore_owned_existing`);
      await watchTab(existing.id, ch, { role: "restored_owned", reason: via });
      ensureBackgroundTabLoaded(existing.id, ch).catch(() => {});
      return existing.id;
    }

    // The channel is already open in a user-controlled tab. Do not adopt,
    // reload, close, mute, or otherwise manage it.
    log("ensure_open_satisfied_by_external_tab", { ch, tabId: existing.id, via });
    return null;
  }

  if (opening.has(ch)) {
    log("ensure_open_skip_opening", { ch });
    return null;
  }

  opening.set(ch, now() + OPENING_TTL_MS);

  try {
    const managerWindow = await ensureManagerWindow();
    const createOptions = {
      windowId: managerWindow.windowId
    };

    log("ensure_open_before_create", {
      ch,
      windowId: createOptions.windowId,
      dedicatedManagerWindow: true,
      active: false
    });

    const tab = await createBackgroundTab(`https://www.twitch.tv/${ch}`, createOptions);
    if (!tab?.id) throw new Error("tab_create_returned_no_id");

    await makeTabBackgroundSafe(tab.id);
    await noteManaged(ch, tab.id, via);
    await watchTab(tab.id, ch, { role: "stable", reason: via });

    ensureBackgroundTabLoaded(tab.id, ch).catch((e) => {
      log("ensure_open_background_load_error", { ch, tabId: tab.id, error: String(e) });
    });

    log("ensure_open_created", { ch, tabId: tab.id, active: false });
    return tab.id;
  } catch (e) {
    log("ensure_open_error", { ch, error: String(e) });
    throw e;
  } finally {
    opening.delete(ch);
  }
}


export async function releaseOwnedTab(tabId, reason = "release") {
  const id = Number(tabId);
  if (!id) return [];
  await loadManagedState();

  const channels = [];
  for (const [channel, mappedId] of Object.entries(tabState.managedChannels || {})) {
    if (Number(mappedId) !== id) continue;
    channels.push(channel);
    delete tabState.managedChannels[channel];
  }

  delete tabState.ownedTabs[String(id)];
  delete tabState.rotationSlots[String(id)];
  await saveManagedState();
  try { await globalThis.TTM?.releaseRotationTab?.(id, reason); } catch {}
  await unregisterTab(id);
  log("managed_tab_released", { tabId: id, channels, reason });
  return channels;
}

export async function ensureClosed(channel, reason = "reconcile_not_live") {
  const ch = norm(channel);
  const tabId = tabState.managedChannels[ch];
  if (!tabId) return false;

  const isOwnedTab = !!tabState.ownedTabs[String(tabId)];
  if (!isOwnedTab) return false;

  // Never close the tab the user is currently using. If it is no longer part
  // of the plan, the next poll will close it after the user leaves it.
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab?.active) {
      const managerInfo = await getManagerWindowInfo().catch(() => null);
      const internalManagerSelection =
        managerInfo?.exists &&
        Number(tab.windowId) === Number(managerInfo.windowId) &&
        !managerInfo.focused;

      if (!internalManagerSelection) {
        log("managed_close_suppressed_active_tab", { channel: ch, tabId, reason });
        await event("CLOSE_SUPPRESSED_ACTIVE_TAB", { channel: ch, tabId, reason });
        return false;
      }
    }
  } catch {}

  await closeBackgroundTab(tabId, reason);
  await releaseOwnedTab(tabId, reason);
  log("managed_tab_closed", { channel: ch, tabId, reason });
  return true;
}

export async function listManaged() {
  await loadManagedState();
  await rehydrateManagedFromReality();
  return Object.keys(tabState.managedChannels).sort();
}

export async function listOpenTabs() {
  try {
    return await chrome.tabs.query({
      url: ["*://www.twitch.tv/*", "*://twitch.tv/*"]
    });
  } catch {
    return [];
  }
}
