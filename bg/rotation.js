import { event } from "./events.js";
import { log } from "./core.js";
import { buildHierarchy, classify, compareRank, norm, rank } from "./planner/hierarchy.js";

const T = (globalThis.TTM = globalThis.TTM || {});
const ROTATION_STATE_KEY = "ttm.rotation.scheduler.v2";
const MAX_RECENT_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_HISTORY = 40;

let loaded = false;
let schedulerState = {
  slots: {},
  recentlyUsed: {},
  history: [],
  updatedAt: 0
};

function cleanNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeState(raw) {
  const out = {
    slots: {},
    recentlyUsed: {},
    history: [],
    updatedAt: cleanNumber(raw?.updatedAt, 0)
  };

  for (const [key, value] of Object.entries(raw?.slots || {})) {
    const slotIndex = Math.max(0, Math.trunc(cleanNumber(value?.slotIndex ?? key, 0)));
    out.slots[String(slotIndex)] = {
      slotIndex,
      channel: norm(value?.channel),
      tabId: cleanNumber(value?.tabId, 0) || null,
      startedAt: cleanNumber(value?.startedAt, 0),
      lastRotatedAt: cleanNumber(value?.lastRotatedAt, 0),
      cursor: Math.max(0, Math.trunc(cleanNumber(value?.cursor, 0)))
    };
  }

  for (const [channel, ts] of Object.entries(raw?.recentlyUsed || {})) {
    const ch = norm(channel);
    const at = cleanNumber(ts, 0);
    if (ch && at > 0) out.recentlyUsed[ch] = at;
  }

  out.history = (Array.isArray(raw?.history) ? raw.history : [])
    .map((item) => ({
      at: cleanNumber(item?.at, 0),
      slotIndex: Math.max(0, Math.trunc(cleanNumber(item?.slotIndex, 0))),
      from: norm(item?.from),
      to: norm(item?.to),
      tabId: cleanNumber(item?.tabId, 0) || null,
      reason: String(item?.reason || "rotation")
    }))
    .filter((item) => item.at > 0 && item.to)
    .slice(-MAX_HISTORY);

  return out;
}

async function loadState() {
  if (loaded) return schedulerState;
  loaded = true;
  try {
    const got = await chrome.storage.session.get(ROTATION_STATE_KEY);
    schedulerState = normalizeState(got?.[ROTATION_STATE_KEY]);
  } catch {
    schedulerState = normalizeState(null);
  }
  return schedulerState;
}

async function saveState() {
  schedulerState.updatedAt = Date.now();
  try {
    await chrome.storage.session.set({ [ROTATION_STATE_KEY]: schedulerState });
  } catch {}
}

function uniqueOrdered(list) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const ch = norm(raw);
    if (!ch || seen.has(ch)) continue;
    seen.add(ch);
    out.push(ch);
  }
  return out;
}

function rotationConfig(cfg = {}) {
  const maxTabs = Math.max(1, Math.trunc(cleanNumber(cfg.max_tabs, 4) || 4));
  // Rotation slots are extra playback capacity above the normal max_tabs pool.
  // Keep a sane ceiling so a typo cannot create an unbounded number of tabs.
  const requestedSlots = Math.max(0, Math.min(32, Math.trunc(cleanNumber(cfg.rotation_slot_count, 1) || 0)));
  return {
    enabled: cfg.rotation_enabled === true,
    maxTabs,
    requestedSlots,
    intervalMs: Math.max(5, cleanNumber(cfg.rotation_interval_min, 30) || 30) * 60 * 1000,
    cooldownMs: Math.max(5, cleanNumber(cfg.rotation_cooldown_min, 30) || 30) * 60 * 1000,
    includeLowPriority: cfg.rotation_include_low_priority === true
  };
}

function isCooling(channel, recentlyUsed, cooldownMs, now) {
  const ts = cleanNumber(recentlyUsed?.[channel], 0);
  return !!ts && now - ts < cooldownMs;
}

