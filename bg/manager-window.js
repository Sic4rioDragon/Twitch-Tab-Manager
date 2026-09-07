import { event } from "./events.js";
import { createBackgroundTab, makeBackgroundSafe, withTabEditRetry } from "./browser/tabs.js";

const T = (globalThis.TTM = globalThis.TTM || {});

const MANAGER_WINDOW_KEY = "ttm.manager.window.v1";
const HOLDER_URL = chrome.runtime.getURL("manager.html");
const PRIME_MS = 2800;
const PRIME_FOCUS_BACKOFF_MS = 10 * 60_000;
const PRIME_REPEAT_COOLDOWN_MS = 45_000;
const HOLDER_SETTLE_MS = 350;
const FOCUS_GUARD_MS = 0;
const FOCUS_RESTORE_SETTLE_MS = 0;
const STARTUP_CREATE_QUIET_MS = 1200;
const CREATE_FOCUS_AUDIT_DELAYS_MS = [0, 250, 900, 1800];

let cachedWindowId = null;
let cachedHolderTabId = null;
let primeChain = Promise.resolve();
let focusBreachCount = 0;
let lastFocusBreachAt = 0;
let lastKnownUserWindowId = null;
let pendingManagerCreate = false;
let pendingCreateFocusWindowId = null;
let createPromise = null;
let moduleLoadedAt = Date.now();
let primingDisabledForSession = false;
let primingBlockedUntil = 0;
let primeFocusBreachCount = 0;
let currentPrimeTabId = null;
let currentPrimeFocusBreached = false;
const lastPrimeAtByTabId = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function persistState() {
  try {
    await chrome.storage.session.set({
      [MANAGER_WINDOW_KEY]: {
        windowId: cachedWindowId,
        holderTabId: cachedHolderTabId
      }
    });
  } catch {}
}

async function clearState(reason = "cleared") {
  const prior = { windowId: cachedWindowId, holderTabId: cachedHolderTabId };
  cachedWindowId = null;
  cachedHolderTabId = null;
  try { await chrome.storage.session.remove(MANAGER_WINDOW_KEY); } catch {}
  if (prior.windowId) await event("MANAGER_WINDOW_STATE_CLEARED", { ...prior, reason });
}

async function loadStoredState() {
  if (cachedWindowId) return;
  try {
    const got = await chrome.storage.session.get(MANAGER_WINDOW_KEY);
    const state = got?.[MANAGER_WINDOW_KEY] || {};
    cachedWindowId = Number(state.windowId || 0) || null;
    cachedHolderTabId = Number(state.holderTabId || 0) || null;
  } catch {}
}

async function validateWindow(windowId) {
  const id = Number(windowId || 0);
  if (!id) return null;
  try {
    return await chrome.windows.get(id, { populate: true });
  } catch {
    return null;
  }
}

async function ensureHolder(windowId) {
  if (cachedHolderTabId) {
    try {
      const tab = await chrome.tabs.get(cachedHolderTabId);
      if (Number(tab.windowId) === Number(windowId) && tab.url === HOLDER_URL) return tab;
    } catch {}
    cachedHolderTabId = null;
  }

  try {
    const tabs = await chrome.tabs.query({ windowId: Number(windowId) });
    const existing = tabs.find((tab) => tab.url === HOLDER_URL);
    if (existing?.id) {
      cachedHolderTabId = existing.id;
      await persistState();
      return existing;
    }
  } catch {}

  const holder = await createBackgroundTab(HOLDER_URL, { windowId: Number(windowId) });
  cachedHolderTabId = holder?.id || null;
  await persistState();
  return holder || null;
}

async function rememberNormalWindow() {
  try {
    const win = await chrome.windows.getLastFocused();
    if (win?.id && !isManagerWindowId(win.id)) {
      lastKnownUserWindowId = Number(win.id);
      return win;
    }
  } catch {}
  return null;
}

async function auditCreateFocus(windowId, delayMs) {
  const id = Number(windowId || 0);
  if (!id) return;
  if (delayMs > 0) await sleep(delayMs);

  let win = null;
  try { win = await chrome.windows.get(id); } catch { return; }
  if (!win?.focused) return;

  focusBreachCount += 1;
  lastFocusBreachAt = Date.now();
  await event("MANAGER_WINDOW_FOCUS_BREACH_PASSIVE", {
    windowId: id,
    phase: delayMs ? `create_audit_${delayMs}ms` : "create_return",
    focusBreachCount,
    policy: "observe_only_never_refocus_any_window"
  });
}

