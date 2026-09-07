import { log, state } from "./core.js";
import { event } from "./events.js";
import {
  initRegistry,
  getTabRecord,
  listTabRecords,
  markLifecycle,
  registerTab,
  unregisterTab
} from "./registry.js";
import { makeBackgroundSafe } from "./browser/tabs.js";
import { isManagerWindowUnfocused, queueManagerTabPrime } from "./manager-window.js";

const CHECK_ALARM = "ttm-watchdog";
const ACTIVE_RECHECK_MS = 60_000;
const RETRY_LATER_MS = 10 * 60_000;
// Kept as exports for diagnose/backward compatibility. v1.0.13.3 performs no
// automatic destructive playback recovery at all.
const MAX_RELOAD_ATTEMPTS = 0;
const MAX_NAVIGATE_ATTEMPTS = 0;
const recovering = new Set();

const STARTUP_TIMING = {
  firstRetryMs: 25_000,
  afterPlayMs: 25_000,
  afterVisibilityMs: 30_000,
  afterPrimeMs: 25_000
};

const ESTABLISHED_TIMING = {
  firstRetryMs: 90_000,
  afterPlayMs: 60_000,
  afterVisibilityMs: 60_000,
  afterPrimeMs: 45_000
};

async function requestSnapshot(tabId) {
  try {
    const resp = await chrome.tabs.sendMessage(tabId, { type: "TTM_RUNTIME_SNAPSHOT" });
    return resp || null;
  } catch {
    return null;
  }
}

async function canControl(tab) {
  if (!tab?.active) return true;
  return await isManagerWindowUnfocused(tab.windowId);
}

async function reinject(tabId) {
  if (!globalThis.TTM?.isManaged?.(tabId)) return false;

  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch { return false; }
  if (!(await canControl(tab))) return false;

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content_runtime.js", "content_unmute.js", "content_status.js", "content_streaks.js"]
    });
  } catch {}

  try { await makeBackgroundSafe(tabId); } catch {}

  const rec = getTabRecord(tabId);
  const startupMuted = !Number(rec?.playbackStartedAt || 0);

  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "TTM_ENFORCE",
      settings: {
        startup_muted: startupMuted,
        force_unmute: startupMuted ? false : !!state.settings.force_unmute,
        unmute_streams: startupMuted ? false : !!state.settings.unmute_streams,
        force_resume: true,
        autoplay_streams: true
      }
    });
  } catch {}
  return true;
}

async function capture(tabId, reason) {
  let tab = null;
  try { tab = await chrome.tabs.get(tabId); } catch {}
  const snap = await requestSnapshot(tabId);
  await event("STUCK_SNAPSHOT", {
    reason,
    tabId,
    chrome: tab ? {
      status: tab.status,
      discarded: !!tab.discarded,
      active: !!tab.active,
      windowId: tab.windowId ?? null,
      url: tab.url || tab.pendingUrl || ""
    } : null,
    runtime: snap
  });
  return { tab, snap };
}

async function backgroundVisibilityPulse(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        try {
          const oldHidden = Object.getOwnPropertyDescriptor(document, "hidden");
          const oldVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
          Object.defineProperty(document, "hidden", { get: () => false, configurable: true });
          Object.defineProperty(document, "visibilityState", { get: () => "visible", configurable: true });
          document.dispatchEvent(new Event("visibilitychange"));
          window.dispatchEvent(new Event("pageshow"));
          const video = document.querySelector("video");
          if (video) {
            // Never change Twitch's own player mute state during recovery.
            // Browser-tab muting is handled by the extension API separately.
            Promise.resolve(video.play()).catch(() => {});
          }
          setTimeout(() => {
            try {
              if (oldHidden) Object.defineProperty(document, "hidden", oldHidden);
              else delete document.hidden;
              if (oldVisibility) Object.defineProperty(document, "visibilityState", oldVisibility);
              else delete document.visibilityState;
              document.dispatchEvent(new Event("visibilitychange"));
            } catch {}
          }, 1800);
        } catch {}
      }
    });
    await event("RECOVERY_VISIBILITY_PULSE", { tabId, realFocusRequested: false });
    return true;
  } catch (e) {
    await event("RECOVERY_VISIBILITY_PULSE_FAILED", { tabId, error: String(e) });
    return false;
  }
}

function initialProblemAge(rec, now) {
  if (rec.lastPlaybackProgressAt) return Math.max(0, now - Number(rec.lastPlaybackProgressAt));
  return Math.max(0, now - Number(rec.navigationStartedAt || rec.createdAt || now));
}