function pickOldestAvailable(candidates, used, recentlyUsed) {
  const available = candidates.filter((ch) => !used.has(ch));
  if (!available.length) return "";
  available.sort((a, b) => {
    const aTs = cleanNumber(recentlyUsed?.[a], 0);
    const bTs = cleanNumber(recentlyUsed?.[b], 0);
    if (aTs !== bTs) return aTs - bTs;
    return candidates.indexOf(a) - candidates.indexOf(b);
  });
  return available[0] || "";
}

function chooseForSlot({ candidates, slot, used, recentlyUsed, cooldownMs, intervalMs, now }) {
  if (!candidates.length) return { channel: "", changed: !!slot?.channel, due: true, reason: "no_live_candidates" };

  const current = norm(slot?.channel);
  const currentValid = !!current && candidates.includes(current) && !used.has(current);
  const startedAt = cleanNumber(slot?.startedAt, 0);
  const due = !currentValid || !startedAt || now - startedAt >= intervalMs;

  // A live Twitch Watch Streak marker temporarily pins the current rotation
  // channel. Rotating it out while Twitch is still counting the current stream
  // would defeat the streak-protection behavior used elsewhere in TTM.
  let streakProtected = false;
  try { streakProtected = currentValid && !!globalThis.TTM?.isWatchStreakProtected?.(current); } catch {}
  if (streakProtected) {
    return { channel: current, changed: false, due, reason: "watch_streak_protected" };
  }

  if (currentValid && !due) {
    return { channel: current, changed: false, due: false, reason: "interval_not_due" };
  }

  const n = candidates.length;
  const start = n ? Math.max(0, Math.trunc(cleanNumber(slot?.cursor, 0))) % n : 0;

  for (let step = 0; step < n; step += 1) {
    const ch = candidates[(start + step) % n];
    if (used.has(ch)) continue;
    if (currentValid && n > 1 && ch === current) continue;
    if (isCooling(ch, recentlyUsed, cooldownMs, now)) continue;
    return { channel: ch, changed: ch !== current, due: true, reason: currentValid ? "interval_elapsed" : "slot_needs_channel" };
  }

  // Cooldown is a preference, not a reason to leave a live slot empty. If the
  // current channel is still live, keep it until another candidate becomes
  // eligible. If it went offline, choose the least-recently-used live channel.
  if (currentValid) {
    return { channel: current, changed: false, due: true, reason: "cooldown_wait_keep_current" };
  }

  const fallback = pickOldestAvailable(candidates, used, recentlyUsed);
  return {
    channel: fallback,
    changed: fallback !== current,
    due: true,
    reason: fallback ? "cooldown_fallback_no_current" : "no_available_candidate"
  };
}

function makeDetails(orderedLive, hierarchy, external, desiredSet, waitingSet, rotationSelected) {
  return orderedLive.map((channel) => ({
    channel,
    class: classify(channel, hierarchy),
    rank: rank(channel, hierarchy),
    external: external.has(channel),
    desiredManaged: desiredSet.has(channel),
    waiting: waitingSet.has(channel),
    rotationSelected: rotationSelected.has(channel)
  }));
}