async function createManagerWindow() {
  // v1.0.14.9: hard focus policy. TTM never calls chrome.windows.update() to
  // focus OR defocus anything. The old focus guard caused repeated foreground
  // changes during startup and could yank games/typing back to Brave. Request
  // focused:false once, then only observe what Chromium actually does.
  const quietRemaining = Math.max(0, STARTUP_CREATE_QUIET_MS - (Date.now() - moduleLoadedAt));
  if (quietRemaining) await sleep(quietRemaining);

  const before = await rememberNormalWindow();
  pendingCreateFocusWindowId = null;
  pendingManagerCreate = true;

  let created = null;
  try {
    created = await chrome.windows.create({
      url: HOLDER_URL,
      focused: false,
      type: "normal",
      state: "normal",
      width: 520,
      height: 320
    });
    if (created?.id) cachedWindowId = Number(created.id);
  } finally {
    pendingManagerCreate = false;
  }

  if (!created?.id) throw new Error("manager_window_create_failed");

  cachedWindowId = Number(created.id);
  cachedHolderTabId = created.tabs?.[0]?.id || null;
  if (!cachedHolderTabId) await ensureHolder(created.id);
  await persistState();

  await event("MANAGER_WINDOW_CREATED", {
    windowId: created.id,
    holderTabId: cachedHolderTabId,
    returnedFocused: !!created.focused,
    state: created.state || "unknown",
    startupMode: "normal_unfocused_passive_no_refocus",
    priorNormalWindowId: before?.id || lastKnownUserWindowId || null,
    priorNormalWindowFocused: !!before?.focused,
    pendingCreateFocusWindowId,
    focusPolicy: "never_call_windows_update_for_focus"
  });

  for (const delay of CREATE_FOCUS_AUDIT_DELAYS_MS) {
    auditCreateFocus(created.id, delay).catch(() => {});
  }

  return {
    windowId: created.id,
    holderTabId: cachedHolderTabId,
    focused: !!created.focused,
    state: created.state || "unknown",
    created: true
  };
}

export async function ensureManagerWindow() {
  await loadStoredState();

  const existing = await validateWindow(cachedWindowId);
  if (existing) {
    await ensureHolder(existing.id);
    return {
      windowId: existing.id,
      holderTabId: cachedHolderTabId,
      focused: !!existing.focused,
      state: existing.state || "unknown",
      created: false
    };
  }

  if (cachedWindowId) await clearState("stale_window");

  // Collapse simultaneous startup/reconcile callers into one windows.create.
  if (!createPromise) {
    createPromise = createManagerWindow().finally(() => {
      createPromise = null;
    });
  }
  return createPromise;
}

function passiveFocusStatus(win = null) {
  return {
    mode: "passive_no_window_focus_with_internal_tab_prime",
    remainingMs: Math.max(0, Number(primingBlockedUntil || 0) - Date.now()),
    reason: primingDisabledForSession ? "disabled_after_focus_breaches" : (primingBlockedUntil > Date.now() ? "focus_breach_backoff" : "ready"),
    targetWindowId: null,
    targetWasFocused: false,
    lastKnownUserWindowId,
    restoreCount: 0,
    lastRestoreAt: 0,
    lastRestoreTargetWindowId: null,
    lastRestoreReason: "",
    managerFocused: !!win?.focused,
    currentPrimeTabId
  };
}

export async function getManagerWindowInfo() {
  await loadStoredState();
  const win = await validateWindow(cachedWindowId);
  if (!win) {
    if (cachedWindowId) await clearState("missing_during_status");
    return {
      exists: false,
      windowId: null,
      holderTabId: null,
      focused: false,
      state: "missing",
      primingDisabledForSession,
      primingBlockedUntil,
      primingBlockedMsRemaining: Math.max(0, Number(primingBlockedUntil || 0) - Date.now()),
      focusBreachCount,
      lastFocusBreachAt,
      focusGuard: passiveFocusStatus(null)
    };
  }

  await ensureHolder(win.id);
  return {
    exists: true,
    windowId: win.id,
    holderTabId: cachedHolderTabId,
    focused: !!win.focused,
    state: win.state || "unknown",
    primingDisabledForSession,
    primingBlockedUntil,
    primingBlockedMsRemaining: Math.max(0, Number(primingBlockedUntil || 0) - Date.now()),
    focusBreachCount,
    lastFocusBreachAt,
    focusGuard: passiveFocusStatus(win)
  };
}

