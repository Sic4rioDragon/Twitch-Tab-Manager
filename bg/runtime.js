import { state } from "./core.js";
import { diagnose } from "./diagnose.js";
import { ensureAlarm, setEnabled, normalizeType } from "./compat.js";
import { loadSettings } from "./config.js";
import { fetchMyFollows } from "./follows.js";
import { getPlayerStatus, rememberPlayerStatus, repokeManagedTabs, pokeChannelTab, scheduleTabRepokes } from "./player.js";
import { poll, bootOnce } from "./poll.js";
import { initRegistry, unregisterTab, notePageState, notePlayerState, noteRaid, getTabRecord } from "./registry.js";
import { armWatchdog, runWatchdog, CHECK_ALARM } from "./watchdog.js";
import { event } from "./events.js";
import {
  handleStreakScan,
  handleStreakPlayback,
  runStreakRescueTick,
  getStreakRescueStatus,
  initStreakRescue,
  onTwitchTabComplete
} from "./streaks.js";
import {
  isManagerEnabled,
  closeSenderTabIfNowUnwanted,
  clearOfflineTimer,
  clearRaidTimer,
  scheduleOfflineClose,
  scheduleRaidClose,
  scheduleOwnedRaidTabClose,
  closeManagerWindowOrphanRaidTab,
  cleanupManagerWindowOrphanRaidTabs,
  tempAllowChannel
} from "./cleanup.js";
import { getManagerWindowInfo, isManagerWindowUnfocused } from "./manager-window.js";

const T = (globalThis.TTM = globalThis.TTM || {});

// Track the previously selected tab per window so a managed Twitch tab that
// was paused for user interaction can resume background control after the user
// leaves it. This never activates a tab or focuses a window.
const selectedTabByWindow = new Map();

const ACCEPTED_TYPES = [
  "ttm/ping",
  "ttm/enable",
  "ttm/reload_config",
  "ttm/force_poll",
  "ttm/diagnose",
  "TTM_STATUS",
  "TTM_TOGGLE",
  "TTM_RELOAD_CONFIG",
  "TTM_FORCE_POLL",
  "TTM_DIAG",
  "PING",
  "TOGGLE",
  "RELOAD_CONFIG",
  "FORCE_POLL",
  "DIAGNOSE",
  "TTM_FETCH_FOLLOWS",
  "TTM_GET_LOGS",
  "TTM_PLAYER_STATUS",
  "TTM_CLEAR_LOGS",
  "TTM_STREAK_SCAN",
  "TTM_STREAK_PLAYBACK",
  "TTM_PAGE_STATE",
  "TTM_SIDEBAR_STATE",
  "TTM_RUNTIME_SNAPSHOT",
  "ttm/streak_status",
  "ttm/streak_tick",
  "channel_status",
  "ttm/temp_allow_channel",
  "TTM_TEMP_ALLOW_CHANNEL",
  "raid_detected"
];

chrome.runtime.onInstalled.addListener((details) => {
  T.maybeShowUpdateNotification(details);

  globalThis.__TTM_BG_BOOTED__ = false;
  T.bootOnce()
    .then(async () => {
      await initRegistry();
      await armWatchdog();
      await initStreakRescue();
      await runWatchdog();
    })
    .catch((e) => T.log?.("boot_err", String(e)));
});

