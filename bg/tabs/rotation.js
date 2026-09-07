import { log } from "../core.js";
import { event } from "../events.js";
import { navigateBackgroundTab, closeBackgroundTab } from "../browser/tabs.js";
import { ensureManagerWindow, isManagerWindowId } from "../manager-window.js";
import { watchTab } from "../watchdog.js";
import {
  tabState,
  norm,
  loadManagedState,
  saveManagedState,
  getRotationSlot,
  setRotationSlot,
  makeTabBackgroundSafe,
  ensureBackgroundTabLoaded
} from "./core.js";
import { ensureOpen, releaseOwnedTab } from "./manage.js";
import { commitRotationAssignment } from "../rotation.js";

function mappedChannelForTab(tabId) {
  const id = Number(tabId || 0);
  for (const [channel, mappedId] of Object.entries(tabState.managedChannels || {})) {
    if (Number(mappedId) === id) return norm(channel);
  }
  return "";
}

async function validOwnedManagerTab(tabId) {
  const id = Number(tabId || 0);
  if (!id || !tabState.ownedTabs[String(id)]) return null;
  try {
    const tab = await chrome.tabs.get(id);
    if (!isManagerWindowId(tab.windowId)) return null;
    return tab;
  } catch {
    return null;
  }
}

async function findReusableTab(assignment, candidateSet, usedTabs) {
  const requestedId = Number(assignment?.tabId || 0);
  if (requestedId && !usedTabs.has(requestedId)) {
    const tab = await validOwnedManagerTab(requestedId);
    if (tab) return tab;
  }

  // Recover a slot binding from the tab-side rotation metadata if the scheduler
  // state was lost/reloaded independently.
  for (const [tabIdRaw, slot] of Object.entries(tabState.rotationSlots || {})) {
    const tabId = Number(tabIdRaw);
    const slotIndex = Number(slot?.slot_index ?? slot?.slotIndex ?? -1);
    if (slotIndex !== Number(assignment?.slotIndex) || usedTabs.has(tabId)) continue;
    const tab = await validOwnedManagerTab(tabId);
    if (tab) return tab;
  }

  // First Phase-D run can inherit a static Phase-C rotation/low-priority tab.
  // Prefer a tab already on the selected target, then any live rotation
  // candidate. That lets the slot become reusable without creating a new tab.
  const target = norm(assignment?.channel);
  let fallback = null;
  for (const [channel, tabIdRaw] of Object.entries(tabState.managedChannels || {})) {
    const tabId = Number(tabIdRaw);
    if (!tabId || usedTabs.has(tabId) || !candidateSet.has(norm(channel))) continue;
    const tab = await validOwnedManagerTab(tabId);
    if (!tab) continue;
    if (norm(channel) === target) return tab;
    if (!fallback) fallback = tab;
  }
  return fallback;
}

async function remapOwnedTab(tabId, nextChannel) {
  const id = Number(tabId || 0);
  const target = norm(nextChannel);
  if (!id || !target) return "";

  let previous = "";
  for (const [channel, mappedId] of Object.entries(tabState.managedChannels || {})) {
    if (Number(mappedId) !== id) continue;
    previous = norm(channel);
    delete tabState.managedChannels[channel];
  }

  tabState.ownedTabs[String(id)] = true;
  tabState.managedChannels[target] = id;
  await saveManagedState();
  return previous;
}

async function bindRotationTab(tabId, assignment, candidates, previousChannel = "") {
  const id = Number(tabId || 0);
  const channel = norm(assignment?.channel);
  if (!id || !channel) return null;

  await makeTabBackgroundSafe(id);
  await setRotationSlot(id, {
    role: "rotation",
    slot_index: Number(assignment.slotIndex || 0),
    current_channel: channel,
    last_rotated_at: assignment.changed ? Date.now() : Number(getRotationSlot(id)?.last_rotated_at || 0),
    recently_used: getRotationSlot(id)?.recently_used || {}
  });
  await watchTab(id, channel, {
    role: "rotation",
    reason: `rotation_slot_${Number(assignment.slotIndex || 0)}`
  });
  await commitRotationAssignment(assignment.slotIndex, {
    channel,
    tabId: id,
    previousChannel,
    candidates
  });
  return id;
}