function stageAge(rec, now) {
  const actionAt = Number(rec.lastRecoveryActionAt || 0);
  return actionAt ? Math.max(0, now - actionAt) : 0;
}

function timingFor(rec) {
  return Number(rec.playbackStartedAt || 0) > 0 ? ESTABLISHED_TIMING : STARTUP_TIMING;
}

async function failForLater(tabId, rec, reason) {
  const now = Date.now();
  await capture(tabId, reason);
  await markLifecycle(tabId, "failed", {
    recoveryStage: 0,
    retryAfterAt: now + RETRY_LATER_MS,
    lastRecoveryActionAt: now,
    recoveryCycles: Number(rec.recoveryCycles || 0) + 1,
    reloadAttempts: 0,
    navigateAttempts: 0
  });
  await event("RECOVERY_NONDESTRUCTIVE_EXHAUSTED", {
    tabId,
    expected: rec.expectedChannel || "",
    retryAfterMs: RETRY_LATER_MS
  });
  log("background_playback_failed_nondestructive", {
    tabId,
    channel: rec.expectedChannel,
    retryAfterMs: RETRY_LATER_MS
  });
}

async function recoverRecord(rec) {
  const tabId = Number(rec.tabId);
  if (!tabId || recovering.has(tabId)) return;
  recovering.add(tabId);

  try {
    if (!globalThis.TTM?.isManaged?.(tabId)) {
      await unregisterTab(tabId);
      return;
    }

    let tab;
    try { tab = await chrome.tabs.get(tabId); }
    catch {
      await unregisterTab(tabId);
      return;
    }

    const now = Date.now();
    const expected = rec.expectedChannel || "";
    const timing = timingFor(rec);
    const problemAge = initialProblemAge(rec, now);
    const controllable = await canControl(tab);

    // A managed tab in any user-focused window is observation-only. An active
    // tab inside the dedicated *unfocused* TTM window is safe to control.
    if (!controllable) {
      if (problemAge >= timing.firstRetryMs) {
        const lastSuppressedAt = Number(rec.activeRecoverySuppressedAt || 0);
        if (now - lastSuppressedAt >= ACTIVE_RECHECK_MS) {
          await capture(tabId, "active_tab_protected");
          await registerTab(tabId, { activeRecoverySuppressedAt: now });
          await event("RECOVERY_SUPPRESSED_ACTIVE_TAB", { tabId, expected, problemAgeMs: problemAge });
        }
      }
      return;
    }

    await makeBackgroundSafe(tabId);

    if (tab.discarded) {
      // No reload. AutoDiscardable is already disabled; if Chromium discarded
      // the tab anyway, wait for the browser/user to restore it naturally.
      await failForLater(tabId, rec, "discarded_no_destructive_recovery");
      return;
    }

    if (rec.lifecycle === "playing" && problemAge < timing.firstRetryMs) return;

    if (rec.lifecycle === "failed") {
      const retryAfterAt = Number(rec.retryAfterAt || 0);
      if (retryAfterAt && now < retryAfterAt) return;
      await markLifecycle(tabId, "recovering", {
        recoveryStage: 1,
        retryAfterAt: 0,
        lastRecoveryActionAt: now,
        reloadAttempts: 0,
        navigateAttempts: 0
      });
      await reinject(tabId);
      await event("RECOVERY_RETRY_LATER", {
        tabId,
        expected,
        strategy: "nondestructive_only"
      });
      return;
    }

    const stage = Number(rec.recoveryStage || 0);
    const sinceAction = stageAge(rec, now);

    if (stage === 0) {
      if (problemAge < timing.firstRetryMs) return;
      await capture(tabId, "no_playback_progress");
      await markLifecycle(tabId, "recovering", {
        recoveryStage: 1,
        lastRecoveryActionAt: now,
        reloadAttempts: 0,
        navigateAttempts: 0
      });
      await reinject(tabId);
      await event("RECOVERY_PLAY_RETRY", { tabId, expected, problemAgeMs: problemAge });
      return;
    }

    if (stage === 1) {
      if (sinceAction < timing.afterPlayMs) return;
      await capture(tabId, "play_retry_did_not_recover");
      await markLifecycle(tabId, "recovering", { recoveryStage: 2, lastRecoveryActionAt: now });
      await backgroundVisibilityPulse(tabId);
      setTimeout(() => reinject(tabId).catch(() => {}), 2200);
      return;
    }

    if (stage === 2) {
      if (sinceAction < timing.afterVisibilityMs) return;
      await capture(tabId, "visibility_pulse_did_not_recover");
      await markLifecycle(tabId, "recovering", { recoveryStage: 3, lastRecoveryActionAt: now });
      const primed = await queueManagerTabPrime(tabId, "watchdog_recovery", { dwellMs: 3200 });
      if (primed) setTimeout(() => reinject(tabId).catch(() => {}), 350);
      await event("RECOVERY_MANAGER_WINDOW_PRIME", { tabId, expected, primed: !!primed });
      return;
    }

    if (stage >= 3) {
      if (sinceAction < timing.afterPrimeMs) return;
      await failForLater(tabId, rec, "manager_window_prime_did_not_recover");
    }
  } finally {
    recovering.delete(tabId);
  }
}

