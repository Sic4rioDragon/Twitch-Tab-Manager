import { state, saveSettings, log } from "./core.js";

const T = (globalThis.TTM = globalThis.TTM || {});

const BACKUP_HISTORY_KEY = "ttm_backup_history_v2";
const BACKUP_LAST_KEY = "ttm_backup_last_good_config_v2";
const BACKUP_LIMIT = 25;

function parseBool(value, fallback) {
  if (value === true || value === false) return value;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (v === "true") return true;
    if (v === "false") return false;
  }
  if (value === undefined || value === null) return fallback;
  return !!value;
}

function normalizeName(value) {
  return String(value || "").trim().toLowerCase();
}

function uniqNames(list) {
  return [...new Set((list || []).map(normalizeName).filter(Boolean))];
}

function clampSettings(raw) {
  const cfg = { ...(raw || {}) };

  cfg.live_source = String(cfg.live_source || "auto").trim().toLowerCase() || "auto";

  cfg.enabled = parseBool(cfg.enabled, true);
  cfg.check_interval_sec = Math.max(10, Number(cfg.check_interval_sec || 60) || 60);
  cfg.max_tabs = Math.max(1, Number(cfg.max_tabs || 4) || 4);

  cfg.force_unmute = parseBool(cfg.force_unmute, false);
  cfg.unmute_streams = parseBool(cfg.unmute_streams, false);
  cfg.force_resume = parseBool(cfg.force_resume, false);
  cfg.autoplay_streams = parseBool(cfg.autoplay_streams, false);
  cfg.soft_wake_tabs = parseBool(cfg.soft_wake_tabs, false);
  cfg.soft_wake_only_when_browser_focused = parseBool(cfg.soft_wake_only_when_browser_focused, true);

  cfg.close_unfollowed_tabs = parseBool(cfg.close_unfollowed_tabs, true);
  cfg.allow_extra_twitch_tabs = parseBool(cfg.allow_extra_twitch_tabs, true);
  cfg.temp_whitelist_hours = Math.max(1, Number(cfg.temp_whitelist_hours || 12) || 12);

  if (
    !cfg.temp_whitelist_entries ||
    typeof cfg.temp_whitelist_entries !== "object" ||
    Array.isArray(cfg.temp_whitelist_entries)
  ) {
    cfg.temp_whitelist_entries = {};
  }

  cfg.client_id = String(cfg.client_id || "");
  cfg.access_token = String(cfg.access_token || "");

  cfg.favorites = normalizeBucketList(cfg.favorites);
  cfg.priority = normalizeBucketList(cfg.priority);
  cfg.follows = normalizeBucketList(cfg.follows);
  cfg.rotation = normalizeBucketList(cfg.rotation);
  cfg.low_priority = normalizeBucketList(cfg.low_priority);
  cfg.blacklist = normalizeBucketList(cfg.blacklist);

  cfg.rotation_enabled = parseBool(cfg.rotation_enabled, false);
  cfg.rotation_interval_min = Math.max(5, Number(cfg.rotation_interval_min || 30) || 30);
  cfg.rotation_slot_count = Math.max(0, Number(cfg.rotation_slot_count || 1) || 1);
  cfg.rotation_cooldown_min = Math.max(5, Number(cfg.rotation_cooldown_min || 30) || 30);
  cfg.rotation_include_low_priority = parseBool(cfg.rotation_include_low_priority, false);

  cfg.streak_rescue_enabled = parseBool(cfg.streak_rescue_enabled, false);
  cfg.streak_rescue_detect_only_explicit = parseBool(cfg.streak_rescue_detect_only_explicit, false);
  cfg.streak_rescue_mode = String(cfg.streak_rescue_mode || "auto").toLowerCase() === "detect" ? "detect" : "auto";
  if (cfg.streak_rescue_enabled && cfg.streak_rescue_mode === "detect" && !cfg.streak_rescue_detect_only_explicit) {
    log("streak_rescue_mode_migrated_to_auto", { reason: "legacy_implicit_detect_only" });
    cfg.streak_rescue_mode = "auto";
  }
  if (cfg.streak_rescue_mode === "auto") cfg.streak_rescue_detect_only_explicit = false;
  cfg.streak_rescue_slots = 1;
  cfg.streak_rescue_required_watch_min = Math.max(5, Number(cfg.streak_rescue_required_watch_min || 5) || 5);
  cfg.streak_rescue_grace_min = Math.max(0, Number(cfg.streak_rescue_grace_min ?? 10) || 0);
  cfg.streak_rescue_confirm_check_sec = Math.max(15, Number(cfg.streak_rescue_confirm_check_sec || 30) || 30);
  cfg.streak_rescue_retry_min = Math.max(5, Number(cfg.streak_rescue_retry_min || 15) || 15);

  const conflicts = validateExclusiveBuckets(cfg);
  if (conflicts.length > 0) {
    log("config_bucket_conflicts_resolved", { conflicts });
  }
  resolveExclusiveBuckets(cfg);

  cfg.followUnion = buildFollowUnion(cfg);
  cfg.temp_whitelist_entries = pruneTempWhitelistEntries(cfg);

  return cfg;
}

