import { $, cfgTA, folTA, parseBool, uniqNames } from "./core.js";
import { fillQuickSettings } from "./quick-settings.js";
import { renderTokenSnippets } from "./tokens.js";

export const CFG_DEFAULT = {
  live_source: "auto",
  client_id: "",
  access_token: "",
  force_unmute: true,
  unmute_streams: true,
  force_resume: true,
  autoplay_streams: false,
  soft_wake_tabs: false,
  soft_wake_only_when_browser_focused: true,
  close_unfollowed_tabs: true,
  allow_extra_twitch_tabs: true,
  temp_whitelist_hours: 12,
  temp_whitelist_entries: {},
  check_interval_sec: 60,
  max_tabs: 4,
  enabled: true,
  favorites: [],
  priority: [],
  follows: [],
  rotation: [],
  low_priority: [],
  blacklist: [],

  rotation_enabled: false,
  rotation_interval_min: 30,
  rotation_slot_count: 1,
  rotation_cooldown_min: 30,
  rotation_include_low_priority: false,

  streak_rescue_enabled: false,
  streak_rescue_mode: "detect",
  streak_rescue_slots: 1,
  streak_rescue_required_watch_min: 5,
  streak_rescue_grace_min: 10,
  streak_rescue_confirm_check_sec: 30,
  streak_rescue_retry_min: 15
};

const BACKUP_HISTORY_KEY = "ttm_backup_history_v2";
const BACKUP_LAST_KEY = "ttm_backup_last_good_config_v2";
const BACKUP_LIMIT = 25;

export function mergeDefaults(input) {
  return { ...CFG_DEFAULT, ...(input || {}) };
}

export function clampConfig(input) {
  const cfg = mergeDefaults(input);

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

  if (!cfg.temp_whitelist_entries || typeof cfg.temp_whitelist_entries !== "object" || Array.isArray(cfg.temp_whitelist_entries)) {
    cfg.temp_whitelist_entries = {};
  }

  cfg.check_interval_sec = Math.max(10, Number(cfg.check_interval_sec || 60) || 60);
  cfg.max_tabs = Math.max(1, Number(cfg.max_tabs || 4) || 4);

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

function getLegacyFlatConfig(bag = {}) {
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
    follows: Array.isArray(bag.follows) ? bag.follows : [],
    priority: Array.isArray(bag.priority) ? bag.priority : [],
    followUnion: Array.isArray(bag.followUnion) ? bag.followUnion : [],
    blacklist: Array.isArray(bag.blacklist) ? bag.blacklist : []
  };
}

export function browserBagHasMeaningfulConfig(bag = {}) {
  const nested =
    pickObject(bag.settings) ||
    pickObject(bag.config) ||
    pickObject(bag.ttm_settings_v1) ||
    {};

  const legacy = getLegacyFlatConfig(bag);

  const listHasData =
    (Array.isArray(nested.follows) && nested.follows.length > 0) ||
    (Array.isArray(nested.priority) && nested.priority.length > 0) ||
    (Array.isArray(nested.blacklist) && nested.blacklist.length > 0) ||
    (Array.isArray(legacy.follows) && legacy.follows.length > 0) ||
    (Array.isArray(legacy.priority) && legacy.priority.length > 0) ||
    (Array.isArray(legacy.blacklist) && legacy.blacklist.length > 0);

  const scalarHasData = [
    nested.client_id,
    nested.access_token,
    nested.live_source,
    nested.check_interval_sec,
    nested.max_tabs,
    legacy.client_id,
    legacy.access_token,
    legacy.live_source,
    legacy.check_interval_sec,
    legacy.max_tabs,
    nested.favorites,
    nested.rotation,
    nested.low_priority,
    legacy.favorites,
    legacy.rotation,
    legacy.low_priority
  ].some((v) => v !== undefined && v !== null && String(v) !== "");

  return listHasData || scalarHasData;
}

