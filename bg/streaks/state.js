import { state, log } from "../core.js";

const SESSION_KEY = "ttm.streak_rescue.state.v1";
export const MAX_HISTORY = 25;
export const MAX_QUEUE_AGE_MS = 26 * 60 * 60 * 1000;
export const ABSENT_CONFIRMATIONS_REQUIRED = 2;
export const NO_PROGRESS_RELOAD_MS = 60 * 1000;
export const HARD_FAIL_WALL_MS = 12 * 60 * 1000;

let loaded = false;
export let streakState = {
  queue: [],
  active: null,
  history: [],
  watch_badges: {},
  last_scan_at: 0,
  last_scan_tab_id: null,
  last_scan_count: 0,
  last_scan_url: "",
  last_scan_ready: false,
  last_scan_sidebar_present: false,
  last_scan_group_present: false,
  last_scan_candidate_count: 0,
  last_scan_helper_version: 0
};

export function cfg() {
  return state.settings || {};
}

export function enabled() {
  return cfg().streak_rescue_enabled === true;
}

export function automatic() {
  return enabled() && String(cfg().streak_rescue_mode || "auto") === "auto";
}

export function requiredWatchMs() {
  return Math.max(5, Number(cfg().streak_rescue_required_watch_min || 5)) * 60 * 1000;
}

export function graceWatchMs() {
  return Math.max(0, Number(cfg().streak_rescue_grace_min ?? 10)) * 60 * 1000;
}

export function retryMs() {
  return Math.max(5, Number(cfg().streak_rescue_retry_min || 15)) * 60 * 1000;
}

export function normalizeChannel(value) {
  return String(value || "").trim().toLowerCase();
}

export function isTwitchUrl(url) {
  try {
    const u = new URL(String(url || ""));
    return /^(www\.)?twitch\.tv$/i.test(u.hostname);
  } catch {
    return false;
  }
}

export function sanitizeStreak(item) {
  const channel = normalizeChannel(item?.channel);
  const url = String(item?.url || "").trim();
  const streak = Math.max(0, Number(item?.streak || 0) || 0);
  if (!channel || !url || !isTwitchUrl(url)) return null;

  return {
    channel,
    streak,
    url,
    detected_at: Number(item?.detected_at || Date.now()),
    last_seen_at: Date.now(),
    not_before: Number(item?.not_before || 0)
  };
}


export const WATCH_STREAK_PROTECT_MAX_MS = 15 * 60 * 1000;

export function updateWatchBadges(items = [], scanReady = false) {
  const now = Date.now();
  const incoming = new Map();

  for (const raw of Array.isArray(items) ? items : []) {
    const channel = normalizeChannel(raw?.channel);
    const streak = Math.max(0, Number(raw?.streak || 0) || 0);
    if (!channel) continue;
    incoming.set(channel, streak);

    const prev = streakState.watch_badges?.[channel] || {};
    streakState.watch_badges[channel] = {
      channel,
      streak,
      first_seen_at: Number(prev.first_seen_at || now),
      last_seen_at: now
    };
  }

  if (scanReady) {
    for (const channel of Object.keys(streakState.watch_badges || {})) {
      if (!incoming.has(channel)) delete streakState.watch_badges[channel];
    }
  }
}

export function getWatchStreakBadge(channel) {
  const ch = normalizeChannel(channel);
  return ch ? (streakState.watch_badges?.[ch] || null) : null;
}

export function isWatchStreakProtected(channel) {
  const badge = getWatchStreakBadge(channel);
  if (!badge) return false;
  const age = Date.now() - Number(badge.first_seen_at || Date.now());
  return age >= 0 && age < WATCH_STREAK_PROTECT_MAX_MS;
}

export async function loadState() {
  if (loaded) return streakState;
  try {
    const bag = await chrome.storage.session.get([SESSION_KEY]);
    const saved = bag?.[SESSION_KEY];
    if (saved && typeof saved === "object") {
      streakState = {
        ...streakState,
        ...saved,
        queue: Array.isArray(saved.queue) ? saved.queue : [],
        history: Array.isArray(saved.history) ? saved.history.slice(-MAX_HISTORY) : [],
        watch_badges: saved.watch_badges && typeof saved.watch_badges === "object" ? saved.watch_badges : {}
      };
    }
  } catch (e) {
    log("streak_state_load_error", String(e));
  }
  loaded = true;
  return streakState;
}

export async function saveState() {
  try {
    streakState.history = (streakState.history || []).slice(-MAX_HISTORY);
    await chrome.storage.session.set({ [SESSION_KEY]: streakState });
  } catch (e) {
    log("streak_state_save_error", String(e));
  }
}

export function pruneQueue() {
  const now = Date.now();
  streakState.queue = (streakState.queue || []).filter((item) => {
    if (!item?.channel || !item?.url) return false;
    return now - Number(item.detected_at || now) < MAX_QUEUE_AGE_MS;
  });
}

function recentlyFinishedSame(item) {
  const now = Date.now();
  const cutoff = retryMs();
  return (streakState.history || []).some((entry) => (
    entry?.channel === item.channel &&
    entry?.url === item.url &&
    now - Number(entry.finished_at || 0) < cutoff
  ));
}

export function enqueue(item) {
  const clean = sanitizeStreak(item);
  if (!clean) return false;
  if (streakState.active?.channel === clean.channel && streakState.active?.url === clean.url) return false;
  if (streakState.queue.some((x) => x.channel === clean.channel && x.url === clean.url)) return false;
  if (recentlyFinishedSame(clean)) return false;

  streakState.queue.push(clean);
  streakState.queue.sort((a, b) => {
    const byStreak = Number(b.streak || 0) - Number(a.streak || 0);
    return byStreak || Number(a.detected_at || 0) - Number(b.detected_at || 0);
  });
  return true;
}

export function nextReadyQueueItem() {
  const now = Date.now();
  return streakState.queue.find((item) => Number(item.not_before || 0) <= now) || null;
}

export function addHistory(entry) {
  streakState.history.push(entry);
  streakState.history = streakState.history.slice(-MAX_HISTORY);
}