export async function buildPhaseDRotationPlan(live = [], cfg = {}, { externalOpenChannels = [] } = {}) {
  await loadState();
  const rcfg = rotationConfig(cfg);
  const hierarchy = buildHierarchy(cfg);
  const seen = new Set();
  const orderedLive = [];

  for (const raw of Array.isArray(live) ? live : []) {
    const ch = norm(raw);
    if (!ch || seen.has(ch) || hierarchy.blacklist.has(ch)) continue;
    seen.add(ch);
    orderedLive.push(ch);
  }
  orderedLive.sort((a, b) => compareRank(a, b, hierarchy));

  const external = new Set(
    (Array.isArray(externalOpenChannels) ? externalOpenChannels : [])
      .map(norm)
      .filter((ch) => seen.has(ch))
  );

  const stablePool = orderedLive.filter((ch) => {
    if (external.has(ch)) return false;
    const cls = classify(ch, hierarchy);
    return cls === "favorite" || cls === "priority" || cls === "follow";
  });
  const lowPriorityPool = orderedLive.filter((ch) => !external.has(ch) && classify(ch, hierarchy) === "low_priority");

  const explicitRotation = uniqueOrdered(cfg.rotation).filter((ch) => seen.has(ch) && !external.has(ch) && !hierarchy.blacklist.has(ch));
  const lowRotation = rcfg.includeLowPriority
    ? uniqueOrdered(cfg.low_priority).filter((ch) => seen.has(ch) && !external.has(ch) && !hierarchy.blacklist.has(ch))
    : [];
  const rotationCandidates = uniqueOrdered([...explicitRotation, ...lowRotation]);

  // v1.0.14.9: max_tabs is the normal/stable pool. Rotation slots are
  // additional capacity, so a full normal pool does not block live rotation
  // channels. If fewer rotation candidates are live, stable channels may borrow
  // the otherwise-unused extra slots until rotation needs them.
  const stableCapacity = rcfg.maxTabs;
  const rotationCapacity = Math.max(0, Math.min(rcfg.requestedSlots, rotationCandidates.length));
  const ownedCap = rcfg.maxTabs + rcfg.requestedSlots;

  const selectedStable = stablePool.slice(0, stableCapacity);
  const usedRotation = new Set();
  const assignments = [];
  const now = Date.now();

  for (let slotIndex = 0; slotIndex < rotationCapacity; slotIndex += 1) {
    const slot = schedulerState.slots[String(slotIndex)] || {
      slotIndex,
      channel: "",
      tabId: null,
      startedAt: 0,
      lastRotatedAt: 0,
      cursor: slotIndex % Math.max(1, rotationCandidates.length)
    };

    const choice = chooseForSlot({
      candidates: rotationCandidates,
      slot,
      used: usedRotation,
      recentlyUsed: schedulerState.recentlyUsed,
      cooldownMs: rcfg.cooldownMs,
      intervalMs: rcfg.intervalMs,
      now
    });

    if (!choice.channel) continue;
    usedRotation.add(choice.channel);
    assignments.push({
      slotIndex,
      tabId: cleanNumber(slot.tabId, 0) || null,
      previousChannel: norm(slot.channel),
      channel: choice.channel,
      changed: choice.channel !== norm(slot.channel),
      due: !!choice.due,
      reason: choice.reason,
      startedAt: cleanNumber(slot.startedAt, 0),
      cursor: cleanNumber(slot.cursor, 0)
    });
  }

  const selectedRotation = assignments.map((item) => item.channel);
  const desired = [...selectedStable, ...selectedRotation];
  const desiredSet = new Set(desired);

  // Any unused dedicated rotation capacity can be borrowed by stable follows.
  // When rotation candidates appear later, the borrowed stable tabs yield those
  // extra slots while the normal max_tabs pool stays intact.
  for (const ch of stablePool) {
    if (desired.length >= ownedCap) break;
    if (desiredSet.has(ch)) continue;
    desired.push(ch);
    desiredSet.add(ch);
  }
  if (!rcfg.includeLowPriority) {
    for (const ch of lowPriorityPool) {
      if (desired.length >= ownedCap) break;
      if (desiredSet.has(ch)) continue;
      desired.push(ch);
      desiredSet.add(ch);
    }
  }

  const managedCandidates = orderedLive.filter((ch) => !external.has(ch));
  const waiting = managedCandidates.filter((ch) => !desiredSet.has(ch));
  const waitingSet = new Set(waiting);
  const rotationSelectedSet = new Set(selectedRotation);

  return {
    maxTabs: rcfg.maxTabs,
    ownedCap,
    hierarchy,
    liveConfigured: orderedLive,
    liveSet: seen,
    externalSatisfied: orderedLive.filter((ch) => external.has(ch)),
    desiredManaged: desired,
    desiredManagedSet: desiredSet,
    waiting,
    details: makeDetails(orderedLive, hierarchy, external, desiredSet, waitingSet, rotationSelectedSet),
    rotation: {
      enabled: true,
      requestedSlots: rcfg.requestedSlots,
      effectiveSlots: assignments.length,
      stableCapacity,
      rotationCapacity,
      ownedCap,
      intervalMs: rcfg.intervalMs,
      cooldownMs: rcfg.cooldownMs,
      includeLowPriority: rcfg.includeLowPriority,
      candidates: rotationCandidates,
      selected: selectedRotation,
      assignments,
      recentlyUsed: { ...schedulerState.recentlyUsed }
    }
  };
}

