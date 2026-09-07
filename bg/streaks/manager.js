import { log } from "../core.js";
import { createBackgroundTab, navigateBackgroundTab, makeBackgroundSafe } from "../browser/tabs.js";
import {
  streakState,
  ABSENT_CONFIRMATIONS_REQUIRED,
  NO_PROGRESS_RELOAD_MS,
  HARD_FAIL_WALL_MS,
  cfg,
  enabled,
  automatic,
  requiredWatchMs,
  graceWatchMs,
  retryMs,
  isTwitchUrl,
  sanitizeStreak,
  loadState,
  saveState,
  pruneQueue,
  enqueue,
  nextReadyQueueItem,
  addHistory,
  updateWatchBadges,
  getWatchStreakBadge
} from "./state.js";
import { ensureManagerWindow, isManagerWindowId, isManagerWindowUnfocused, queueManagerTabPrime } from "../manager-window.js";

function sameTwitchPage(a, b) {
  try {
    const ua = new URL(String(a || ""));
    const ub = new URL(String(b || ""));
    return ua.hostname === ub.hostname && ua.pathname === ub.pathname;
  } catch {
    return String(a || "") === String(b || "");
  }
}

async function keepRescueTabBackgroundSafe(tabId) {
  if (tabId == null) return;
  await makeBackgroundSafe(tabId);
}

async function backgroundRescueWake(tabId, reason = "streak_recovery", { renavigate = false } = {}) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab?.active && !(await isManagerWindowUnfocused(tab.windowId))) {
      log("streak_rescue_wake_suppressed_user_active", { tabId, reason });
      return false;
    }

    await keepRescueTabBackgroundSafe(tabId);

    // A rescue VOD is disposable TTM-owned work. If it has made no playback
    // progress, background re-navigation is a safer recovery than activating
    // the tab or focusing its window. Normal managed live streams are not
    // reloaded by this path.
    if (renavigate && streakState.active?.tab_id === tabId && streakState.active?.url) {
      await navigateBackgroundTab(tabId, streakState.active.url);
    }

    await injectStreakHelper(tabId);
    if (streakState.active?.tab_id === tabId) {
      await sendControl(tabId, true, streakState.active);
    }

    log("streak_rescue_background_wake", { tabId, reason, renavigate: !!renavigate });
    return true;
  } catch (e) {
    log("streak_rescue_background_wake_error", { tabId, reason, error: String(e) });
    return false;
  }
}


function scheduleRescuePrimeFallback(tabId) {
  for (const delay of [8000, 65000]) {
    setTimeout(async () => {
      try {
        await loadState();
        const active = streakState.active;
        if (!active || active.tab_id !== tabId) return;
        if (Number(active.last_progress_at || 0) > 0 || Number(active.watched_ms || 0) > 0) return;

        const primed = await queueManagerTabPrime(tabId, "streak_rescue_no_playback", { dwellMs: 6000 });
        if (!primed) return;

        // Re-assert the rescue helper/control as soon as Twitch has had a short
        // genuinely-active render cycle inside the hidden manager window.
        await injectStreakHelper(tabId);
        await loadState();
        if (streakState.active?.tab_id === tabId) {
          await sendControl(tabId, true, streakState.active);
        }
        log("streak_rescue_internal_prime", { tabId, delayMs: delay });
      } catch (e) {
        log("streak_rescue_internal_prime_error", { tabId, delayMs: delay, error: String(e) });
      }
    }, delay);
  }
}
function scheduleRescueRepokes(tabId) {
  for (const delay of [1500, 5000, 12000, 25000]) {
    setTimeout(async () => {
      try {
        await keepRescueTabBackgroundSafe(tabId);
        await injectStreakHelper(tabId);
        await loadState();
        if (streakState.active?.tab_id === tabId) {
          await sendControl(tabId, true, streakState.active);
        }
      } catch {}
    }, delay);
  }
}

export async function injectStreakHelper(tabId) {
  if (tabId == null) return false;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content_streaks.js"] });
    return true;
  } catch {
    return false;
  }
}

