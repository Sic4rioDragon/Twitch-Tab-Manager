import { state } from "./core.js";
import { getEvents } from "./events.js";
import { initRegistry, listTabRecords } from "./registry.js";

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
  await initRegistry();

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
  const rotationStatus = typeof T.getRotationStatus === "function"
    ? await T.getRotationStatus(s, liveChannels)
    : null;
  const managerWindow = typeof T.getManagerWindowInfo === "function"
    ? await T.getManagerWindowInfo()
    : {
        exists: false,
        windowId: null,
        holderTabId: null,
        focused: false,
        state: "unavailable",
        primingDisabledForSession: false
      };

  const managerWindowId = Number(managerWindow?.windowId || 0) || null;
  const managerWindowFocused = !!managerWindow?.focused;
  const tabById = new Map(openTabs.map((tab) => [Number(tab.id), tab]));
  const registry = listTabRecords().map((rec) => {
    const tab = tabById.get(Number(rec.tabId));
    const owned = !!rec.owned && !!isManaged(rec.tabId);
    const active = !!tab?.active;
    const inManagerWindow = !!managerWindowId && Number(tab?.windowId) === managerWindowId;
    const internalManagerActive = owned && active && inManagerWindow && !managerWindowFocused;
    return {
      ...rec,
      owned,
      active,
      windowId: Number(tab?.windowId || 0) || null,
      in_manager_window: inManagerWindow,
      internal_manager_active: internalManagerActive,
      recovery_allowed: owned && (!active || internalManagerActive),
      recovery_owner: rec.recoveryOwner || ""
    };
  });
  const events = await getEvents(160);
  const detection = globalThis.bgLive?.getLastDetectionMeta?.() || null;
  const sidebar = globalThis.bgLive?.getSidebarState?.() || null;

  const managedOpenDetails = managedOpen.map((t) => {
    const inManagerWindow = !!managerWindowId && Number(t.windowId) === managerWindowId;
    return {
      id: t.id,
      login: getTabLogin(t),
      title: t.title || "",
      url: t.url || "",
      pendingUrl: t.pendingUrl || "",
      windowId: Number(t.windowId || 0) || null,
      in_manager_window: inManagerWindow,
      internal_manager_active: !!t.active && inManagerWindow && !managerWindowFocused,
      audible: !!t.audible,
      discarded: !!t.discarded,
      active: !!t.active,
      status: t.status || ""
    };
  });

  const allOpenTwitchTabs = openTabs.map((t) => {
    const managed = !!isManaged(t);
    const inManagerWindow = !!managerWindowId && Number(t.windowId) === managerWindowId;
    return {
      id: t.id,
      login: getTabLogin(t),
      managed,
      title: t.title || "",
      url: t.url || "",
      pendingUrl: t.pendingUrl || "",
      windowId: Number(t.windowId || 0) || null,
      in_manager_window: inManagerWindow,
      internal_manager_active: managed && !!t.active && inManagerWindow && !managerWindowFocused,
      audible: !!t.audible,
      discarded: !!t.discarded,
      active: !!t.active,
      status: t.status || ""
    };
  });

  const raidTabs = allOpenTwitchTabs.filter((t) => /(?:[?&])referrer=raid(?:&|$)/i.test(t.url || t.pendingUrl || ""));
  const lifecycleCounts = {};
  for (const rec of registry) {
    const key = String(rec.lifecycle || "unknown");
    lifecycleCounts[key] = Number(lifecycleCounts[key] || 0) + 1;
  }

  const probe = detection?.probe || {};
  const managedInManagerWindow = managedOpenDetails.filter((t) => t.in_manager_window);
  const managedOutsideManagerWindow = managedOpenDetails.filter((t) => !t.in_manager_window);
  const managerWindowOrphanTwitchTabs = allOpenTwitchTabs.filter((t) => t.in_manager_window && !t.managed);
  const recentFocusBreaches = events.filter((e) => [
    "MANAGER_WINDOW_FOCUS_BREACH",
    "MANAGER_WINDOW_FOCUS_BREACH_PASSIVE",
    "MANAGER_WINDOW_FOCUS_OBSERVED"
  ].includes(e?.kind)).length;
  const ownedCap = Number(rotationStatus?.ownedCap || s.max_tabs || 0);

  const health = {
    total_twitch_tabs: allOpenTwitchTabs.length,
    managed_tabs: managedOpenDetails.length,
    external_twitch_tabs: Math.max(0, allOpenTwitchTabs.length - managedOpenDetails.length),
    active_managed_tabs: managedOpenDetails.filter((t) => t.active).length,
    internal_manager_active_tabs: managedOpenDetails.filter((t) => t.internal_manager_active).length,
    manager_window_exists: !!managerWindow?.exists,
    manager_window_focused: managerWindowFocused,
    manager_window_state: managerWindow?.state || "unknown",
    manager_window_priming_disabled: !!managerWindow?.primingDisabledForSession,
    manager_window_priming_backoff_ms: Number(managerWindow?.primingBlockedMsRemaining || 0),
    manager_window_focus_breach_count: Number(managerWindow?.focusBreachCount || 0),
    managed_in_manager_window: managedInManagerWindow.length,
    managed_outside_manager_window: managedOutsideManagerWindow.length,
    manager_window_orphan_twitch_tabs: managerWindowOrphanTwitchTabs.length,
    recent_manager_focus_breaches: recentFocusBreaches,
    raid_tabs: raidTabs.length,
    owned_raid_tabs: raidTabs.filter((t) => t.managed).length,
    orphan_raid_tabs: raidTabs.filter((t) => !t.managed).length,
    manager_window_orphan_raid_tabs: raidTabs.filter((t) => !t.managed && t.in_manager_window).length,
    playing_tabs: registry.filter((r) => r.owned && r.lifecycle === "playing").length,
    recovering_tabs: registry.filter((r) => r.owned && r.lifecycle === "recovering").length,
    failed_tabs: registry.filter((r) => r.owned && r.lifecycle === "failed").length,
    rendered_offline_tabs: registry.filter((r) => r.owned && !!r?.lastSnapshot?.page?.offlineDom).length,
    rotation_enabled: !!rotationStatus?.enabled,
    rotation_slots_active: Number(rotationStatus?.effectiveSlots || 0),
    normal_max_tabs: Number(s.max_tabs || 0),
    owned_tab_cap: ownedCap,
    rotation_live_candidates: Array.isArray(rotationStatus?.liveCandidates) ? rotationStatus.liveCandidates.length : 0,
    rotation_cooling_candidates: Array.isArray(rotationStatus?.cooling) ? rotationStatus.cooling.length : 0,
    lifecycle_counts: lifecycleCounts,
    detector: {
      checked: Number(probe.checked || 0),
      responded: Number(probe.responded || 0),
      live: Array.isArray(probe.live) ? probe.live.length : 0,
      offline: Array.isArray(probe.offline) ? probe.offline.length : 0,
      unknown: Array.isArray(probe.unknown) ? probe.unknown.length : 0
    }
  };

  const attention = [];
  if (managerWindowFocused) {
    attention.push({
      kind: "manager_window_focused",
      windowId: managerWindowId
    });
  }
  if (Number(managerWindow?.primingBlockedMsRemaining || 0) > 0) {
    attention.push({
      kind: "manager_window_priming_backoff",
      windowId: managerWindowId,
      remainingMs: Number(managerWindow.primingBlockedMsRemaining || 0),
      blockedUntil: Number(managerWindow.primingBlockedUntil || 0),
      focusBreachCount: Number(managerWindow.focusBreachCount || 0)
    });
  }
  if (managedOutsideManagerWindow.length) {
    attention.push({
      kind: "managed_tabs_outside_manager_window",
      count: managedOutsideManagerWindow.length,
      tabs: managedOutsideManagerWindow.map((t) => ({ id: t.id, login: t.login, windowId: t.windowId, active: t.active }))
    });
  }
  if (health.manager_window_orphan_twitch_tabs) {
    attention.push({
      kind: "manager_window_orphan_twitch_tabs",
      count: health.manager_window_orphan_twitch_tabs,
      tabs: managerWindowOrphanTwitchTabs.map((t) => ({ id: t.id, login: t.login, active: t.active, url: t.url || t.pendingUrl || "" }))
    });
  }
  if (health.manager_window_orphan_raid_tabs) {
    attention.push({ kind: "manager_window_orphan_raid_tabs", count: health.manager_window_orphan_raid_tabs });
  } else if (health.orphan_raid_tabs) {
    attention.push({ kind: "orphan_raid_tabs", count: health.orphan_raid_tabs });
  }
  if (health.failed_tabs) attention.push({ kind: "failed_managed_tabs", count: health.failed_tabs });
  if (health.recovering_tabs) attention.push({ kind: "recovering_managed_tabs", count: health.recovering_tabs });
  if (health.rendered_offline_tabs) attention.push({ kind: "rendered_offline_tabs", count: health.rendered_offline_tabs });
  for (const rec of registry) {
    if (!rec.owned) continue;
    if (Number(rec.reloadAttempts || 0) >= 2 || Number(rec.navigateAttempts || 0) >= 2) {
      attention.push({
        kind: "recovery_cap_reached",
        tabId: rec.tabId,
        channel: rec.expectedChannel || rec.actualChannel || "",
        reloadAttempts: Number(rec.reloadAttempts || 0),
        navigateAttempts: Number(rec.navigateAttempts || 0),
        retryAfterAt: Number(rec.retryAfterAt || 0)
      });
    }
  }

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
      rotation_enabled: s.rotation_enabled,
      rotation_interval_min: s.rotation_interval_min,
      rotation_slot_count: s.rotation_slot_count,
      rotation_cooldown_min: s.rotation_cooldown_min,
      rotation_include_low_priority: s.rotation_include_low_priority,
      favorites_count: Array.isArray(s.favorites) ? s.favorites.length : 0,
      priority_count: Array.isArray(s.priority) ? s.priority.length : 0,
      follows_count: Array.isArray(s.follows) ? s.follows.length : 0,
      rotation_count: Array.isArray(s.rotation) ? s.rotation.length : 0,
      low_priority_count: Array.isArray(s.low_priority) ? s.low_priority.length : 0,
      followUnion_count: Array.isArray(s.followUnion) ? s.followUnion.length : 0,
      blacklist_count: Array.isArray(s.blacklist) ? s.blacklist.length : 0,
      favorites: Array.isArray(s.favorites) ? s.favorites.slice() : [],
      priority: Array.isArray(s.priority) ? s.priority.slice() : [],
      follows: Array.isArray(s.follows) ? s.follows.slice() : [],
      rotation: Array.isArray(s.rotation) ? s.rotation.slice() : [],
      low_priority: Array.isArray(s.low_priority) ? s.low_priority.slice() : [],
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
    capacity: Math.max(0, ownedCap - managedOpen.length),
    max_tabs_scope: rotationStatus?.enabled
      ? "normal_max_plus_extra_rotation_slots"
      : "ttm_owned_stream_tabs_only",
    owned_tab_cap: ownedCap,
    manager_window: {
      ...managerWindow,
      managed_tab_count: managedInManagerWindow.length,
      managed_outside_count: managedOutsideManagerWindow.length,
      internal_active_count: managedOpenDetails.filter((t) => t.internal_manager_active).length,
      recent_focus_breach_count: recentFocusBreaches
    },
    health,
    attention,
    stalled_tabs: stalledTabs,
    tab_registry: registry,
    live_detection: detection,
    twitch_sidebar: sidebar,
    streak_rescue: streakRescue,
    rotation: rotationStatus,
    events,
    logs: Array.isArray(state.logs) ? state.logs.slice(-100) : []
  };
}

T.redactForDiag = redactForDiag;
T.diagnose = diagnose;

export { redactForDiag };