export async function commitRotationAssignment(slotIndex, {
  channel,
  tabId = null,
  previousChannel = "",
  candidates = []
} = {}) {
  await loadState();
  const index = Math.max(0, Math.trunc(cleanNumber(slotIndex, 0)));
  const key = String(index);
  const prior = schedulerState.slots[key] || {};
  const nextChannel = norm(channel);
  const oldChannel = norm(previousChannel || prior.channel);
  const now = Date.now();
  const changed = !!nextChannel && nextChannel !== oldChannel;

  if (changed && oldChannel) schedulerState.recentlyUsed[oldChannel] = now;

  const orderedCandidates = uniqueOrdered(candidates);
  const selectedIndex = orderedCandidates.indexOf(nextChannel);
  const nextCursor = selectedIndex >= 0 && orderedCandidates.length
    ? (selectedIndex + 1) % orderedCandidates.length
    : Math.max(0, Math.trunc(cleanNumber(prior.cursor, 0)));

  schedulerState.slots[key] = {
    slotIndex: index,
    channel: nextChannel,
    tabId: cleanNumber(tabId, 0) || null,
    startedAt: changed || !cleanNumber(prior.startedAt, 0) ? now : cleanNumber(prior.startedAt, now),
    lastRotatedAt: changed ? now : cleanNumber(prior.lastRotatedAt, 0),
    cursor: nextCursor
  };

  if (changed) {
    schedulerState.history.push({
      at: now,
      slotIndex: index,
      from: oldChannel,
      to: nextChannel,
      tabId: cleanNumber(tabId, 0) || null,
      reason: "rotation"
    });
    if (schedulerState.history.length > MAX_HISTORY) {
      schedulerState.history = schedulerState.history.slice(-MAX_HISTORY);
    }
  }

  // Keep session state compact.
  for (const [ch, ts] of Object.entries(schedulerState.recentlyUsed)) {
    if (now - cleanNumber(ts, 0) > MAX_RECENT_AGE_MS) delete schedulerState.recentlyUsed[ch];
  }

  await saveState();
  await event(changed ? "ROTATION_SLOT_COMMIT" : "ROTATION_SLOT_BIND", {
    slotIndex: index,
    previousChannel: oldChannel,
    channel: nextChannel,
    tabId: cleanNumber(tabId, 0) || null
  });
  return schedulerState.slots[key];
}

export async function releaseRotationTab(tabId, reason = "released") {
  await loadState();
  const id = cleanNumber(tabId, 0);
  if (!id) return false;
  let changed = false;
  const now = Date.now();

  for (const [key, slot] of Object.entries(schedulerState.slots)) {
    if (cleanNumber(slot?.tabId, 0) !== id) continue;
    const oldChannel = norm(slot?.channel);
    if (oldChannel) schedulerState.recentlyUsed[oldChannel] = now;
    schedulerState.slots[key] = {
      ...slot,
      channel: "",
      tabId: null,
      startedAt: 0,
      lastRotatedAt: now
    };
    changed = true;
    await event("ROTATION_SLOT_RELEASED", {
      slotIndex: Number(key),
      tabId: id,
      previousChannel: oldChannel,
      reason
    });
  }

  if (changed) await saveState();
  return changed;
}

