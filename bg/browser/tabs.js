import { event } from "../events.js";

const TAB_EDIT_RETRY_DELAYS_MS = [120, 300, 650, 1200];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isTransientTabEditError(error) {
  const text = String(error?.message || error || "");
  return /tabs cannot be edited right now|user may be dragging a tab/i.test(text);
}

export async function withTabEditRetry(action, operation, detail = {}) {
  let lastError = null;

  for (let attempt = 0; attempt <= TAB_EDIT_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isTransientTabEditError(error) || attempt >= TAB_EDIT_RETRY_DELAYS_MS.length) throw error;

      const delayMs = TAB_EDIT_RETRY_DELAYS_MS[attempt];
      await event("TAB_EDIT_BUSY_RETRY", {
        action: String(action || "tab_operation"),
        attempt: attempt + 1,
        delayMs,
        error: String(error),
        ...(detail || {})
      });
      await sleep(delayMs);
    }
  }

  throw lastError || new Error("tab_edit_retry_failed");
}

// All AUTOMATIC browser-level tab operations go through this module.
// Hard invariant: these helpers never request tab activation or window focus.

async function tabActivity(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    return {
      active: !!tab?.active,
      windowId: tab?.windowId ?? null,
      url: tab?.url || tab?.pendingUrl || ""
    };
  } catch {
    return null;
  }
}

async function auditUnexpectedActivation(tabId, action, before = null) {
  const after = await tabActivity(tabId);
  if (!after) return;
  if (before?.active === false && after.active === true) {
    await event("BACKGROUND_TAB_UNEXPECTEDLY_ACTIVATED", {
      tabId,
      action,
      before,
      after,
      reverted: false
    });
  }
}

export async function createBackgroundTab(url, opts = {}) {
  const create = {
    url: String(url),
    active: false
  };
  if (Number.isInteger(opts.windowId)) create.windowId = opts.windowId;
  if (Number.isInteger(opts.index)) create.index = opts.index;
  if (Number.isInteger(opts.openerTabId)) create.openerTabId = opts.openerTabId;

  const tab = await withTabEditRetry("create_background_tab", () => chrome.tabs.create(create), {
    url: create.url,
    windowId: create.windowId ?? null
  });
  if (tab?.id != null) {
    try { await chrome.tabs.update(tab.id, { autoDiscardable: false }); } catch {}
    await event("TAB_CREATE_BG", {
      tabId: tab.id,
      url: create.url,
      windowId: tab.windowId,
      returnedActive: !!tab.active
    });
    if (tab.active) {
      await event("BACKGROUND_TAB_UNEXPECTEDLY_ACTIVATED", {
        tabId: tab.id,
        action: "create",
        before: { active: false },
        after: { wasActive: true, windowId: tab.windowId, url: tab.url || create.url },
        reverted: false
      });
    }
  }
  return tab;
}

export async function navigateBackgroundTab(tabId, url) {
  if (tabId == null) throw new Error("missing_tab_id");
  const before = await tabActivity(tabId);
  const tab = await withTabEditRetry(
    "navigate_background_tab",
    () => chrome.tabs.update(tabId, {
      url: String(url),
      autoDiscardable: false
    }),
    { tabId, url: String(url) }
  );
  await event("TAB_NAVIGATE_BG", { tabId, url: String(url), beforeActive: before?.active ?? null });
  await auditUnexpectedActivation(tabId, "navigate", before);
  return tab;
}

export async function reloadBackgroundTab(tabId, reason = "recovery") {
  if (tabId == null) return false;
  const before = await tabActivity(tabId);
  try {
    await withTabEditRetry(
      "reload_policy_update",
      () => chrome.tabs.update(tabId, { autoDiscardable: false }),
      { tabId, reason }
    );
    await withTabEditRetry(
      "reload_background_tab",
      () => chrome.tabs.reload(tabId),
      { tabId, reason }
    );
    await event("TAB_RELOAD_BG", { tabId, reason, beforeActive: before?.active ?? null });
    await auditUnexpectedActivation(tabId, "reload", before);
    return true;
  } catch (e) {
    await event("TAB_RELOAD_FAILED", { tabId, reason, error: String(e) });
    return false;
  }
}

function isMissingTabError(error) {
  const text = String(error?.message || error || "");
  return /no tab with id|invalid tab id|tab not found|cannot find tab/i.test(text);
}

export async function makeBackgroundSafe(tabId, { muted = null } = {}) {
  if (tabId == null) return false;

  // This policy is deliberately non-destructive: it only asks Chromium not to
  // auto-discard the tab. It must never activate the tab, focus its window, or
  // alter the user's browser mute state.
  const patch = { autoDiscardable: false };

  // Keep the legacy argument accepted for compatibility, but intentionally do
  // not apply it. TTM must preserve the tab's existing mute/unmute state.
  void muted;

  try {
    await withTabEditRetry(
      "background_tab_policy",
      () => chrome.tabs.update(tabId, patch),
      { tabId }
    );
    return true;
  } catch (error) {
    if (isMissingTabError(error)) {
      // Normal race: the tab may have ended/rotated/closed while an async
      // background policy request was still queued.
      await event("BACKGROUND_TAB_POLICY_TAB_GONE", {
        tabId,
        error: String(error)
      });
      return true;
    }

    if (isTransientTabEditError(error)) {
      // We already exhausted the short retry window. The policy is optional;
      // a later watchdog/reconcile pass can retry without turning this into a
      // Chrome extension error or breaking stream management.
      await event("BACKGROUND_TAB_POLICY_BUSY_SKIPPED", {
        tabId,
        error: String(error)
      });
      return true;
    }

    await event("BACKGROUND_TAB_POLICY_FAILED", {
      tabId,
      error: String(error)
    });
    return false;
  }
}

export async function closeBackgroundTab(tabId, reason = "manager_close") {
  if (tabId == null) return false;
  try {
    await withTabEditRetry(
      "close_background_tab",
      () => chrome.tabs.remove(tabId),
      { tabId, reason }
    );
    await event("TAB_CLOSE", { tabId, reason });
    return true;
  } catch (error) {
    if (isMissingTabError(error)) return true;
    await event("TAB_CLOSE_FAILED", { tabId, reason, error: String(error) });
    return false;
  }
}