chrome.runtime.onStartup?.addListener(() => {
  globalThis.__TTM_BG_BOOTED__ = false;
  T.bootOnce()
    .then(async () => {
      await initRegistry();
      await armWatchdog();
      await initStreakRescue();
      await runWatchdog();
    })
    .catch((e) => T.log?.("boot_err", String(e)));
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (!isManagerEnabled()) return;

  if (alarm?.name === "ttm-tick") {
    poll().catch((e) => T.log?.("alarm_poll_error", String(e)));
    return;
  }

  if (alarm?.name === CHECK_ALARM) {
    runWatchdog().catch((e) => T.log?.("watchdog_error", String(e)));
    return;
  }

  if (alarm?.name === T.TTM_REPOKE_ALARM) {
    repokeManagedTabs().catch((e) => T.log?.("alarm_repoke_error", String(e)));
    runStreakRescueTick().catch((e) => T.log?.("streak_tick_error", String(e)));
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (!isManagerEnabled()) return;

  const url = tab?.url || tab?.pendingUrl || "";
  const raidLike = /([?&])referrer=raid(?:&|$)/i.test(url);

  // Unmanaged raid redirects are still safe to remove when they live inside
  // the dedicated TTM playback window. Do this as soon as the URL appears, not
  // only after Twitch finishes loading the redirected page.
  if (raidLike && !T.isManaged?.(tabId)) {
    const managerInfo = await getManagerWindowInfo().catch(() => null);
    if (managerInfo?.exists && Number(tab?.windowId) === Number(managerInfo.windowId)) {
      const closed = await closeManagerWindowOrphanRaidTab(tabId, "runtime_url_raid_cleanup");
      if (closed) return;
    }
  }

  if (info?.discarded === true && T.isManaged?.(tabId)) {
    setTimeout(() => {
      T.ensureBackgroundTabLoaded?.(tabId, T.channelFromUrl?.(url) || "").catch?.(() => {});
    }, 500);
  }

  if (info.status !== "complete") return;

  // Streak discovery is observation-only and may run on any Twitch tab.
  onTwitchTabComplete(tabId, url).catch(() => {});

  // Everything below this line is manager control. Never apply it to a tab the
  // user opened themselves.
  if (!T.isManaged?.(tabId)) return;

  const managerInfo = await getManagerWindowInfo().catch(() => null);
  if (managerInfo?.exists && Number(tab?.windowId) !== Number(managerInfo.windowId)) {
    // A managed tab dragged/moved into a normal browser window becomes a user
    // tab immediately. Do not keep controlling it outside the dedicated window.
    await T.releaseOwnedTab?.(tabId, "managed_tab_left_manager_window");
    await event("MANAGED_TAB_RELEASED_OUTSIDE_MANAGER_WINDOW", {
      tabId,
      windowId: tab?.windowId ?? null,
      managerWindowId: managerInfo.windowId,
      url
    });
    return;
  }

  // Raid bookkeeping is allowed while selected. In the dedicated *unfocused*
  // manager window, an internally active tab is still background-manager space.
  if (raidLike) {
    const target = T.channelFromUrl?.(url) || "";
    noteRaid(tabId, target).catch(() => {});
    event("RAID_DETECTED", { tabId, target, url, owned: true }).catch(() => {});
    scheduleOwnedRaidTabClose(tabId, 30000);
  }

  const internalManagerSelection = !!tab?.active && await isManagerWindowUnfocused(tab?.windowId);

  // An active tab in a user-focused window is user territory. An active tab in
  // the dedicated unfocused manager window is intentionally controllable.
  if (tab?.active && !internalManagerSelection) {
    chrome.tabs.sendMessage(tabId, { type: "TTM_ENFORCE_PAUSE" }).catch?.(() => {});
    return;
  }

  T.makeTabBackgroundSafe?.(tabId).catch?.(() => {});
  if (!T.isChannelUrl?.(url)) return;
  pokeChannelTab(tabId).catch(() => {});
  scheduleTabRepokes(tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (T.isManaged?.(tabId) && T.releaseOwnedTab) {
    T.releaseOwnedTab(tabId, "tab_removed").catch(() => {});
  } else {
    unregisterTab(tabId).catch(() => {});
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  if (!isManagerEnabled()) return;

  const priorTabId = selectedTabByWindow.get(Number(windowId));
  selectedTabByWindow.set(Number(windowId), Number(tabId));

  // If a managed tab just became inactive, it may resume background control.
  if (priorTabId && priorTabId !== tabId && T.isManaged?.(priorTabId)) {
    setTimeout(async () => {
      try {
        const prior = await chrome.tabs.get(priorTabId);
        if (!prior?.active && T.isManaged?.(priorTabId)) {
          await pokeChannelTab(priorTabId);
          await event("MANAGED_TAB_CONTROL_RESUMED", { tabId: priorTabId, windowId });
        }
      } catch {}
    }, 750);
  }

  if (!T.isManaged?.(tabId)) return;

  const managerInfo = await getManagerWindowInfo().catch(() => null);
  if (managerInfo?.exists && Number(windowId) !== Number(managerInfo.windowId)) {
    // Anything the user moves into a normal browser window stops being TTM-owned.
    await T.releaseOwnedTab?.(tabId, "managed_tab_activated_outside_manager_window");
    await event("MANAGED_TAB_RELEASED_OUTSIDE_MANAGER_WINDOW", {
      tabId,
      windowId,
      managerWindowId: managerInfo.windowId,
      reason: "activated_outside_manager_window"
    });
    return;
  }

  const internalManagerSelection = await isManagerWindowUnfocused(windowId);
  if (internalManagerSelection) {
    // This activation was inside the dedicated unfocused manager window (for
    // example startup/recovery priming). It is safe and must not be paused.
    await pokeChannelTab(tabId).catch(() => {});
    await event("MANAGER_INTERNAL_TAB_ACTIVATED", { tabId, windowId });
    return;
  }

  // A selected managed tab in a focused window is user territory.
  try {
    await chrome.tabs.sendMessage(tabId, { type: "TTM_ENFORCE_PAUSE" });
    await event("ACTIVE_MANAGED_TAB_PROTECTED", { tabId, windowId, managerWindowFocused: true });
  } catch {}
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (!isManagerEnabled()) return;
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;

  const managerInfo = await getManagerWindowInfo().catch(() => null);
  if (!managerInfo?.exists) return;

  if (Number(windowId) === Number(managerInfo.windowId)) {
    // The user deliberately focused the playback window. Protect whichever
    // managed tab is active there until they leave the window again.
    try {
      const [active] = await chrome.tabs.query({ windowId: managerInfo.windowId, active: true });
      if (active?.id && T.isManaged?.(active.id)) {
        await chrome.tabs.sendMessage(active.id, { type: "TTM_ENFORCE_PAUSE" }).catch(() => {});
        await event("MANAGER_WINDOW_USER_FOCUSED", { windowId, tabId: active.id });
      }
    } catch {}
    return;
  }

  // Focus returned to a normal window. Opportunistically clear any orphan raid
  // redirects, then resume the active stream without focusing the manager window.
  cleanupManagerWindowOrphanRaidTabs("focus_return_sweep").catch(() => {});
  setTimeout(async () => {
    try {
      const fresh = await getManagerWindowInfo();
      if (!fresh?.exists || fresh.focused) return;
      const [active] = await chrome.tabs.query({ windowId: fresh.windowId, active: true });
      if (active?.id && T.isManaged?.(active.id)) {
        await pokeChannelTab(active.id);
        await event("MANAGER_WINDOW_BACKGROUND_CONTROL_RESUMED", {
          managerWindowId: fresh.windowId,
          tabId: active.id,
          userWindowId: windowId
        });
      }
    } catch {}
  }, 750);
});

chrome.runtime.onMessage.addListener((msg, sender, send) => {
  (async () => {
    await bootOnce();
    const kind = normalizeType(msg?.type);

    if (kind === "ttm_page_state") {
      const tabId = sender?.tab?.id;
      if (tabId != null) {
        await notePageState(tabId, msg);
        if (msg?.raid) await noteRaid(tabId, msg?.channel || "");
      }
      return void send({ ok: true });
    }

    if (kind === "ttm_sidebar_state") {
      globalThis.bgLive?.updateSidebarState?.(msg, sender?.tab?.id ?? null);
      return void send({ ok: true });
    }

    if (kind === "ping") {
      return void send({
        ok: true,
        alive: true,
        enabled: state.settings.enabled !== false,
        loading: !!state.loading
      });
    }

    if (kind === "toggle") {
      const on = msg?.enabled === undefined ? !state.settings.enabled : !!msg.enabled;
      const enabled = await setEnabled(on);

      state.settings = {
        ...state.settings,
        enabled
      };

      await chrome.storage.local.set({
        settings: state.settings,
        config: state.settings,
        enabled
      });

      return void send({ ok: true, enabled });
    }

    if (kind === "reload") {
      await loadSettings();
      await ensureAlarm();
      await runStreakRescueTick();

      let adoptedInfo = { adopted: 0, total: 0 };
      if (isManagerEnabled()) {
        try {
          adoptedInfo = await T.adoptOpenTabs(state.settings.followUnion || []);
        } catch (e) {
          T.log?.("reload_adopt_error", String(e));
        }
      }

      return void send({
        ok: true,
        settings: T.redactForDiag(state.settings),
        adopted_tabs: adoptedInfo.adopted,
        managed_total: adoptedInfo.total
      });
    }

    if (kind === "force") {
      T.log?.("poll_start", { enabled: state.settings.enabled !== false, force: true });
      const result = await poll({ force: true });
      return void send(result);
    }

    if (kind === "diag" || kind === "diagnose") {
      return void send(await diagnose());
    }

    if (kind === "fetch_follows") {
      return void send(await fetchMyFollows(msg?.mode || "active"));
    }

    if (kind === "get_logs") {
      return void send({
        ok: true,
        logs: Array.isArray(state.logs) ? state.logs.slice(-200) : []
      });
    }

    if (kind === "clear_logs") {
      state.logs = [];
      await chrome.storage.local.remove("ttm_logs_v1");
      return void send({ ok: true });
    }

    if (kind === "temp_allow_channel") {
      if (!msg?.login) {
        return void send({ ok: false, error: "missing_login" });
      }

      const ok = await tempAllowChannel(msg.login);
      return void send({ ok });
    }

    if (kind === "ttm_player_status") {
      if (!isManagerEnabled()) {
        return void send({ ok: true, ignored: "disabled" });
      }

      const tabId = sender?.tab?.id;
      if (tabId != null) {
        if (!T.isManaged?.(tabId)) {
          return void send({ ok: true, ignored: "unmanaged_tab" });
        }
        const prev = getPlayerStatus(tabId);

        const next = {
          login: T.normalizeName(msg?.login),
          hasVideo: !!msg?.hasVideo,
          paused: !!msg?.paused,
          muted: !!msg?.muted,
          volume: msg?.volume ?? null,
          adPlaying: !!msg?.adPlaying,
          visible: !!msg?.visible,
          focused: !!msg?.focused,
          readyState: Number(msg?.readyState ?? -1),
          currentTime: Number(msg?.currentTime ?? 0),
          stalledStart: !!msg?.stalledStart
        };

        const isBad =
          !next.adPlaying &&
          (
            !next.hasVideo ||
            next.paused ||
            next.stalledStart
          );

        const wasBad = !!(prev && !prev.adPlaying && (
          !prev.hasVideo ||
          prev.paused ||
          prev.stalledStart
        ));

        if (isBad) {
          next.firstSeenBadAt = wasBad && prev?.firstSeenBadAt ? prev.firstSeenBadAt : Date.now();
        } else {
          next.firstSeenBadAt = 0;
        }

        rememberPlayerStatus(tabId, next);
        const beforeRec = getTabRecord(tabId);
        const updatedRec = await notePlayerState(tabId, {
          ...next,
          playerElement: !!msg?.playerElement,
          networkState: Number(msg?.networkState ?? -1),
          progressAgeMs: Number(msg?.progressAgeMs ?? -1),
          url: msg?.url || sender?.tab?.url || ""
        });

        if (updatedRec?.lifecycle === "playing" && beforeRec?.lifecycle !== "playing") {
          // Keep the tab background-safe after playback verification without
          // changing Chromium's browser-tab mute/unmute state.
          setTimeout(async () => {
            try { await T.makeTabBackgroundSafe?.(tabId); } catch {}
            await pokeChannelTab(tabId).catch(() => {});
          }, 750);
        }
      }

      return void send({ ok: true });
    }

    if (kind === "ttm_streak_scan") {
      return void send(await handleStreakScan(msg, sender));
    }

    if (kind === "ttm_streak_playback") {
      return void send(await handleStreakPlayback(msg, sender));
    }

    if (kind === "ttm/streak_status") {
      return void send({ ok: true, status: await getStreakRescueStatus() });
    }

    if (kind === "ttm/streak_tick") {
      await runStreakRescueTick();
      return void send({ ok: true, status: await getStreakRescueStatus() });
    }

    if (kind === "channel_status") {
      if (!isManagerEnabled()) {
        return void send({ ok: true, ignored: "disabled" });
      }

      const tabId = sender?.tab?.id;
      if (!T.isManaged?.(tabId)) {
        return void send({ ok: true, ignored: "unmanaged_tab" });
      }

      const login = T.loginFromSenderOrMessage(sender, msg);
      if (!login) {
        return void send({ ok: false, error: "missing_login" });
      }

      const closedNow = await closeSenderTabIfNowUnwanted(sender, "offline_or_redirected_not_followed");
      if (closedNow) {
        return void send({ ok: true, closed_now: true });
      }

      if (msg?.isOffline) {
        if (Array.isArray(state.lastLive) && state.lastLive.includes(login)) {
          T.log?.("channel_status_offline_ignored_still_in_last_live", { login });
          return void send({ ok: true, ignored: "still_in_last_live" });
        }

        scheduleOfflineClose(login);
        return void send({ ok: true, pending: true, delay_ms: T.OFFLINE_CLOSE_DELAY_MS });
      }

      clearOfflineTimer(login);
      clearRaidTimer(login);
      return void send({ ok: true, live: true });
    }

    if (kind === "raid_detected") {
      if (!isManagerEnabled()) {
        return void send({ ok: true, ignored: "disabled" });
      }

      const tabId = sender?.tab?.id;
      if (!T.isManaged?.(tabId)) {
        const managerInfo = await getManagerWindowInfo().catch(() => null);
        if (managerInfo?.exists && Number(sender?.tab?.windowId) === Number(managerInfo.windowId)) {
          const closed = await closeManagerWindowOrphanRaidTab(tabId, "runtime_message_raid_cleanup");
          return void send({ ok: true, closed_orphan_manager_raid: !!closed });
        }
        return void send({ ok: true, ignored: "unmanaged_tab" });
      }

      const login = T.loginFromSenderOrMessage(sender, msg);
      if (!login) {
        return void send({ ok: false, error: "missing_login" });
      }

      const closedNow = await closeSenderTabIfNowUnwanted(sender, "raid_redirect_not_followed");
      if (closedNow) {
        return void send({ ok: true, closed_now: true });
      }

      scheduleOwnedRaidTabClose(tabId, 30000);
      return void send({ ok: true, scheduled: true, delay_ms: 30000 });
    }

    return void send({
      ok: false,
      error: "unknown_message",
      received: { type: msg?.type },
      accepted_types: ACCEPTED_TYPES
    });
  })().catch((e) => {
    T.log?.("msg_err", String(e));
    try {
      send({ ok: false, error: "handler_crash", detail: String(e) });
    } catch {}
  });

  return true;
});

bootOnce()
  .then(async () => {
    await initRegistry();
    await armWatchdog();
    await initStreakRescue();
    await runWatchdog();
  })
  .catch((e) => T.log?.("boot_err", String(e)));