export async function pruneRotationSlots(slotCount = 0) {
  await loadState();
  const keep = Math.max(0, Math.trunc(cleanNumber(slotCount, 0)));
  let changed = false;
  for (const key of Object.keys(schedulerState.slots)) {
    if (Number(key) < keep) continue;
    const old = schedulerState.slots[key];
    if (old?.channel) schedulerState.recentlyUsed[norm(old.channel)] = Date.now();
    delete schedulerState.slots[key];
    changed = true;
  }
  if (changed) await saveState();
}

export async function getRotationStatus(cfg = {}, live = []) {
  await loadState();
  const rcfg = rotationConfig(cfg);
  const now = Date.now();
  const liveSet = new Set((Array.isArray(live) ? live : []).map(norm).filter(Boolean));
  const explicit = uniqueOrdered(cfg.rotation);
  const low = rcfg.includeLowPriority ? uniqueOrdered(cfg.low_priority) : [];
  const configuredCandidates = uniqueOrdered([...explicit, ...low]);
  const liveCandidates = configuredCandidates.filter((ch) => liveSet.has(ch));

  const cooling = configuredCandidates
    .map((channel) => {
      const usedAt = cleanNumber(schedulerState.recentlyUsed?.[channel], 0);
      const remainingMs = usedAt ? Math.max(0, rcfg.cooldownMs - (now - usedAt)) : 0;
      return { channel, usedAt, remainingMs, cooling: remainingMs > 0 };
    })
    .filter((item) => item.cooling)
    .sort((a, b) => a.remainingMs - b.remainingMs);

  const assignedChannels = new Set(
    Object.values(schedulerState.slots || {}).map((slot) => norm(slot?.channel)).filter(Boolean)
  );

  const slots = Object.values(schedulerState.slots)
    .map((slot) => {
      const channel = norm(slot?.channel);
      const startedAt = cleanNumber(slot?.startedAt, 0);
      const elapsedMs = startedAt ? Math.max(0, now - startedAt) : 0;
      const remainingMs = channel && startedAt ? Math.max(0, rcfg.intervalMs - elapsedMs) : 0;
      let streakProtected = false;
      try { streakProtected = !!channel && !!globalThis.TTM?.isWatchStreakProtected?.(channel); } catch {}

      const nextEligible = liveCandidates.filter((candidate) => {
        if (candidate === channel) return false;
        if (assignedChannels.has(candidate)) return false;
        return !isCooling(candidate, schedulerState.recentlyUsed, rcfg.cooldownMs, now);
      });

      return {
        ...slot,
        channel,
        live: !!channel && liveSet.has(channel),
        streakProtected,
        elapsedMs,
        remainingMs,
        due: !!channel && !!startedAt && remainingMs <= 0,
        nextEligible
      };
    })
    .sort((a, b) => a.slotIndex - b.slotIndex);

  return {
    enabled: rcfg.enabled,
    normalMaxTabs: rcfg.maxTabs,
    ownedCap: rcfg.maxTabs + rcfg.requestedSlots,
    requestedSlots: rcfg.requestedSlots,
    effectiveSlots: slots.filter((slot) => !!slot.channel).length,
    intervalMin: rcfg.intervalMs / 60_000,
    cooldownMin: rcfg.cooldownMs / 60_000,
    includeLowPriority: rcfg.includeLowPriority,
    configuredCandidates,
    liveCandidates,
    nextEligible: liveCandidates.filter((candidate) => !assignedChannels.has(candidate) && !isCooling(candidate, schedulerState.recentlyUsed, rcfg.cooldownMs, now)),
    slots,
    cooling,
    recentlyUsed: { ...schedulerState.recentlyUsed },
    history: schedulerState.history.slice(-MAX_HISTORY).reverse(),
    updatedAt: schedulerState.updatedAt,
    now
  };
}

export function isPhaseDRotationEnabled(cfg = {}) {
  return rotationConfig(cfg).enabled && rotationConfig(cfg).requestedSlots > 0;
}

T.getRotationStatus = getRotationStatus;
T.releaseRotationTab = releaseRotationTab;
T.isPhaseDRotationEnabled = isPhaseDRotationEnabled;

export { ROTATION_STATE_KEY };