export function isManagerWindowId(windowId) {
  const id = Number(windowId || 0);
  return !!id && !!cachedWindowId && id === Number(cachedWindowId);
}

export async function isManagerWindowUnfocused(windowId) {
  await loadStoredState();
  if (!isManagerWindowId(windowId)) return false;
  const win = await validateWindow(windowId);
  return !!win && !win.focused;
}

export async function settleManagerWindowOnHolder(reason = "idle") {
  const info = await getManagerWindowInfo().catch(() => null);
  if (!info?.exists || !info.windowId) return false;
  const holder = await ensureHolder(info.windowId).catch(() => null);
  if (!holder?.id) return false;

  // Never activate manager.html just to make it the resting tab. Activation in
  // a hidden window is exactly the kind of browser behavior that has surfaced
  // the playback window on Brave. Observation only.
  try {
    const current = await chrome.tabs.get(holder.id);
    await event(current.active ? "MANAGER_WINDOW_HOLDER_ACTIVE" : "MANAGER_WINDOW_HOLDER_SETTLE_SKIPPED", {
      windowId: info.windowId,
      holderTabId: holder.id,
      reason,
      cause: current.active ? "already_active" : "focus_hard_off_no_activation"
    });
    return !!current.active;
  } catch {
    return false;
  }
}

async function setInternalActiveTab(tabId, action) {
  return withTabEditRetry(
    action,
    () => chrome.tabs.update(Number(tabId), { active: true }),
    { tabId: Number(tabId), windowId: cachedWindowId }
  );
}

async function primeManagedTab(tabId, reason = "startup", options = {}) {
  const info = await getManagerWindowInfo().catch(() => null);
  const id = Number(tabId || 0);
  if (!id || !info?.exists || !info.windowId) return false;

  const now = Date.now();
  if (primingDisabledForSession) {
    await event("MANAGER_TAB_PRIME_SKIPPED", { tabId: id, reason, cause: "disabled_after_focus_breaches" });
    return false;
  }
  if (Number(primingBlockedUntil || 0) > now) {
    await event("MANAGER_TAB_PRIME_SKIPPED", {
      tabId: id, reason, cause: "focus_breach_backoff",
      remainingMs: primingBlockedUntil - now
    });
    return false;
  }

  let tab = null;
  try { tab = await chrome.tabs.get(id); } catch { return false; }
  if (Number(tab.windowId) !== Number(info.windowId)) return false;

  // Never prime while the user is actually looking at the playback window.
  const win = await validateWindow(info.windowId);
  if (!win || win.focused) {
    await event("MANAGER_TAB_PRIME_SKIPPED", { tabId: id, reason, cause: "manager_window_focused" });
    return false;
  }

  const lastPrimeAt = Number(lastPrimeAtByTabId.get(id) || 0);
  if (!options.force && lastPrimeAt && now - lastPrimeAt < PRIME_REPEAT_COOLDOWN_MS) {
    await event("MANAGER_TAB_PRIME_SKIPPED", {
      tabId: id, reason, cause: "tab_prime_cooldown",
      remainingMs: PRIME_REPEAT_COOLDOWN_MS - (now - lastPrimeAt)
    });
    return false;
  }

  const holder = await ensureHolder(info.windowId).catch(() => null);
  if (!holder?.id) return false;

  await makeBackgroundSafe(id).catch(() => false);
  const dwellMs = Math.max(1200, Math.min(6000, Number(options.dwellMs || PRIME_MS) || PRIME_MS));
  const wasAlreadyActive = !!tab.active;
  currentPrimeTabId = id;
  currentPrimeFocusBreached = false;
  lastPrimeAtByTabId.set(id, now);

  try {
    if (!wasAlreadyActive) {
      await setInternalActiveTab(id, "manager_internal_prime_activate");
    }

    await event("MANAGER_TAB_PRIME_START", {
      tabId: id, reason, windowId: info.windowId, dwellMs,
      alreadyActive: wasAlreadyActive,
      focusPolicy: "internal_tab_only_never_windows_update"
    });

    await sleep(dwellMs);

    // Return the hidden manager window to its inert holder tab. This changes
    // only which tab is selected *inside that already-unfocused window*; it
    // never focuses or defocuses a browser window.
    if (Number(holder.id) !== id) {
      await setInternalActiveTab(holder.id, "manager_internal_prime_holder_restore").catch(() => null);
      if (HOLDER_SETTLE_MS) await sleep(HOLDER_SETTLE_MS);
    }

    const after = await validateWindow(info.windowId);
    const breached = !!after?.focused;
    if (breached) {
      if (!currentPrimeFocusBreached) {
        primeFocusBreachCount += 1;
        currentPrimeFocusBreached = true;
      }
      primingBlockedUntil = Date.now() + PRIME_FOCUS_BACKOFF_MS;
      if (primeFocusBreachCount >= 2) primingDisabledForSession = true;
      await event("MANAGER_TAB_PRIME_FOCUS_BREACH", {
        tabId: id, reason, windowId: info.windowId,
        primeFocusBreachCount,
        blockedMs: PRIME_FOCUS_BACKOFF_MS,
        disabledForSession: primingDisabledForSession
      });
    } else {
      await event("MANAGER_TAB_PRIME_FINISH", {
        tabId: id, reason, windowId: info.windowId, dwellMs,
        focusSafe: true
      });
    }
    return true;
  } catch (e) {
    await event("MANAGER_TAB_PRIME_FAILED", { tabId: id, reason, error: String(e) });
    return false;
  } finally {
    if (currentPrimeTabId === id) currentPrimeTabId = null;
    currentPrimeFocusBreached = false;
  }
}