async function sendControl(tabId, active, target = null) {
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "TTM_STREAK_RESCUE_CONTROL",
      active: !!active,
      target: target ? { channel: target.channel, url: target.url, streak: target.streak } : null
    });
  } catch {}
}

async function injectIntoOpenTwitchTabs() {
  try {
    const tabs = await chrome.tabs.query({ url: ["*://www.twitch.tv/*", "*://twitch.tv/*"] });
    for (const tab of tabs) if (tab.id != null) await injectStreakHelper(tab.id);
  } catch (e) {
    log("streak_inject_open_tabs_error", String(e));
  }
}

export async function onTwitchTabComplete(tabId, url) {
  if (!isTwitchUrl(url)) return;
  await injectStreakHelper(tabId);
  await loadState();
  if (streakState.active?.tab_id === tabId) await sendControl(tabId, true, streakState.active);
}

async function startRescue(item, reuseTabId = null) {
  const clean = sanitizeStreak(item);
  if (!clean) return false;

  let tabId = reuseTabId;
  try {
    const managerWindow = await ensureManagerWindow();

    if (tabId != null) {
      let reuse = null;
      try { reuse = await chrome.tabs.get(tabId); } catch {}
      if (!reuse || !isManagerWindowId(reuse.windowId)) {
        if (reuse?.id) { try { await chrome.tabs.remove(reuse.id); } catch {} }
        tabId = null;
      }
    }

    if (tabId != null) await navigateBackgroundTab(tabId, clean.url);
    else tabId = (await createBackgroundTab(clean.url, { windowId: managerWindow.windowId })).id;
    await keepRescueTabBackgroundSafe(tabId);
  } catch (e) {
    log("streak_rescue_open_error", { channel: clean.channel, error: String(e) });
    clean.not_before = Date.now() + retryMs();
    streakState.queue.push(clean);
    await saveState();
    return false;
  }

  streakState.queue = streakState.queue.filter((x) => !(x.channel === clean.channel && x.url === clean.url));
  streakState.active = {
    channel: clean.channel,
    streak: clean.streak,
    url: clean.url,
    tab_id: tabId,
    status: "watching",
    started_at: Date.now(),
    watched_ms: 0,
    last_progress_at: 0,
    last_playback_at: 0,
    required_reached_at: 0,
    absent_confirmations: 0,
    last_confirm_check_at: 0,
    last_reload_at: 0,
    playback_ok: false
  };
  await saveState();

  log("streak_rescue_started", {
    channel: clean.channel,
    streak: clean.streak,
    tabId,
    required_min: Math.round(requiredWatchMs() / 60000)
  });

  // Send rescue control immediately and then repoke a few times while Twitch's
  // SPA/player settles. This never activates the rescue tab.
  backgroundRescueWake(tabId, "startup", { renavigate: false }).catch(() => {});
  scheduleRescueRepokes(tabId);
  scheduleRescuePrimeFallback(tabId);
  return true;
}

async function finishActive(status, { keepTabForNext = true } = {}) {
  await loadState();
  const active = streakState.active;
  if (!active) return;

  const finished = { ...active, status, finished_at: Date.now() };
  addHistory(finished);
  streakState.active = null;
  await saveState();

  log("streak_rescue_finished", {
    channel: finished.channel,
    status,
    watched_ms: finished.watched_ms,
    tabId: finished.tab_id
  });

  const next = automatic() ? nextReadyQueueItem() : null;
  if (next && keepTabForNext && finished.tab_id != null) {
    await startRescue(next, finished.tab_id);
    return;
  }

  if (finished.tab_id != null) {
    try {
      await sendControl(finished.tab_id, false, null);
      await chrome.tabs.remove(finished.tab_id);
    } catch {}
  }
}

async function ensureActiveRescue() {
  await loadState();
  pruneQueue();
  if (!automatic() || streakState.active) return saveState();
  const next = nextReadyQueueItem();
  if (!next) return saveState();
  await startRescue(next);
}

