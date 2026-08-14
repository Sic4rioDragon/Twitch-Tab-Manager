export function $(id) {
  return document.getElementById(id);
}

export function normalizeName(value) {
  return String(value || "").trim().toLowerCase();
}

export function uniqNames(list) {
  return [...new Set((list || []).map(normalizeName).filter(Boolean))];
}

export function parseBool(value, fallback) {
  if (value === true || value === false) return value;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (v === "true") return true;
    if (v === "false") return false;
  }
  if (value === undefined || value === null) return fallback;
  return !!value;
}

export function clampConfig(input = {}) {
  const cfg = { ...(input || {}) };

  cfg.live_source = String(cfg.live_source || "auto").trim().toLowerCase() || "auto";
  cfg.client_id = String(cfg.client_id || "");
  cfg.access_token = String(cfg.access_token || "");

  cfg.enabled = parseBool(cfg.enabled, true);
  cfg.force_unmute = parseBool(cfg.force_unmute, true);
  cfg.unmute_streams = parseBool(cfg.unmute_streams, true);
  cfg.force_resume = parseBool(cfg.force_resume, true);
  cfg.autoplay_streams = parseBool(cfg.autoplay_streams, false);
  cfg.soft_wake_tabs = parseBool(cfg.soft_wake_tabs, false);
  cfg.soft_wake_only_when_browser_focused = parseBool(cfg.soft_wake_only_when_browser_focused, true);
  cfg.close_unfollowed_tabs = parseBool(cfg.close_unfollowed_tabs, true);
  cfg.allow_extra_twitch_tabs = parseBool(cfg.allow_extra_twitch_tabs, true);

  cfg.temp_whitelist_hours = Math.max(1, Number(cfg.temp_whitelist_hours || 12) || 12);
  cfg.check_interval_sec = Math.max(10, Number(cfg.check_interval_sec || 60) || 60);
  cfg.max_tabs = Math.max(1, Number(cfg.max_tabs || 4) || 4);

  if (!cfg.temp_whitelist_entries || typeof cfg.temp_whitelist_entries !== "object" || Array.isArray(cfg.temp_whitelist_entries)) {
    cfg.temp_whitelist_entries = {};
  }

  cfg.favorites = uniqNames(cfg.favorites);
  cfg.priority = uniqNames(cfg.priority);
  cfg.follows = uniqNames(cfg.follows);
  cfg.rotation = uniqNames(cfg.rotation);
  cfg.low_priority = uniqNames(cfg.low_priority);
  cfg.blacklist = uniqNames(cfg.blacklist);

  cfg.rotation_enabled = parseBool(cfg.rotation_enabled, false);
  cfg.rotation_interval_min = Math.max(5, Number(cfg.rotation_interval_min || 30) || 30);
  cfg.rotation_slot_count = Math.max(0, Number(cfg.rotation_slot_count || 1) || 1);
  cfg.rotation_cooldown_min = Math.max(5, Number(cfg.rotation_cooldown_min || 30) || 30);
  cfg.rotation_include_low_priority = parseBool(cfg.rotation_include_low_priority, false);

  cfg.streak_rescue_enabled = parseBool(cfg.streak_rescue_enabled, false);
  cfg.streak_rescue_mode = String(cfg.streak_rescue_mode || "detect").toLowerCase() === "auto" ? "auto" : "detect";
  cfg.streak_rescue_slots = 1;
  cfg.streak_rescue_required_watch_min = Math.max(5, Number(cfg.streak_rescue_required_watch_min || 5) || 5);
  cfg.streak_rescue_grace_min = Math.max(0, Number(cfg.streak_rescue_grace_min ?? 10) || 0);
  cfg.streak_rescue_confirm_check_sec = Math.max(15, Number(cfg.streak_rescue_confirm_check_sec || 30) || 30);
  cfg.streak_rescue_retry_min = Math.max(5, Number(cfg.streak_rescue_retry_min || 15) || 15);

  cfg.followUnion = uniqNames([
    ...(cfg.favorites || []),
    ...(cfg.priority || []),
    ...(cfg.follows || []),
    ...(cfg.rotation || []),
    ...(cfg.low_priority || [])
  ]);

  return cfg;
}

function pickObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

export function getLegacyFlatConfig(bag = {}) {
  return {
    enabled: bag.enabled,
    live_source: bag.live_source,
    client_id: bag.client_id,
    access_token: bag.access_token,
    force_unmute: bag.force_unmute,
    unmute_streams: bag.unmute_streams,
    force_resume: bag.force_resume,
    autoplay_streams: bag.autoplay_streams,
    soft_wake_tabs: bag.soft_wake_tabs,
    soft_wake_only_when_browser_focused: bag.soft_wake_only_when_browser_focused,
    close_unfollowed_tabs: bag.close_unfollowed_tabs,
    allow_extra_twitch_tabs: bag.allow_extra_twitch_tabs,
    temp_whitelist_hours: bag.temp_whitelist_hours,
    temp_whitelist_entries: bag.temp_whitelist_entries,
    check_interval_sec: bag.check_interval_sec,
    max_tabs: bag.max_tabs,
    follows: Array.isArray(bag.follows) ? bag.follows : [],
    priority: Array.isArray(bag.priority) ? bag.priority : [],
    followUnion: Array.isArray(bag.followUnion) ? bag.followUnion : [],
    blacklist: Array.isArray(bag.blacklist) ? bag.blacklist : [],
    favorites: Array.isArray(bag.favorites) ? bag.favorites : [],
    rotation: Array.isArray(bag.rotation) ? bag.rotation : [],
    low_priority: Array.isArray(bag.low_priority) ? bag.low_priority : [],
    rotation_enabled: bag.rotation_enabled,
    rotation_interval_min: bag.rotation_interval_min,
    rotation_slot_count: bag.rotation_slot_count,
    rotation_cooldown_min: bag.rotation_cooldown_min,
    rotation_include_low_priority: bag.rotation_include_low_priority,
    streak_rescue_enabled: bag.streak_rescue_enabled,
    streak_rescue_mode: bag.streak_rescue_mode,
    streak_rescue_slots: bag.streak_rescue_slots,
    streak_rescue_required_watch_min: bag.streak_rescue_required_watch_min,
    streak_rescue_grace_min: bag.streak_rescue_grace_min,
    streak_rescue_confirm_check_sec: bag.streak_rescue_confirm_check_sec,
    streak_rescue_retry_min: bag.streak_rescue_retry_min,
  };
}

export function getStoredConfig(bag = {}) {
  const legacy = getLegacyFlatConfig(bag);
  const nestedSources = [
    pickObject(bag.ttm_settings_v1),
    pickObject(bag.config),
    pickObject(bag.settings)
  ].filter(Boolean);

  return clampConfig(Object.assign({}, legacy, ...nestedSources));
}

export async function readStorageFallback() {
  try {
    return await chrome.storage.local.get([
      "settings",
      "config",
      "ttm_settings_v1",
      "enabled",
      "live_source",
      "max_tabs",
      "follows",
      "priority",
      "followUnion",
      "blacklist",
      "ttm_last_update_notified_version",
      "ttm_last_poll_at",
      "ttm_last_poll_status",
      "favorites",
      "rotation",
      "low_priority",
      "rotation_enabled",
      "rotation_interval_min",
      "rotation_slot_count",
      "rotation_cooldown_min",
      "rotation_include_low_priority",
      "streak_rescue_enabled",
      "streak_rescue_mode",
      "streak_rescue_slots",
      "streak_rescue_required_watch_min",
      "streak_rescue_grace_min",
      "streak_rescue_confirm_check_sec",
      "streak_rescue_retry_min",
    ]);
  } catch {
    return {};
  }
}

export async function backupCurrentBrowserConfig(reason = "popup_edit") {
  try {
    const bag = await chrome.storage.local.get(null);
    const cfg = getStoredConfig(bag);

    const snapshot = {
      saved_at: new Date().toISOString(),
      reason,
      summary: {
        follows_count: cfg.follows.length,
        priority_count: cfg.priority.length,
        blacklist_count: cfg.blacklist.length,
        has_client_id: !!cfg.client_id,
        has_access_token: !!cfg.access_token
      },
      settings: cfg
    };

    const keyLast = "ttm_backup_last_good_config_v2";
    const keyHistory = "ttm_backup_history_v2";
    const got = await chrome.storage.local.get([keyHistory]);
    const history = Array.isArray(got[keyHistory]) ? got[keyHistory] : [];

    history.push(snapshot);
    while (history.length > 25) history.shift();

    await chrome.storage.local.set({
      [keyLast]: snapshot,
      [keyHistory]: history
    });
  } catch {}
}