export function queueManagerTabPrime(tabId, reason = "startup", options = {}) {
  const run = async () => primeManagedTab(tabId, reason, options);
  primeChain = primeChain.then(run, run);
  return primeChain;
}

chrome.windows.onFocusChanged.addListener((windowId) => {
  const id = Number(windowId);
  if (!id || id === chrome.windows.WINDOW_ID_NONE) return;

  if (pendingManagerCreate) {
    pendingCreateFocusWindowId = id;
    return;
  }

  if (isManagerWindowId(id)) {
    focusBreachCount += 1;
    lastFocusBreachAt = Date.now();
    if (currentPrimeTabId != null && !currentPrimeFocusBreached) {
      primeFocusBreachCount += 1;
      currentPrimeFocusBreached = true;
      primingBlockedUntil = Date.now() + PRIME_FOCUS_BACKOFF_MS;
      if (primeFocusBreachCount >= 2) primingDisabledForSession = true;
    }
    event("MANAGER_WINDOW_FOCUS_OBSERVED", {
      windowId: id,
      focusBreachCount,
      duringPrime: currentPrimeTabId != null,
      primeTabId: currentPrimeTabId,
      primeFocusBreachCount,
      primingBlockedUntil,
      primingDisabledForSession,
      policy: "observe_only_never_refocus_any_window"
    }).catch(() => {});
    return;
  }

  lastKnownUserWindowId = id;
});

chrome.windows.onRemoved.addListener((windowId) => {
  if (Number(windowId) === Number(lastKnownUserWindowId || 0)) lastKnownUserWindowId = null;
  if (!isManagerWindowId(windowId)) return;
  clearState("window_removed").catch(() => {});
});

T.ensureManagerWindow = ensureManagerWindow;
T.getManagerWindowInfo = getManagerWindowInfo;
T.isManagerWindowId = isManagerWindowId;
T.isManagerWindowUnfocused = isManagerWindowUnfocused;
T.settleManagerWindowOnHolder = settleManagerWindowOnHolder;
T.queueManagerTabPrime = queueManagerTabPrime;

export {
  MANAGER_WINDOW_KEY,
  HOLDER_URL,
  PRIME_MS,
  PRIME_FOCUS_BACKOFF_MS,
  HOLDER_SETTLE_MS,
  FOCUS_GUARD_MS,
  FOCUS_RESTORE_SETTLE_MS
};