export async function handleStreakScan(msg, sender) {
  await loadState();
  if (!enabled()) return { ok: true, ignored: "disabled" };

  const now = Date.now();
  const incoming = (Array.isArray(msg?.streaks) ? msg.streaks : []).map(sanitizeStreak).filter(Boolean);
  streakState.last_scan_at = now;
  streakState.last_scan_tab_id = sender?.tab?.id ?? null;
  streakState.last_scan_count = incoming.length;
  streakState.last_scan_url = String(msg?.url || sender?.tab?.url || "");
  streakState.last_scan_ready = !!msg?.scan_ready;
  streakState.last_scan_sidebar_present = !!msg?.sidebar_present;
  streakState.last_scan_group_present = !!msg?.group_present;
  streakState.last_scan_candidate_count = Math.max(0, Number(msg?.candidate_count || 0) || 0);
  streakState.last_scan_helper_version = Math.max(0, Number(msg?.helper_version || 0) || 0);
  updateWatchBadges(msg?.watch_streaks || [], !!msg?.watch_streak_scan_ready);
  for (const item of incoming) enqueue(item);
  pruneQueue();

  const active = streakState.active;
  if (active && active.required_reached_at) {
    const targetStillListed = incoming.some((x) => x.channel === active.channel);
    const validScan = !!msg?.scan_ready && (!!msg?.group_present || !!msg?.sidebar_present);
    const watchBadge = getWatchStreakBadge(active.channel);

    if (targetStillListed) active.absent_confirmations = 0;
    else if (validScan && watchBadge && Number(watchBadge.streak || 0) >= Number(active.streak || 0)) {
      await saveState();
      await finishActive("rescued_confirmed_watch_streak");
      return { ok: true, confirmed: true, via: "watch_streak_badge" };
    } else if (validScan) {
      const everyMs = Math.max(15, Number(cfg().streak_rescue_confirm_check_sec || 30)) * 1000;
      if (now - Number(active.last_confirm_check_at || 0) >= everyMs) {
        active.last_confirm_check_at = now;
        active.absent_confirmations = Number(active.absent_confirmations || 0) + 1;
      }
      if (active.absent_confirmations >= ABSENT_CONFIRMATIONS_REQUIRED) {
        await saveState();
        await finishActive("rescued_confirmed");
        return { ok: true, confirmed: true };
      }
    }
  }

  await saveState();
  if (automatic()) await ensureActiveRescue();
  return { ok: true, detected: incoming.length };
}

export async function handleStreakPlayback(msg, sender) {
  await loadState();
  const active = streakState.active;
  const tabId = sender?.tab?.id;
  if (!active || tabId == null || active.tab_id !== tabId) return { ok: true, ignored: "not_active_rescue_tab" };
  if (!sameTwitchPage(msg?.url, active.url)) {
    return { ok: true, ignored: "stale_rescue_page" };
  }

  const deltaMs = Math.max(0, Math.min(10000, Number(msg?.delta_ms || 0)));
  const validProgress = deltaMs > 0 && msg?.playing === true && msg?.adPlaying !== true;
  active.last_playback_at = Date.now();
  active.playback_ok = !!msg?.playing;

  if (validProgress) {
    active.watched_ms = Number(active.watched_ms || 0) + deltaMs;
    active.last_progress_at = Date.now();
  }

  if (!active.required_reached_at && active.watched_ms >= requiredWatchMs()) {
    active.required_reached_at = Date.now();
    active.status = "confirming";
    log("streak_rescue_required_watch_met", { channel: active.channel, watched_ms: active.watched_ms });
  }

  if (active.watched_ms >= requiredWatchMs() + graceWatchMs()) {
    await saveState();
    await finishActive("completed_unconfirmed");
    return { ok: true, completed_unconfirmed: true };
  }

  await saveState();
  return { ok: true, watched_ms: active.watched_ms };
}

export async function handleRescueTabRemoved(tabId) {
  await loadState();
  const active = streakState.active;
  if (!active || active.tab_id !== tabId) return;

  const retryItem = sanitizeStreak(active);
  if (retryItem) {
    retryItem.not_before = Date.now() + retryMs();
    streakState.queue.push(retryItem);
  }
  addHistory({ ...active, status: "interrupted", finished_at: Date.now() });
  streakState.active = null;
  await saveState();
}