export async function writeConfigEverywhere(cfg) {
  const clean = clampConfig(cfg);

  await chrome.storage.local.set({
    settings: clean,
    config: clean,
    ttm_settings_v1: clean,
    enabled: clean.enabled,
    live_source: clean.live_source,
    client_id: clean.client_id,
    access_token: clean.access_token,
    force_unmute: clean.force_unmute,
    unmute_streams: clean.unmute_streams,
    force_resume: clean.force_resume,
    autoplay_streams: clean.autoplay_streams,
    soft_wake_tabs: clean.soft_wake_tabs,
    soft_wake_only_when_browser_focused: clean.soft_wake_only_when_browser_focused,
    close_unfollowed_tabs: clean.close_unfollowed_tabs,
    allow_extra_twitch_tabs: clean.allow_extra_twitch_tabs,
    temp_whitelist_hours: clean.temp_whitelist_hours,
    temp_whitelist_entries: clean.temp_whitelist_entries,
    check_interval_sec: clean.check_interval_sec,
    max_tabs: clean.max_tabs,
    follows: clean.follows,
    priority: clean.priority,
    followUnion: clean.followUnion,
    blacklist: clean.blacklist,
    follows_count: clean.follows.length,
    priority_count: clean.priority.length,
    followUnion_count: clean.followUnion.length,
    favorites: clean.favorites,
  rotation: clean.rotation,
  low_priority: clean.low_priority,
  rotation_enabled: clean.rotation_enabled,
  rotation_interval_min: clean.rotation_interval_min,
  rotation_slot_count: clean.rotation_slot_count,
  rotation_cooldown_min: clean.rotation_cooldown_min,
  rotation_include_low_priority: clean.rotation_include_low_priority,
  streak_rescue_enabled: clean.streak_rescue_enabled,
  streak_rescue_mode: clean.streak_rescue_mode,
  streak_rescue_slots: clean.streak_rescue_slots,
  streak_rescue_required_watch_min: clean.streak_rescue_required_watch_min,
  streak_rescue_grace_min: clean.streak_rescue_grace_min,
  streak_rescue_confirm_check_sec: clean.streak_rescue_confirm_check_sec,
  streak_rescue_retry_min: clean.streak_rescue_retry_min
  });

  return clean;
}

export function send(type, payload) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type, ...(payload || {}) }, (resp) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(resp || null);
      });
    } catch (e) {
      resolve({ ok: false, error: String(e) });
    }
  });
}

export function formatPollTime(ts) {
  if (!ts) return "—";

  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "—";

  const now = Date.now();
  const diffMs = Math.max(0, now - date.getTime());
  const diffSec = Math.floor(diffMs / 1000);

  let ago = "";
  if (diffSec < 10) ago = "just now";
  else if (diffSec < 60) ago = `${diffSec}s ago`;
  else if (diffSec < 3600) ago = `${Math.floor(diffSec / 60)}m ago`;
  else ago = `${Math.floor(diffSec / 3600)}h ago`;

  return `${date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} (${ago})`;
}

export function getChannelFromUrl(url = "") {
  try {
    const u = new URL(url);
    if (!/^(www\.)?twitch\.tv$/i.test(u.hostname)) return "";
    const first = u.pathname.replace(/^\/+/, "").split("/")[0] || "";
    if (!first) return "";
    if ([
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
    ].includes(first.toLowerCase())) {
      return "";
    }
    return first.toLowerCase();
  } catch {
    return "";
  }
}

export async function getActiveTabChannel() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const channel = getChannelFromUrl(tab?.url || tab?.pendingUrl || "");
    return { tab, channel };
  } catch {
    return { tab: null, channel: "" };
  }
}