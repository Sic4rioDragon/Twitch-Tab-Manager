import { state } from "./core.js";
import { diagnose } from "./diagnose.js";
import { ensureAlarm, setEnabled, normalizeType } from "./compat.js";
import { loadSettings } from "./config.js";
import { fetchMyFollows } from "./follows.js";
import { getPlayerStatus, rememberPlayerStatus, repokeManagedTabs, pokeChannelTab, scheduleTabRepokes } from "./player.js";
import { poll, bootOnce } from "./poll.js";
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
  tempAllowChannel
} from "./cleanup.js";

const T = (globalThis.TTM = globalThis.TTM || {});

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
    .then(() => initStreakRescue())
    .catch((e) => T.log?.("boot_err", String(e)));
});

chrome.runtime.onStartup?.addListener(() => {
  globalThis.__TTM_BG_BOOTED__ = false;
  T.bootOnce()
    .then(() => initStreakRescue())
    .catch((e) => T.log?.("boot_err", String(e)));
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (!isManagerEnabled()) return;

  if (alarm?.name === "ttm-tick") {
    poll().catch((e) => T.log?.("alarm_poll_error", String(e)));
    return;
  }

  if (alarm?.name === T.TTM_REPOKE_ALARM) {
    repokeManagedTabs().catch((e) => T.log?.("alarm_repoke_error", String(e)));
    runStreakRescueTick().catch((e) => T.log?.("streak_tick_error", String(e)));
  }
});

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== "complete") return;
  if (!isManagerEnabled()) return;

  onTwitchTabComplete(tabId, tab?.url || tab?.pendingUrl || "").catch(() => {});

  if (!T.isChannelUrl?.(tab?.url)) return;
  pokeChannelTab(tabId).catch(() => {});
  scheduleTabRepokes(tabId);
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  if (!isManagerEnabled()) return;

  try {
    const tab = await chrome.tabs.get(tabId);
    if (!T.isChannelUrl?.(tab?.url)) return;
    await pokeChannelTab(tabId);
  } catch {}
});

chrome.runtime.onMessage.addListener((msg, sender, send) => {
  (async () => {
    await bootOnce();
    const kind = normalizeType(msg?.type);

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
            next.muted ||
            next.stalledStart
          );

        const wasBad = !!(prev && !prev.adPlaying && (
          !prev.hasVideo ||
          prev.paused ||
          prev.muted ||
          prev.stalledStart
        ));

        if (isBad) {
          next.firstSeenBadAt = wasBad && prev?.firstSeenBadAt ? prev.firstSeenBadAt : Date.now();
        } else {
          next.firstSeenBadAt = 0;
        }

        rememberPlayerStatus(tabId, next);
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

      const login = T.loginFromSenderOrMessage(sender, msg);
      if (!login) {
        return void send({ ok: false, error: "missing_login" });
      }

      const closedNow = await closeSenderTabIfNowUnwanted(sender, "raid_redirect_not_followed");
      if (closedNow) {
        return void send({ ok: true, closed_now: true });
      }

      scheduleRaidClose(login);
      return void send({ ok: true, scheduled: true, delay_ms: T.RAID_CLOSE_DELAY_MS });
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
  .then(() => initStreakRescue())
  .catch((e) => T.log?.("boot_err", String(e)));