export async function readStorage() {
  try {
    return await chrome.storage.local.get(null);
  } catch {
    return {};
  }
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

export async function packagedConfig() {
  try {
    const url = chrome.runtime.getURL("config.json");
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return clampConfig(CFG_DEFAULT);
    return clampConfig(await res.json());
  } catch {
    return clampConfig(CFG_DEFAULT);
  }
}

export async function packagedFollows() {
  try {
    const url = chrome.runtime.getURL("follows.txt");
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return [];
    const text = await res.text();
    return uniqNames(text.split(/\r?\n/));
  } catch {
    return [];
  }
}

function buildSnapshot(cfg, reason = "manual") {
  const clean = clampConfig(cfg);

  return {
    saved_at: new Date().toISOString(),
    reason,
    summary: {
      follows_count: clean.follows.length,
      priority_count: clean.priority.length,
      blacklist_count: clean.blacklist.length,
      has_client_id: !!clean.client_id,
      has_access_token: !!clean.access_token,
      live_source: clean.live_source,
      enabled: clean.enabled,
      max_tabs: clean.max_tabs,
      check_interval_sec: clean.check_interval_sec
    },
    settings: clean
  };
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

export async function listStoredBackups() {
  const got = await chrome.storage.local.get([BACKUP_HISTORY_KEY, BACKUP_LAST_KEY]);
  return {
    last: got[BACKUP_LAST_KEY] || null,
    history: Array.isArray(got[BACKUP_HISTORY_KEY]) ? got[BACKUP_HISTORY_KEY] : []
  };
}

export async function pushBackupSnapshot(snapshot) {
  if (!snapshot?.settings) return null;

  const got = await chrome.storage.local.get([BACKUP_HISTORY_KEY, BACKUP_LAST_KEY]);
  const history = Array.isArray(got[BACKUP_HISTORY_KEY]) ? got[BACKUP_HISTORY_KEY] : [];
  const last = got[BACKUP_LAST_KEY] || null;

  const currentSig = stableStringify(snapshot.settings);
  const lastSig = last?.settings ? stableStringify(last.settings) : "";

  if (currentSig === lastSig) {
    return last;
  }

  history.push(snapshot);
  while (history.length > BACKUP_LIMIT) history.shift();

  await chrome.storage.local.set({
    [BACKUP_LAST_KEY]: snapshot,
    [BACKUP_HISTORY_KEY]: history
  });

  return snapshot;
}

export async function backupCurrentBrowserConfig(reason = "manual_backup") {
  const bag = await readStorage();
  if (!browserBagHasMeaningfulConfig(bag)) return null;

  const cfg = getStoredConfig(bag);
  return pushBackupSnapshot(buildSnapshot(cfg, reason));
}

export async function restoreBackupByIndex(index = -1) {
  const { history, last } = await listStoredBackups();
  const chosen = index === -1 ? (last || history[history.length - 1] || null) : history[index] || null;

  if (!chosen?.settings) {
    throw new Error("No backup found to restore.");
  }

  return writeConfigEverywhere(chosen.settings, {
    reason: "restore_backup",
    skipPreBackup: true
  });
}

export async function writeConfigEverywhere(cfg, { reason = "manual_save", skipPreBackup = false } = {}) {
  const clean = clampConfig(cfg);

  if (!skipPreBackup) {
    await backupCurrentBrowserConfig(`before_${reason}`);
  }

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
    streak_rescue_retry_min: clean.streak_rescue_retry_min,
    followUnion: clean.followUnion,
    blacklist: clean.blacklist,
    follows_count: clean.follows.length,
    priority_count: clean.priority.length,
    followUnion_count: clean.followUnion.length
  });

  await pushBackupSnapshot(buildSnapshot(clean, `after_${reason}`));
  return clean;
}

export async function loadUI() {
  const bag = await readStorage();
  const hasBrowserConfig = browserBagHasMeaningfulConfig(bag);

  let cfg;
  let follows;
  let priority;

  if (hasBrowserConfig) {
    cfg = getStoredConfig(bag);
    follows = uniqNames(Array.isArray(bag.follows) ? bag.follows : cfg.follows);
    priority = uniqNames(Array.isArray(bag.priority) ? bag.priority : cfg.priority);
  } else {
    cfg = await packagedConfig();
    follows = await packagedFollows();
    priority = uniqNames(cfg.priority);
  }

  const fullCfg = clampConfig({
    ...cfg,
    follows,
    priority,
    followUnion: uniqNames([
      ...(cfg.favorites || []),
      ...priority,
      ...follows,
      ...(cfg.rotation || []),
      ...(cfg.low_priority || [])
    ])
  });

  if (cfgTA()) cfgTA().value = JSON.stringify(fullCfg, null, 2);
  if (folTA()) folTA().value = fullCfg.follows.join("\n");
  if ($("#priorityBox")) $("#priorityBox").value = fullCfg.priority.join("\n");
  if ($("#blacklistBox")) $("#blacklistBox").value = fullCfg.blacklist.join("\n");

  fillQuickSettings(fullCfg);
  renderTokenSnippets();

  return fullCfg;
}