export async function runWatchdog() {
  await initRegistry();
  for (const rec of listTabRecords()) {
    if (!rec?.owned) continue;
    if (!globalThis.TTM?.isManaged?.(rec.tabId)) {
      await unregisterTab(rec.tabId);
      continue;
    }
    if (!["stable", "rotation", "restored_owned"].includes(rec.role)) continue;
    if (rec.lifecycle === "raided") continue;
    await recoverRecord(rec);
  }
}

export async function armWatchdog() {
  try { await chrome.alarms.clear(CHECK_ALARM); } catch {}
  try { await chrome.alarms.create(CHECK_ALARM, { periodInMinutes: 0.5 }); }
  catch {
    try { await chrome.alarms.create(CHECK_ALARM, { periodInMinutes: 1 }); } catch {}
  }
}

export async function watchTab(tabId, expectedChannel, { role = "stable", reason = "manager" } = {}) {
  await initRegistry();
  const expected = String(expectedChannel || "").toLowerCase();
  const existing = getTabRecord(tabId);
  const sameTarget = !!existing && existing.owned === true && existing.expectedChannel === expected;
  const now = Date.now();

  await registerTab(tabId, {
    expectedChannel: expected,
    role,
    reason,
    owned: true,
    recoveryOwner: "watchdog_nondestructive",
    lifecycle: sameTarget ? existing.lifecycle : "creating",
    createdAt: sameTarget && existing.createdAt ? existing.createdAt : now,
    navigationStartedAt: sameTarget && existing.navigationStartedAt ? existing.navigationStartedAt : now,
    documentReadyAt: sameTarget ? Number(existing.documentReadyAt || 0) : 0,
    playerReadyAt: sameTarget ? Number(existing.playerReadyAt || 0) : 0,
    playbackStartedAt: sameTarget ? Number(existing.playbackStartedAt || 0) : 0,
    lastPlaybackProgressAt: sameTarget ? Number(existing.lastPlaybackProgressAt || 0) : 0,
    lastVideoTime: sameTarget ? Number(existing.lastVideoTime || 0) : 0,
    recoveryStage: sameTarget ? Number(existing.recoveryStage || 0) : 0,
    retryAfterAt: sameTarget ? Number(existing.retryAfterAt || 0) : 0,
    lastRecoveryActionAt: sameTarget ? Number(existing.lastRecoveryActionAt || 0) : 0,
    reloadAttempts: 0,
    navigateAttempts: 0
  });

  await makeBackgroundSafe(tabId);

  if (!sameTarget) {
    setTimeout(() => reinject(tabId).catch(() => {}), 1100);
    // Give Twitch a chance to initialize fully in the background first. If the
    // tab still has not started playback after 15s, give it one short internal
    // active cycle *inside the already-unfocused TTM window*. No browser window
    // is focused or defocused, and tabs that started normally are never touched.
    setTimeout(async () => {
      try {
        const fresh = getTabRecord(tabId);
        if (!fresh || Number(fresh.playbackStartedAt || 0) > 0 || Number(fresh.lastPlaybackProgressAt || 0) > 0) return;
        const primed = await queueManagerTabPrime(tabId, "startup_no_playback", { dwellMs: 2800 });
        if (primed) setTimeout(() => reinject(tabId).catch(() => {}), 300);
      } catch {}
    }, 15_000);

    for (const delay of [18_000, 35_000, 60_000, 95_000, 180_000]) {
      setTimeout(() => runWatchdog().catch(() => {}), delay);
    }
  }
}

export { CHECK_ALARM, MAX_RELOAD_ATTEMPTS, MAX_NAVIGATE_ATTEMPTS, RETRY_LATER_MS };
