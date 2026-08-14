import { state, armAlarm, log } from "./core.js";
import { loadSettings, recordPollMeta } from "./config.js";
import { ensureAlarm } from "./compat.js";
import { listManaged, adoptOpenTabs, reconcileTabs } from "./tabs.js";
import {
  isManagerEnabled,
  closeManagedChannelsThatAreNowBlocked,
  isReopenBlocked
} from "./cleanup.js";

const T = (globalThis.TTM = globalThis.TTM || {});

// close much sooner when a channel drops out of live detection
const missingLiveSinceByChannel = new Map();
const LIVE_MISS_CLOSE_DELAY_MS = 10000;

let booted = false;
let consecutiveEmptyLivePolls = 0;

function isRaidLikeUrl(url = "") {
  return String(url || "").toLowerCase().includes("referrer=raid");
}

function channelFromUrl(url = "") {
  try {
    const u = new URL(String(url || ""));
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

async function closeRaidRedirectTabsThatAreNowUnwanted(liveList) {
  try {
    const liveSet = new Set((liveList || []).map((x) => T.normalizeName(x)));
    const tabs = await chrome.tabs.query({ url: ["https://www.twitch.tv/*"] });

    for (const tab of tabs) {
    const url = tab?.url || tab?.pendingUrl || "";
    if (!isRaidLikeUrl(url)) continue;

    const login = channelFromUrl(url);
    if (!login) continue;

    if (!liveSet.has(login)) {
      try {
        await chrome.tabs.remove(tab.id);
        log("raid_redirect_tab_closed", { login, tabId: tab.id, url });
      } catch (e) {
        log("raid_redirect_tab_close_error", { login, tabId: tab.id, error: String(e) });
      }
    }
  }
    } catch (e) {
      log("raid_redirect_scan_error", String(e));
    }
  }

async function poll({ force = false } = {}) {
  await loadSettings();

  if (!force && state.settings.enabled === false) {
    log("poll_skip", { reason: "disabled" });
    return { ok: true, skipped: "disabled" };
  }

  state.loading = true;
  await closeManagedChannelsThatAreNowBlocked();

  let liveList = [];

  try {
    const getter = globalThis.bgLive?.getLiveNowByConfigSafe;
    const live = typeof getter === "function" ? await getter(state.settings) : [];
    liveList = T.uniqNames(Array.isArray(live) ? live : [...(live || [])]);
  } catch (e) {
    log("poll_live_error", String(e));
  }

    state.lastLiveCount = liveList.length;

  liveList = liveList.filter((login) => {
    const key = T.normalizeName(login);
    if (!key) return false;
    if (isReopenBlocked(key)) return false;
    if (state.settings.blacklist.includes(key)) return false;
    return true;
  });

  if (liveList.length === 0) consecutiveEmptyLivePolls += 1;
  else consecutiveEmptyLivePolls = 0;

  try {
    const now = Date.now();
    const managedNow = await listManaged();
    const liveNowSet = new Set(liveList);

    for (const ch of managedNow) {
      if (liveNowSet.has(ch)) {
        missingLiveSinceByChannel.delete(ch);
      } else if (!missingLiveSinceByChannel.has(ch)) {
        missingLiveSinceByChannel.set(ch, now);
      }
    }

    for (const ch of [...missingLiveSinceByChannel.keys()]) {
      if (!managedNow.includes(ch)) {
        missingLiveSinceByChannel.delete(ch);
      }
    }

    const debouncedLiveList = T.uniqNames([
      ...liveList,
      ...managedNow.filter((ch) => {
        const missingSince = missingLiveSinceByChannel.get(ch);
        if (!missingSince) return false;
        return now - missingSince < LIVE_MISS_CLOSE_DELAY_MS;
      })
    ]);

    log("poll_reconcile", {
      detected_live: liveList,
      managed_now: managedNow,
      debounced_live: debouncedLiveList,
      debounce_ms: LIVE_MISS_CLOSE_DELAY_MS
    });

        const shouldSkipMassClose =
      debouncedLiveList.length === 0 &&
      managedNow.length > 0 &&
      consecutiveEmptyLivePolls < 4;

    if (shouldSkipMassClose) {
      log("poll_skip_mass_close_once", {
        detected_live: liveList,
        managed_now: managedNow,
        consecutiveEmptyLivePolls
      });
    } else {
      await reconcileTabs(debouncedLiveList, state.settings);
      await closeManagedChannelsThatAreNowBlocked();
      await closeRaidRedirectTabsThatAreNowUnwanted(liveList);
    }
  } catch (e) {
    log("poll_reconcile_error", String(e));
  }

  try {
    const managed = await listManaged();

    state.lastLive = Array.isArray(liveList) ? liveList.slice() : [];
    state.openChannels = managed;
    state.loading = false;

    await recordPollMeta("ok", {
      ttm_last_poll_live_count: Number(state.lastLiveCount || 0),
      ttm_last_poll_error: ""
    });

    log("poll_done", {
      live_count: Number(state.lastLiveCount || 0),
      live_channels: state.lastLive,
      open_count: managed.length,
      open_channels: managed,
      max_tabs: state.settings.max_tabs,
      force: !!force
    });

    return {
      ok: true,
      live_count: Number(state.lastLiveCount || 0),
      live_channels: state.lastLive.slice(),
      open_count: managed.length,
      open_channels: managed.slice(),
      max_tabs: state.settings.max_tabs,
      force: !!force
    };
  } catch (e) {
    state.loading = false;

    await recordPollMeta("error", {
      ttm_last_poll_live_count: Number(state.lastLiveCount || 0),
      ttm_last_poll_error: String(e)
    });

    log("poll_list_error", String(e));
    return { ok: false, error: String(e) };
  }
}

async function bootOnce() {
  if (booted) return;

  state.loading = true;

  await loadSettings();
  await ensureAlarm();

  let adoptedInfo = { adopted: 0, total: 0 };

  if (isManagerEnabled()) {
    try {
      adoptedInfo = await adoptOpenTabs(state.settings.followUnion || []);
    } catch (e) {
      log("boot_adopt_error", String(e));
    }
  }

  try {
    await chrome.alarms.create(T.TTM_REPOKE_ALARM, { periodInMinutes: 1 });
  } catch {}

  booted = true;
  state.loading = false;

  log("boot", {
    enabled: state.settings.enabled,
    everySec: state.settings.check_interval_sec,
    adopted_tabs: adoptedInfo.adopted,
    managed_total: adoptedInfo.total
  });
}

T.poll = poll;
T.bootOnce = bootOnce;
T.armAlarm = armAlarm;
T.getSettings = () => state.settings;

export { poll, bootOnce, LIVE_MISS_CLOSE_DELAY_MS };