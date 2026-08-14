import { log } from "./core.js";

const RE_CHAN = /^https?:\/\/(?:www\.)?twitch\.tv\/([a-z0-9_]+)(?:\/|$)/i;
const NON_CHANNEL_ROUTES = new Set([
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

const CHANNEL_KEY = "ttm.managed.channels";
const OWNED_KEY = "ttm.managed.owned";
const ROTATION_SLOTS_KEY = "ttm.rotation.slots";
const OPENING_TTL_MS = 5000;

let managedChannels = {};
let ownedTabs = {};
let rotationSlots = {};
const opening = new Map();

function now() {
  return Date.now();
}

function norm(value) {
  return String(value || "").trim().toLowerCase();
}

function isRaidLikeUrl(url) {
  return String(url || "").toLowerCase().includes("referrer=raid");
}

function chanFromUrl(url) {
  const match = String(url || "").match(RE_CHAN);
  if (!match) return null;

  const ch = norm(match[1]);
  if (!ch) return null;
  if (NON_CHANNEL_ROUTES.has(ch)) return null;

  return ch;
}

function purgeOpening() {
  const t = now();
  for (const [channel, expiresAt] of opening.entries()) {
    if (expiresAt <= t) opening.delete(channel);
  }
}

async function loadManagedState() {
  const bag = await chrome.storage.session.get([CHANNEL_KEY, OWNED_KEY, ROTATION_SLOTS_KEY]);

  managedChannels =
    bag?.[CHANNEL_KEY] && typeof bag[CHANNEL_KEY] === "object"
      ? bag[CHANNEL_KEY]
      : {};

  ownedTabs =
    bag?.[OWNED_KEY] && typeof bag[OWNED_KEY] === "object"
      ? bag[OWNED_KEY]
      : {};

  rotationSlots =
    bag?.[ROTATION_SLOTS_KEY] && typeof bag[ROTATION_SLOTS_KEY] === "object"
      ? bag[ROTATION_SLOTS_KEY]
      : {};
}

async function saveManagedState() {
  await chrome.storage.session.set({
    [CHANNEL_KEY]: managedChannels,
    [OWNED_KEY]: ownedTabs,
    [ROTATION_SLOTS_KEY]: rotationSlots
  });
}
function getRotationSlot(tabId) {
  return rotationSlots[String(tabId)] || null;
}

async function setRotationSlot(tabId, data) {
  if (!tabId) return;

  rotationSlots[String(tabId)] = {
    role: "rotation",
    current_channel: "",
    last_rotated_at: 0,
    recently_used: {},
    ...(rotationSlots[String(tabId)] || {}),
    ...(data || {})
  };

  await saveManagedState();
}

async function clearRotationSlot(tabId) {
  if (!tabId) return;
  delete rotationSlots[String(tabId)];
  await saveManagedState();
}

function wasRecentlyUsedInRotation(tabId, channel, cooldownMin = 30) {
  const slot = getRotationSlot(tabId);
  if (!slot) return false;

  const ts = Number(slot.recently_used?.[channel] || 0);
  if (!ts) return false;

  const cooldownMs = Math.max(5, Number(cooldownMin || 30)) * 60 * 1000;
  return (Date.now() - ts) < cooldownMs;
}

async function markRotationChannelUsed(tabId, channel) {
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

  rotationSlots[String(tabId)] = slot;
  await saveManagedState();
}

async function rehydrateManagedFromReality() {
  const nextChannels = {};
  const nextOwned = {};

  for (const [tabIdRaw] of Object.entries(ownedTabs)) {
    const tabId = Number(tabIdRaw);
    if (!tabId) continue;

    try {
      const tab = await chrome.tabs.get(tabId);
      const actual = chanFromUrl(tab.url || tab.pendingUrl || "");
      if (!actual) continue;
      if (isRaidLikeUrl(tab.url || tab.pendingUrl || "")) continue;

      nextOwned[String(tabId)] = true;
      nextChannels[actual] = tabId;
    } catch {}
  }

  managedChannels = nextChannels;
  ownedTabs = nextOwned;
  await saveManagedState();
}

function isManaged(tabOrId) {
  if (typeof tabOrId === "number") {
    return !!ownedTabs[String(tabOrId)];
  }

  const tabId = Number(tabOrId?.id);
  if (!tabId) return false;
  return !!ownedTabs[String(tabId)];
}

async function noteManaged(channel, tabId, via = "manager") {
  const ch = norm(channel);
  if (!ch || !tabId) return;

  ownedTabs[String(tabId)] = true;
  managedChannels[ch] = tabId;
  await saveManagedState();

  if (globalThis.TTM_STAB?.setTab) globalThis.TTM_STAB.setTab(ch, tabId, via);
  if (globalThis.TTM_STAB?.markAction) globalThis.TTM_STAB.markAction(ch);

  if (globalThis.TTM?.scheduleTabRepokes) {
    globalThis.TTM.scheduleTabRepokes(tabId);
  }

  if (globalThis.TTM?.noteManagedOpen) {
    globalThis.TTM.noteManagedOpen(ch);
  }
}

async function unnoteManaged(channel, tabId) {
  const ch = norm(channel);
  if (ch) delete managedChannels[ch];
  if (tabId) delete ownedTabs[String(tabId)];
  await saveManagedState();
}

async function findExistingChannelTab(channel) {
  const ch = norm(channel);
  if (!ch) return null;

  try {
    const tabs = await chrome.tabs.query({
      url: ["*://www.twitch.tv/*", "*://twitch.tv/*"]
    });

    for (const tab of tabs) {
      const rawUrl = tab.url || tab.pendingUrl || "";
      if (isRaidLikeUrl(rawUrl)) continue;

      const actual = chanFromUrl(rawUrl);
      if (actual === ch) return tab;
    }
  } catch {}

  return null;
}

async function findPreferredTwitchWindow() {
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

async function scanOpenDesiredChannels(desiredList) {
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

function buildPriorityMap(priority) {
  const map = new Map();
  (priority || []).map(norm).forEach((channel, index) => {
    if (!map.has(channel)) map.set(channel, index);
  });
  return map;
}

function getChannelRank(channel, priorityMap) {
  const ch = norm(channel);
  if (priorityMap.has(ch)) return priorityMap.get(ch);
  return 1000000;
}

function compareRank(a, b, priorityMap) {
  return getChannelRank(a, priorityMap) - getChannelRank(b, priorityMap);
}

async function closeWorstManagedFor(candidateChannel, openSet, priorityMap) {
  const candidateRank = getChannelRank(candidateChannel, priorityMap);

  const managedOpen = Array.from(openSet)
    .filter((channel) => managedChannels[channel])
    .sort((a, b) => compareRank(b, a, priorityMap));

  if (!managedOpen.length) return null;

  const worstOpen = managedOpen[0];
  const worstRank = getChannelRank(worstOpen, priorityMap);

  if (candidateRank >= worstRank) {
    return null;
  }

  await ensureClosed(worstOpen);
  return worstOpen;
}

export async function adoptOpenTabs(allowedChannels = []) {
  await loadManagedState();
  await rehydrateManagedFromReality();

  const allowed = new Set((allowedChannels || []).map(norm).filter(Boolean));
  if (!allowed.size) return { adopted: 0, total: 0 };

  let adopted = 0;

  try {
    const tabs = await chrome.tabs.query({
      url: ["*://www.twitch.tv/*", "*://twitch.tv/*"]
    });

    for (const tab of tabs) {
      const rawUrl = tab.url || tab.pendingUrl || "";
      if (isRaidLikeUrl(rawUrl)) continue;

      const ch = chanFromUrl(rawUrl);
      if (!ch) continue;
      if (!allowed.has(ch)) continue;
      if (!tab.id) continue;

      const existingTabId = managedChannels[ch];
      if (existingTabId === tab.id && ownedTabs[String(tab.id)]) {
        continue;
      }

      await noteManaged(ch, tab.id, "boot:adopted");
      adopted += 1;
    }

    await saveManagedState();
  } catch (e) {
    log("adopt_open_tabs_error", { error: String(e) });
  }

  return { adopted, total: Object.keys(managedChannels).length };
}

export async function ensureOpen(channel, via = "manager") {
  const ch = norm(channel);
  if (!ch) return null;

  purgeOpening();
  log("ensure_open_start", { ch, via });

  if (managedChannels[ch]) {
    try {
      await chrome.tabs.get(managedChannels[ch]);
      return managedChannels[ch];
    } catch {
      delete managedChannels[ch];
      await saveManagedState();
    }
  }

  const existing = await findExistingChannelTab(ch);
  if (existing?.id) {
    await noteManaged(ch, existing.id, `${via}:adopted_existing`);
    log("ensure_open_adopt_existing", { ch, tabId: existing.id, via });
    return existing.id;
  }

  if (opening.has(ch)) {
    log("ensure_open_skip_opening", { ch });
    return null;
  }

  opening.set(ch, now() + OPENING_TTL_MS);

  try {
    const preferredWindow = await findPreferredTwitchWindow();

    const createOptions = {
      url: `https://www.twitch.tv/${ch}`,
      active: false
    };

    if (preferredWindow?.windowId != null) {
      createOptions.windowId = preferredWindow.windowId;
      createOptions.index = preferredWindow.lastIndex + 1;
    }

    log("ensure_open_before_create", {
      ch,
      windowId: createOptions.windowId ?? null
    });

    const tab = await chrome.tabs.create(createOptions);

    await noteManaged(ch, tab.id, via);
    log("ensure_open_created", { ch, tabId: tab.id });

    return tab.id;
  } catch (e) {
    log("ensure_open_error", { ch, error: String(e) });
    throw e;
  } finally {
    opening.delete(ch);
  }
}

export async function ensureClosed(channel) {
  const ch = norm(channel);
  const tabId = managedChannels[ch];
  if (!tabId) return false;

  const isOwnedTab = !!ownedTabs[String(tabId)];
  if (!isOwnedTab) return false;

  try {
    await chrome.tabs.remove(tabId);
  } catch {}

  await unnoteManaged(ch, tabId);
  return true;
}

export async function reconcileTabs(live, cfg) {
  await loadManagedState();
  await rehydrateManagedFromReality();

  const maxTabs = Math.max(1, Number(cfg?.max_tabs || 4));
  const priority = (cfg?.priority || []).map(norm);
  const priorityMap = buildPriorityMap(priority);

  const seen = new Set();
  const desired = [];

  for (const ch of (live || []).map(norm)) {
    if (!ch) continue;
    if (!seen.has(ch)) {
      seen.add(ch);
      desired.push(ch);
    }
  }

  desired.sort((a, b) => {
    const byPriority = compareRank(a, b, priorityMap);
    if (byPriority !== 0) return byPriority;

    const aLive = globalThis.TTM_STAB?._get?.(a)?.lastLiveTs || 0;
    const bLive = globalThis.TTM_STAB?._get?.(b)?.lastLiveTs || 0;
    return bLive - aLive;
  });

  // First adopt any already-open desired channel tabs so capacity math is correct.
  for (const ch of desired) {
    if (managedChannels[ch]) continue;

    const existing = await findExistingChannelTab(ch);
    if (existing?.id) {
      await noteManaged(ch, existing.id, "reconcile:adopt_existing_live");
      log("reconcile_adopt_existing_live", { ch, tabId: existing.id });
    }
  }

  const desiredAlreadyOpen = await scanOpenDesiredChannels(desired);
  const openSet = new Set([
    ...Object.keys(managedChannels),
    ...Array.from(desiredAlreadyOpen)
  ]);

  const want = [];
  for (const ch of desired) {
    if (!openSet.has(ch)) want.push(ch);
  }

  let capacity = maxTabs - openSet.size;
  if (capacity < 0) capacity = 0;

  log("reconcile_info", {
    desired: desired.length,
    desired_channels: desired,
    want: want.length,
    want_channels: want,
    open_now: openSet.size,
    managed_now: Object.keys(managedChannels),
    capacity
  });

  for (const ch of want) {
    if (capacity > 0) {
      try {
        const tabId = await ensureOpen(ch, "manager");
        if (tabId) {
          openSet.add(ch);
          capacity -= 1;
        }
      } catch (e) {
        log("open_err", { login: ch, error: String(e) });
      }
      continue;
    }

    try {
      const closed = await closeWorstManagedFor(ch, openSet, priorityMap);
      if (closed) {
        openSet.delete(closed);

        const tabId = await ensureOpen(ch, "manager");
        if (tabId) {
          openSet.add(ch);
        }

        log("priority_preempt", { opened: ch, closed });
      } else {
        log("priority_preempt_skipped", { wanted: ch });
      }
    } catch (e) {
      log("priority_preempt_error", { login: ch, error: String(e) });
    }
  }

  for (const ch of Object.keys(managedChannels)) {
    if (!seen.has(ch)) {
      await ensureClosed(ch);
      openSet.delete(ch);
    }
  }
}

export async function listManaged() {
  await loadManagedState();
  await rehydrateManagedFromReality();
  return Object.keys(managedChannels).sort();
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

try {
  const T = (globalThis.TTM = globalThis.TTM || {});
  T.channelFromUrl = chanFromUrl;
  T.isManaged = isManaged;
  T.listOpenTabs = listOpenTabs;
  T.listManaged = listManaged;
  T.ensureOpen = ensureOpen;
  T.ensureClosed = ensureClosed;
  T.adoptOpenTabs = adoptOpenTabs;
  T.getRotationSlot = getRotationSlot;
  T.setRotationSlot = setRotationSlot;
  T.clearRotationSlot = clearRotationSlot;
  T.wasRecentlyUsedInRotation = wasRecentlyUsedInRotation;
  T.markRotationChannelUsed = markRotationChannelUsed;

  if (typeof self === "object") {
    self.bgTabs = self.bgTabs || {};
    self.bgTabs.reconcile = (liveCfg) =>
      reconcileTabs(liveCfg.liveList || liveCfg, {
        max_tabs: liveCfg.maxTabs || liveCfg.max_tabs,
        priority: liveCfg.priority || []
      });
    self.bgTabs.listManaged = listManaged;
  }
} catch {}