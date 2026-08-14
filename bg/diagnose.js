import { state } from "./core.js";

const T = (globalThis.TTM = globalThis.TTM || {});

function redactForDiag(input) {
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

function getTabLogin(tab) {
  const raw = String(tab?.url || tab?.pendingUrl || "");
  try {
    const u = new URL(raw);
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
      "wallet"
    ].includes(first.toLowerCase())) {
      return "";
    }
    return first.toLowerCase();
  } catch {
    return "";
  }
}

export async function diagnose() {
  const s = state.settings || {};

  const listOpenTabs =
    typeof T.listOpenTabs === "function"
      ? T.listOpenTabs
      : async () => [];

  const isManaged =
    typeof T.isManaged === "function"
      ? T.isManaged
      : () => false;

  const openTabs = await listOpenTabs();
  const managedOpen = openTabs.filter((t) => isManaged(t));

  const playerMap = globalThis.__TTM_PLAYER_STATUS_MAP__ || new Map();
  const stalledTabs = Array.from(playerMap.entries())
    .map(([tabId, info]) => ({
      tabId: Number(tabId),
      login: info?.login || "",
      stalledStart: !!info?.stalledStart,
      paused: !!info?.paused,
      muted: !!info?.muted,
      hasVideo: !!info?.hasVideo,
      readyState: Number(info?.readyState ?? -1),
      currentTime: Number(info?.currentTime ?? 0),
      visible: !!info?.visible,
      focused: !!info?.focused
    }))
    .filter((x) => x.stalledStart);

  const liveChannels = Array.isArray(state.lastLive) ? state.lastLive.slice() : [];
  const trackedOpenChannels = Array.isArray(state.openChannels) ? state.openChannels.slice() : [];
  const streakRescue = typeof T.getStreakRescueStatus === "function"
    ? await T.getStreakRescueStatus()
    : null;

  const managedOpenDetails = managedOpen.map((t) => ({
    id: t.id,
    login: getTabLogin(t),
    title: t.title || "",
    url: t.url || "",
    pendingUrl: t.pendingUrl || "",
    audible: !!t.audible,
    discarded: !!t.discarded,
    active: !!t.active,
    status: t.status || ""
  }));

  const allOpenTwitchTabs = openTabs.map((t) => ({
    id: t.id,
    login: getTabLogin(t),
    managed: !!isManaged(t),
    title: t.title || "",
    url: t.url || "",
    pendingUrl: t.pendingUrl || "",
    audible: !!t.audible,
    discarded: !!t.discarded,
    active: !!t.active,
    status: t.status || ""
  }));

  return {
    ok: true,
    settings: redactForDiag({
      enabled: s.enabled,
      live_source: s.live_source,
      check_interval_sec: s.check_interval_sec,
      max_tabs: s.max_tabs,
      force_unmute: s.force_unmute,
      unmute_streams: s.unmute_streams,
      force_resume: s.force_resume,
      autoplay_streams: s.autoplay_streams,
      soft_wake_tabs: s.soft_wake_tabs,
      soft_wake_only_when_browser_focused: s.soft_wake_only_when_browser_focused,
      close_unfollowed_tabs: s.close_unfollowed_tabs,
      allow_extra_twitch_tabs: s.allow_extra_twitch_tabs,
      temp_whitelist_hours: s.temp_whitelist_hours,
      streak_rescue_enabled: s.streak_rescue_enabled,
      streak_rescue_mode: s.streak_rescue_mode,
      streak_rescue_required_watch_min: s.streak_rescue_required_watch_min,
      streak_rescue_grace_min: s.streak_rescue_grace_min,
      streak_rescue_confirm_check_sec: s.streak_rescue_confirm_check_sec,
      streak_rescue_retry_min: s.streak_rescue_retry_min,
      follows_count: Array.isArray(s.follows) ? s.follows.length : 0,
      priority_count: Array.isArray(s.priority) ? s.priority.length : 0,
      followUnion_count: Array.isArray(s.followUnion) ? s.followUnion.length : 0,
      blacklist_count: Array.isArray(s.blacklist) ? s.blacklist.length : 0,
      follows: Array.isArray(s.follows) ? s.follows.slice() : [],
      priority: Array.isArray(s.priority) ? s.priority.slice() : [],
      followUnion: Array.isArray(s.followUnion) ? s.followUnion.slice() : [],
      blacklist: Array.isArray(s.blacklist) ? s.blacklist.slice() : [],
      client_id: s.client_id,
      access_token: s.access_token
    }),
    loading: !!state.loading,
    live_count: Number(state.lastLiveCount || 0),
    live_channels: liveChannels,
    open_count: managedOpen.length,
    open_channels: managedOpenDetails,
    tracked_open_channels: trackedOpenChannels,
    all_open_twitch_tabs: allOpenTwitchTabs,
    capacity: Math.max(0, (Number(s.max_tabs || 0) || 0) - managedOpen.length),
    stalled_tabs: stalledTabs,
    streak_rescue: streakRescue,
    logs: Array.isArray(state.logs) ? state.logs.slice(-100) : []
  };
}

T.redactForDiag = redactForDiag;
T.diagnose = diagnose;

export { redactForDiag };