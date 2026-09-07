import { event } from "./events.js";

const REGISTRY_KEY = "ttm_tab_registry_v4";
const records = new Map();
let loaded = false;

function now() { return Date.now(); }

function baseRecord(tabId) {
  return {
    tabId: Number(tabId),
    expectedChannel: "",
    actualChannel: "",
    role: "unowned",
    reason: "",
    lifecycle: "unknown",
    owned: false,
    recoveryOwner: "",
    createdAt: 0,
    navigationStartedAt: 0,
    documentReadyAt: 0,
    playerReadyAt: 0,
    playbackStartedAt: 0,
    lastPlaybackProgressAt: 0,
    lastVideoTime: 0,
    lastStatusAt: 0,
    reloadAttempts: 0,
    navigateAttempts: 0,
    recoveryStage: 0,
    retryAfterAt: 0,
    recoveryCycles: 0,
    lastRecoveryActionAt: 0,
    activeRecoverySuppressedAt: 0,
    raidTarget: "",
    lastSnapshot: null
  };
}

async function persist() {
  try {
    const obj = {};
    for (const [id, rec] of records) obj[String(id)] = rec;
    await chrome.storage.session.set({ [REGISTRY_KEY]: obj });
  } catch {}
}

export async function initRegistry() {
  if (loaded) return;
  loaded = true;
  try {
    const got = await chrome.storage.session.get(REGISTRY_KEY);
    const obj = got[REGISTRY_KEY] && typeof got[REGISTRY_KEY] === "object" ? got[REGISTRY_KEY] : {};
    for (const [id, rec] of Object.entries(obj)) {
      records.set(Number(id), { ...baseRecord(Number(id)), ...rec, tabId: Number(id) });
    }
  } catch {}
}

export async function registerTab(tabId, patch = {}) {
  await initRegistry();
  const prev = records.get(Number(tabId)) || baseRecord(tabId);
  const next = { ...prev, ...patch, tabId: Number(tabId) };
  if (!next.createdAt) next.createdAt = now();
  records.set(Number(tabId), next);
  await persist();
  await event("REGISTRY", {
    tabId: Number(tabId),
    lifecycle: next.lifecycle,
    expectedChannel: next.expectedChannel,
    role: next.role,
    owned: !!next.owned,
    reason: next.reason
  });
  return next;
}

export async function unregisterTab(tabId) {
  await initRegistry();
  records.delete(Number(tabId));
  await persist();
}

export function getTabRecord(tabId) {
  return records.get(Number(tabId)) || null;
}

export function listTabRecords() {
  return [...records.values()].map((x) => ({ ...x }));
}

export async function markLifecycle(tabId, lifecycle, patch = {}) {
  await initRegistry();
  if (!records.has(Number(tabId))) return null;
  return registerTab(tabId, { ...patch, lifecycle: String(lifecycle || "unknown") });
}

export async function notePageState(tabId, msg = {}) {
  await initRegistry();
  const prev = records.get(Number(tabId));
  // Observation messages from arbitrary Twitch tabs must never create a
  // manager-owned registry entry. Only watchTab/registerTab can do that.
  if (!prev) return null;

  const t = now();
  const next = {
    ...prev,
    actualChannel: String(msg.channel || msg.login || prev.actualChannel || "").toLowerCase(),
    lastStatusAt: t,
    documentReadyAt: msg.documentReady ? (prev.documentReadyAt || t) : prev.documentReadyAt,
    lastSnapshot: {
      ...(prev.lastSnapshot || {}),
      page: {
        url: msg.url || "",
        title: msg.title || "",
        readyState: msg.readyState || "",
        documentHidden: !!msg.documentHidden,
        documentFocused: !!msg.documentFocused,
        channel: msg.channel || msg.login || "",
        offlineDom: !!msg.offlineDom,
        raid: !!msg.raid
      }
    }
  };

  if (msg.documentReady && ["creating", "navigating", "unknown", "recovering"].includes(next.lifecycle)) {
    next.lifecycle = "document_ready";
  }

  records.set(Number(tabId), next);
  await persist();
  return next;
}

export async function notePlayerState(tabId, msg = {}) {
  await initRegistry();
  const prev = records.get(Number(tabId));
  if (!prev) return null;

  const t = now();
  const currentTime = Number(msg.currentTime || 0);
  const priorTime = Number(prev.lastVideoTime || 0);
  const progressed = currentTime > priorTime + 0.15;
  const hasVideo = !!msg.hasVideo;
  const playerReady = hasVideo || !!msg.playerElement;

  const next = {
    ...prev,
    actualChannel: String(msg.login || prev.actualChannel || "").toLowerCase(),
    lastStatusAt: t,
    playerReadyAt: playerReady ? (prev.playerReadyAt || t) : prev.playerReadyAt,
    lastVideoTime: currentTime,
    lastPlaybackProgressAt: progressed ? t : prev.lastPlaybackProgressAt,
    playbackStartedAt: progressed ? (prev.playbackStartedAt || t) : prev.playbackStartedAt,
    lastSnapshot: {
      ...(prev.lastSnapshot || {}),
      player: {
        hasVideo,
        playerElement: !!msg.playerElement,
        paused: !!msg.paused,
        muted: !!msg.muted,
        readyState: Number(msg.readyState ?? -1),
        networkState: Number(msg.networkState ?? -1),
        currentTime,
        adPlaying: !!msg.adPlaying,
        stalledStart: !!msg.stalledStart,
        progressAgeMs: Number(msg.progressAgeMs ?? -1),
        url: msg.url || ""
      }
    }
  };

  if (progressed && !msg.paused) {
    if (next.lifecycle !== "playing") {
      await event("PLAYBACK_VERIFIED", {
        tabId: Number(tabId),
        channel: next.expectedChannel || next.actualChannel,
        currentTime
      });
    }
    next.lifecycle = "playing";
    next.recoveryStage = 0;
    next.retryAfterAt = 0;
    next.reloadAttempts = 0;
    next.navigateAttempts = 0;
    next.recoveryCycles = 0;
    next.lastRecoveryActionAt = 0;
    next.activeRecoverySuppressedAt = 0;
  } else if (playerReady && ["document_ready", "player_waiting", "starting", "unknown"].includes(next.lifecycle)) {
    next.lifecycle = "player_ready";
  }

  records.set(Number(tabId), next);
  await persist();
  return next;
}

export async function noteRaid(tabId, target = "") {
  await initRegistry();
  if (!records.has(Number(tabId))) return null;
  return registerTab(tabId, {
    lifecycle: "raided",
    raidTarget: String(target || "").toLowerCase()
  });
}

export { REGISTRY_KEY };