function redactForDiag(input = {}) {
  const value = JSON.parse(JSON.stringify(input || {}));
  const redactKeys = new Set([
    "client_id",
    "access_token",
    "client_secret",
    "oauth_token",
    "token"
  ]);

  function walk(obj) {
    if (!obj || typeof obj !== "object") return;

    for (const key of Object.keys(obj)) {
      if (redactKeys.has(key)) {
        const raw = obj[key];
        if (typeof raw === "string" && raw.length > 8) {
          obj[key] = `${raw.slice(0, 4)}…REDACTED…${raw.slice(-2)}`;
        } else if (raw != null) {
          obj[key] = "REDACTED";
        }
        continue;
      }

      walk(obj[key]);
    }
  }

  walk(value);
  return value;
}

function pickObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function buildLegacyFlatConfig(bag = {}) {
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
    streak_rescue_detect_only_explicit: bag.streak_rescue_detect_only_explicit,
    streak_rescue_slots: bag.streak_rescue_slots,
    streak_rescue_required_watch_min: bag.streak_rescue_required_watch_min,
    streak_rescue_grace_min: bag.streak_rescue_grace_min,
    streak_rescue_confirm_check_sec: bag.streak_rescue_confirm_check_sec,
    streak_rescue_retry_min: bag.streak_rescue_retry_min,
  };
}

function hasMeaningfulBrowserConfig(bag = {}) {
  const nested =
    pickObject(bag.settings) ||
    pickObject(bag.config) ||
    pickObject(bag.ttm_settings_v1) ||
    {};

  const legacy = buildLegacyFlatConfig(bag);

  const listHasData = [
    nested.favorites, nested.priority, nested.follows, nested.rotation, nested.low_priority, nested.blacklist,
    legacy.favorites, legacy.priority, legacy.follows, legacy.rotation, legacy.low_priority, legacy.blacklist
  ].some((v) => Array.isArray(v) && v.length > 0);

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
    legacy.max_tabs
  ].some((v) => v !== undefined && v !== null && String(v) !== "");

  return listHasData || scalarHasData;
}

function buildMergedBrowserConfig(bag = {}) {
  const legacy = buildLegacyFlatConfig(bag);

  const nestedSources = [
    pickObject(bag.ttm_settings_v1),
    pickObject(bag.config),
    pickObject(bag.settings)
  ].filter(Boolean);

  return clampSettings(Object.assign({}, legacy, ...nestedSources));
}

