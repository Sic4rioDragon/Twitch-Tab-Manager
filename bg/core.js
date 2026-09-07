export const DEFAULTS = {
  enabled: true,
  check_interval_sec: 60,
  max_tabs: 4,
  client_id: "",
  access_token: "",
  live_source: "auto",

  favorites: [],
  priority: [],
  follows: [],
  rotation: [],
  low_priority: [],
  blacklist: [],
  followUnion: [],

  rotation_enabled: false,
  rotation_interval_min: 30,
  rotation_slot_count: 1,
  rotation_cooldown_min: 30,
  rotation_include_low_priority: false,

  force_unmute: false,
  unmute_streams: false,
  force_resume: true,
  autoplay_streams: true,
  soft_wake_tabs: false,
  soft_wake_only_when_browser_focused: false,
  close_unfollowed_tabs: true,
  allow_extra_twitch_tabs: true,
  temp_whitelist_hours: 12,
  temp_whitelist_entries: {},

  streak_rescue_enabled: false,
  streak_rescue_mode: "detect",
  streak_rescue_slots: 1,
  streak_rescue_required_watch_min: 5,
  streak_rescue_grace_min: 10,
  streak_rescue_confirm_check_sec: 30,
  streak_rescue_retry_min: 15
};

const LS_KEYS = {
  settings: "ttm_settings_v1",
  logs:     "ttm_logs_v1"
};

export const state = {
  settings: { ...DEFAULTS },
  nextCheckAt: 0,
  openChannels: [],
  lastLive: [],
  logs: []
};

// ---- logging / diagnostics ----
export function log(type, detail) {
  try {
    const line = { t: new Date().toISOString(), type, detail };
    try {
    const safeLine =
      typeof line === "string"
        ? line.slice(0, 500)
        : JSON.stringify(line).slice(0, 500);

    state.logs.push(safeLine);

    if (state.logs.length > 150) {
      state.logs.splice(0, state.logs.length - 150);
    }

    chrome.storage.local.set({
      [LS_KEYS.logs]: state.logs
    }).catch(() => {});
  } catch {}

    let printable = detail;
    if (detail && typeof detail === "object") {
      try {
        printable = JSON.stringify(detail);
      } catch {
        printable = String(detail);
      }
    }

    if (type.includes("error")) console.error("[TTM]", type, printable);
    else console.log("[TTM]", type, printable);
  } catch { /* noop */ }
}

export async function readAll() {
  const got = await chrome.storage.local.get([LS_KEYS.settings, LS_KEYS.logs]);
  if (Array.isArray(got[LS_KEYS.logs])) state.logs = got[LS_KEYS.logs];
  if (got[LS_KEYS.settings]) state.settings = { ...DEFAULTS, ...got[LS_KEYS.settings] };
  return state.settings;
}

export async function saveSettings(patch) {
  state.settings = { ...state.settings, ...patch };
  await chrome.storage.local.set({ [LS_KEYS.settings]: state.settings });
  return state.settings;
}

export function coerceSettings(s) {
  const out = { ...s };
  if (out.max_tabs != null) out.max_tabs = Math.max(0, Number(out.max_tabs));
  if (out.check_interval_sec != null) out.check_interval_sec = Math.max(15, Number(out.check_interval_sec));
  return out;
}

export function redactForDiag(s) {
  const redacted = { ...s };
  if (redacted.access_token) redacted.access_token = "***";
  if (redacted.client_id) redacted.client_id = "***";
  return redacted;
}

// ---- alarms ----
export async function armAlarm() {
  const everySec = Math.max(15, Number(state.settings.check_interval_sec || 60));
  await chrome.alarms.clear("ttm-tick");
  chrome.alarms.create("ttm-tick", { periodInMinutes: Math.max(1, everySec / 60) });
  state.nextCheckAt = Date.now() + everySec * 1000;
  log("alarm_armed", { everySec });
}

// ---- helpers used by background.js ----
export function setOpenChannels(list) {
  state.openChannels = Array.from(new Set(list.map(x => x?.toLowerCase?.() || x))).filter(Boolean);
}

export function setLastLive(list) {
  state.lastLive = list || [];
}

export function getSettings() {
  return state.settings;
}