async function createFreshRotationTab(assignment, candidates) {
  const channel = norm(assignment?.channel);
  if (!channel) return null;

  const tabId = await ensureOpen(channel, `rotation_slot_${Number(assignment.slotIndex || 0)}`);
  if (!tabId) return null;
  await bindRotationTab(tabId, assignment, candidates, assignment.previousChannel || "");
  await event("ROTATION_SLOT_CREATED", {
    slotIndex: Number(assignment.slotIndex || 0),
    channel,
    tabId
  });
  return tabId;
}

export async function ensureRotationAssignment(assignment, candidates = [], usedTabs = new Set()) {
  await loadManagedState();
  await ensureManagerWindow();

  const channel = norm(assignment?.channel);
  if (!channel) return null;
  const candidateSet = new Set((candidates || []).map(norm).filter(Boolean));
  let tab = await findReusableTab(assignment, candidateSet, usedTabs);

  if (!tab?.id) return await createFreshRotationTab(assignment, candidates);

  const tabId = Number(tab.id);
  const mappedBefore = mappedChannelForTab(tabId) || norm(assignment.previousChannel) || norm(getRotationSlot(tabId)?.current_channel);

  if (mappedBefore !== channel) {
    try {
      await navigateBackgroundTab(tabId, `https://www.twitch.tv/${channel}`);
      const previous = await remapOwnedTab(tabId, channel);
      await bindRotationTab(tabId, assignment, candidates, previous || mappedBefore);
      ensureBackgroundTabLoaded(tabId, channel).catch(() => {});
      await event("ROTATION_SLOT_SWITCH", {
        slotIndex: Number(assignment.slotIndex || 0),
        tabId,
        previousChannel: previous || mappedBefore,
        channel,
        reason: assignment.reason || "interval"
      });
      log("rotation_slot_switch", {
        slot: Number(assignment.slotIndex || 0),
        tabId,
        from: previous || mappedBefore,
        to: channel,
        reason: assignment.reason || "interval"
      });
      return tabId;
    } catch (e) {
      // Navigation failures are rare, but a broken reusable slot should not
      // prevent rotation forever. Recreate only this slot; normal watchdog
      // recovery remains non-destructive.
      await event("ROTATION_SLOT_NAVIGATION_FAILED", {
        slotIndex: Number(assignment.slotIndex || 0),
        tabId,
        previousChannel: mappedBefore,
        channel,
        error: String(e)
      });
      await closeBackgroundTab(tabId, "rotation_navigation_failed_recreate");
      await releaseOwnedTab(tabId, "rotation_navigation_failed_recreate");
      return await createFreshRotationTab(assignment, candidates);
    }
  }

  await remapOwnedTab(tabId, channel);
  await bindRotationTab(tabId, assignment, candidates, mappedBefore);
  ensureBackgroundTabLoaded(tabId, channel).catch(() => {});
  await event("ROTATION_SLOT_REUSED", {
    slotIndex: Number(assignment.slotIndex || 0),
    tabId,
    channel,
    reason: assignment.reason || "keep"
  });
  return tabId;
}

export async function reconcileRotationAssignments(rotationPlan) {
  if (!rotationPlan?.enabled) return { tabIds: [], channels: [] };
  await loadManagedState();

  const usedTabs = new Set();
  const channels = [];
  const tabIds = [];

  for (const assignment of rotationPlan.assignments || []) {
    try {
      const tabId = await ensureRotationAssignment(assignment, rotationPlan.candidates || [], usedTabs);
      if (!tabId) continue;
      usedTabs.add(Number(tabId));
      tabIds.push(Number(tabId));
      channels.push(norm(assignment.channel));
    } catch (e) {
      log("rotation_assignment_error", {
        slot: Number(assignment?.slotIndex || 0),
        channel: norm(assignment?.channel),
        error: String(e)
      });
      await event("ROTATION_SLOT_ERROR", {
        slotIndex: Number(assignment?.slotIndex || 0),
        channel: norm(assignment?.channel),
        error: String(e)
      });
    }
  }

  return { tabIds, channels };
}