function buildSnapshot(cfg, reason = "background_load_seen") {
  const clean = clampSettings(cfg);

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

async function pushBackupSnapshot(snapshot) {
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

function normalizeBucketList(list) {
  return uniqNames(list);
}

function getBucketNames() {
  // `follows` is the base Twitch-follow list and may overlap with exactly one
  // special bucket. Only special buckets are mutually exclusive.
  return ["favorites", "priority", "rotation", "low_priority", "blacklist"];
}

function findChannelBucket(channel, cfg) {
  const ch = normalizeName(channel);
  if (!ch) return "";

  for (const bucket of getBucketNames()) {
    const list = Array.isArray(cfg?.[bucket]) ? cfg[bucket] : [];
    if (list.includes(ch)) return bucket;
  }

  return "";
}

function validateExclusiveBuckets(cfg) {
  const seen = new Map();
  const conflicts = [];

  for (const bucket of getBucketNames()) {
    const list = normalizeBucketList(cfg?.[bucket]);
    for (const ch of list) {
      if (seen.has(ch)) {
        conflicts.push({
          channel: ch,
          first: seen.get(ch),
          second: bucket
        });
      } else {
        seen.set(ch, bucket);
      }
    }
  }

  return conflicts;
}

function resolveExclusiveBuckets(cfg) {
  // Follows is the base Twitch-follow list and may overlap with one special
  // classification. Blacklist always wins; then Favorite > Priority > Rotation
  // > Low Priority. This also repairs older configs that accumulated overlaps.
  const taken = new Set();
  for (const bucket of ["blacklist", "favorites", "priority", "rotation", "low_priority"]) {
    const next = [];
    for (const ch of normalizeBucketList(cfg?.[bucket])) {
      if (taken.has(ch)) continue;
      taken.add(ch);
      next.push(ch);
    }
    cfg[bucket] = next;
  }
  return cfg;
}

function buildFollowUnion(cfg) {
  return uniqNames([
    ...(cfg.favorites || []),
    ...(cfg.priority || []),
    ...(cfg.follows || []),
    ...(cfg.rotation || []),
    ...(cfg.low_priority || [])
  ]);
}

function getConfiguredNameSet(cfg) {
  return new Set(uniqNames([
    ...(cfg.favorites || []),
    ...(cfg.priority || []),
    ...(cfg.follows || []),
    ...(cfg.rotation || []),
    ...(cfg.low_priority || []),
    ...(cfg.blacklist || [])
  ]));
}

function pruneTempWhitelistEntries(cfg) {
  const entries = cfg?.temp_whitelist_entries && typeof cfg.temp_whitelist_entries === "object"
    ? cfg.temp_whitelist_entries
    : {};
  const configured = getConfiguredNameSet(cfg || {});
  const now = Date.now();
  const out = {};
  const removed = [];

  for (const [raw, rawExpiry] of Object.entries(entries)) {
    const login = normalizeName(raw);
    const expiry = Number(rawExpiry || 0);
    let reason = "";
    if (!login) reason = "invalid";
    else if (!Number.isFinite(expiry) || expiry <= now) reason = "expired";
    else if (configured.has(login)) reason = "now_configured";

    if (reason) removed.push({ login: login || raw, reason });
    else out[login] = expiry;
  }

  if (removed.length) log("temp_whitelist_pruned", { removed });
  return out;
}

async function writeConfigMirrorsVerified(cfg) {
  const clean = clampSettings(cfg);
  const payload = {
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
    streak_rescue_detect_only_explicit: clean.streak_rescue_detect_only_explicit,
    streak_rescue_slots: clean.streak_rescue_slots,
    streak_rescue_required_watch_min: clean.streak_rescue_required_watch_min,
    streak_rescue_grace_min: clean.streak_rescue_grace_min,
    streak_rescue_confirm_check_sec: clean.streak_rescue_confirm_check_sec,
    streak_rescue_retry_min: clean.streak_rescue_retry_min,
    follows_count: clean.follows.length,
    priority_count: clean.priority.length,
    followUnion_count: clean.followUnion.length
  };

  await chrome.storage.local.set(payload);
  const verify = await chrome.storage.local.get("ttm_settings_v1");
  const written = clampSettings(verify.ttm_settings_v1 || {});
  if (stableStringify(written) !== stableStringify(clean)) {
    throw new Error("config_write_verification_failed");
  }
  return clean;
}

async function backupCurrentBrowserConfig(reason = "background_load_seen") {
  const bag = await chrome.storage.local.get(null);
  if (!hasMeaningfulBrowserConfig(bag)) return null;

  const merged = buildMergedBrowserConfig(bag);
  return pushBackupSnapshot(buildSnapshot(merged, reason));
}

async function loadSettings() {
  const bag = await chrome.storage.local.get(null);
  const hadMeaningfulBrowserConfig = hasMeaningfulBrowserConfig(bag);
  let merged = null;
  let recoveredFromBackup = false;

  if (hadMeaningfulBrowserConfig) {
    merged = buildMergedBrowserConfig(bag);
  } else {
    const history = Array.isArray(bag[BACKUP_HISTORY_KEY]) ? bag[BACKUP_HISTORY_KEY] : [];
    const candidate = bag[BACKUP_LAST_KEY] || history[history.length - 1] || null;
    if (candidate?.settings && hasMeaningfulBrowserConfig({ ttm_settings_v1: candidate.settings })) {
      merged = clampSettings(candidate.settings);
      recoveredFromBackup = true;
      log("config_recovered_from_backup", { saved_at: candidate.saved_at || null, reason: candidate.reason || "backup" });
    } else {
      merged = clampSettings(state.settings);
      log("config_load_found_no_meaningful_browser_config", {});
    }
  }

  state.settings = clampSettings({ ...state.settings, ...merged });

  if (hadMeaningfulBrowserConfig) {
    await pushBackupSnapshot(buildSnapshot(state.settings, "background_load_seen"));
  }

  // Always mirror the validated/pruned configuration. This is especially
  // important for expiring temporary whitelist entries and backup recovery.
  if (hadMeaningfulBrowserConfig || recoveredFromBackup) {
    try {
      state.settings = await writeConfigMirrorsVerified(state.settings);
      await saveSettings(state.settings);
    } catch (e) {
      log("config_mirror_write_error", { error: String(e) });
    }
  }

  log("config_loaded", {
    hadMeaningfulBrowserConfig,
    recoveredFromBackup,
    settings: redactForDiag(state.settings)
  });

  return state.settings;
}

async function recordPollMeta(status, extra = {}) {
  try {
    await chrome.storage.local.set({
      ttm_last_poll_at: Date.now(),
      ttm_last_poll_status: status,
      ...extra
    });
  } catch {}
}

function getVersionText() {
  try {
    return chrome.runtime.getManifest()?.version || "unknown";
  } catch {
    return "unknown";
  }
}

async function maybeShowUpdateNotification(details) {
  if (!details || details.reason !== "update") return;

  const version = getVersionText();
  const fromVersion = details.previousVersion || "older version";

  try {
    const bag = await chrome.storage.local.get(["ttm_last_update_notified_version"]);
    if (bag.ttm_last_update_notified_version === version) return;

    await chrome.notifications.create(`ttm-update-${version}`, {
      type: "basic",
      iconUrl: "icons/icon192.png",
      title: "Twitch Tab Manager updated",
      message: `Extension got updated to ${version}. Open Options → Features to review the current feature set and recent updates.`
    });

    await chrome.storage.local.set({
      ttm_last_update_notified_version: version
    });

    log("update_notification_shown", { version, fromVersion });
  } catch (e) {
    log("update_notification_failed", { error: String(e), version, fromVersion });
  }
}

T.parseBool = parseBool;
T.normalizeName = normalizeName;
T.uniqNames = uniqNames;
T.clampSettings = clampSettings;
T.redactForDiag = redactForDiag;
T.loadSettings = loadSettings;
T.recordPollMeta = recordPollMeta;
T.getVersionText = getVersionText;
T.maybeShowUpdateNotification = maybeShowUpdateNotification;
T.backupCurrentBrowserConfig = backupCurrentBrowserConfig;
T.pruneTempWhitelistEntries = pruneTempWhitelistEntries;
T.writeConfigMirrorsVerified = writeConfigMirrorsVerified;

export {
  parseBool,
  normalizeName,
  uniqNames,
  clampSettings,
  redactForDiag,
  loadSettings,
  recordPollMeta,
  getVersionText,
  maybeShowUpdateNotification,
  backupCurrentBrowserConfig,
  pruneTempWhitelistEntries,
  writeConfigMirrorsVerified
};