export async function runStreakRescueTick() {
  await loadState();
  if (!enabled()) {
    if (streakState.active) await finishActive("cancelled_disabled", { keepTabForNext: false });
    return;
  }
  if (!automatic() && streakState.active) {
    await finishActive("cancelled_detect_only", { keepTabForNext: false });
    return;
  }

  await injectIntoOpenTwitchTabs();
  const active = streakState.active;
  if (active) {
    let tab = null;
    try { tab = await chrome.tabs.get(active.tab_id); } catch {}
    if (tab) {
      await keepRescueTabBackgroundSafe(active.tab_id);
      if (tab.discarded) {
        const woke = await backgroundRescueWake(active.tab_id, "discarded", { renavigate: true });
        if (woke) {
          active.last_reload_at = Date.now();
          await saveState();
          scheduleRescueRepokes(active.tab_id);
        }
      }
    }
    if (!tab) {
      await handleRescueTabRemoved(active.tab_id);
      if (automatic()) await ensureActiveRescue();
      return;
    }

    const now = Date.now();
    const noProgressFor = active.last_progress_at ? now - active.last_progress_at : now - active.started_at;
    if (noProgressFor >= NO_PROGRESS_RELOAD_MS && now - Number(active.last_reload_at || 0) >= NO_PROGRESS_RELOAD_MS) {
      const woke = await backgroundRescueWake(active.tab_id, "no_progress", { renavigate: true });
      if (woke) {
        active.last_reload_at = now;
        active.playback_ok = false;
        await saveState();
        scheduleRescueRepokes(active.tab_id);
        scheduleRescuePrimeFallback(active.tab_id);
      }
    }

    if (now - active.started_at >= HARD_FAIL_WALL_MS) {
      const retryItem = sanitizeStreak(active);
      if (retryItem) {
        retryItem.not_before = now + retryMs();
        streakState.queue.push(retryItem);
      }
      await finishActive("failed_timeout", { keepTabForNext: false });
      return;
    }
  }
  if (automatic()) await ensureActiveRescue();
}

export async function getStreakRescueStatus() {
  await loadState();
  const active = streakState.active ? { ...streakState.active } : null;
  const required = requiredWatchMs();
  const grace = graceWatchMs();
  return {
    enabled: enabled(),
    mode: String(cfg().streak_rescue_mode || "auto"),
    required_watch_ms: required,
    grace_watch_ms: grace,
    queue_count: streakState.queue.length,
    queue: streakState.queue.map((x) => ({ channel: x.channel, streak: x.streak, url: x.url, detected_at: x.detected_at, not_before: x.not_before || 0 })),
    active: active ? {
      ...active,
      required_remaining_ms: Math.max(0, required - Number(active.watched_ms || 0)),
      safety_remaining_ms: Math.max(0, required + grace - Number(active.watched_ms || 0))
    } : null,
    last_scan_at: streakState.last_scan_at,
    last_scan_count: streakState.last_scan_count,
    last_scan: {
      url: streakState.last_scan_url || "",
      ready: !!streakState.last_scan_ready,
      sidebar_present: !!streakState.last_scan_sidebar_present,
      group_present: !!streakState.last_scan_group_present,
      candidate_count: Number(streakState.last_scan_candidate_count || 0),
      helper_version: Number(streakState.last_scan_helper_version || 0),
      tab_id: streakState.last_scan_tab_id ?? null
    },
    watch_streaks: Object.values(streakState.watch_badges || {}),
    history: streakState.history.slice(-10)
  };
}

export async function initStreakRescue() {
  await loadState();
  await injectIntoOpenTwitchTabs();
  if (streakState.active?.tab_id != null) {
    try {
      await chrome.tabs.get(streakState.active.tab_id);
      await keepRescueTabBackgroundSafe(streakState.active.tab_id);
      await injectStreakHelper(streakState.active.tab_id);
      await sendControl(streakState.active.tab_id, true, streakState.active);
    } catch {
      await handleRescueTabRemoved(streakState.active.tab_id);
    }
  }
  if (automatic()) await ensureActiveRescue();
}

chrome.tabs.onRemoved.addListener((tabId) => {
  handleRescueTabRemoved(tabId).catch(() => {});
});
