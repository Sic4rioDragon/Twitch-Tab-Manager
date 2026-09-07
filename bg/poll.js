import { state, armAlarm, log } from "./core.js";
import { event } from "./events.js";
import { loadSettings, recordPollMeta } from "./config.js";
import { ensureAlarm } from "./compat.js";
import { listManaged, adoptOpenTabs, reconcileTabs } from "./tabs.js";
import {
  isManagerEnabled,
  closeManagedChannelsThatAreNowBlocked,
  isReopenBlocked,
  closeOwnedRaidTab,
  cleanupManagerWindowOrphanRaidTabs,
  cleanupManagerWindowOrphanOfflineTabs,
  cleanupLegacyOrphanRaidTabs
} from "./cleanup.js";
import { listTabRecords } from "./registry.js";

const T = (globalThis.TTM = globalThis.TTM || {});

// close much sooner when a channel drops out of live detection
const missingLiveSinceByChannel = new Map();
const LIVE_MISS_CLOSE_DELAY_MS = 90_000;

let booted = false;
let consecutiveEmptyLivePolls = 0;
let activePollPromise = null;
let pollSequence = 0;

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

async function closeRaidRedirectTabsThatAreNowUnwanted(_liveList) {
  try {
    const tabs = await chrome.tabs.query({
      url: ["*://www.twitch.tv/*", "*://twitch.tv/*"]
    });

    for (const tab of tabs) {
      const url = tab?.url || tab?.pendingUrl || "";
      if (!isRaidLikeUrl(url)) continue;
      if (!T.isManaged?.(tab?.id)) continue;

      // closeOwnedRaidTab() performs the real safety check: an active raid in a
      // user-focused window is protected, while an internally-active raid in
      // the dedicated unfocused manager window is safe to close.
      await closeOwnedRaidTab(tab.id, "poll_owned_raid_cleanup");
    }
  } catch (e) {
    log("raid_redirect_scan_error", String(e));
  }
}

async function pollImpl({ force = false } = {}, sequence = 0) {
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

  const detectionMeta = globalThis.bgLive?.getLastDetectionMeta?.() || { healthy: true, sources: [] };
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

  const detectionUnknown = detectionMeta.healthy === false;
  const probeUnknownSet = new Set(
    (Array.isArray(detectionMeta?.probe?.unknown) ? detectionMeta.probe.unknown : [])
      .map((x) => T.normalizeName(x))
      .filter(Boolean)
  );
  const probeOfflineSet = new Set(
    (Array.isArray(detectionMeta?.probe?.offline) ? detectionMeta.probe.offline : [])
      .map((x) => T.normalizeName(x))
      .filter(Boolean)
  );

  // A rendered Twitch channel page is stronger evidence than the anonymous
  // HTML probe when the latter can only say UNKNOWN. This lets owned tabs close
  // after Twitch visibly renders its offline state instead of lingering forever.
  const domOfflineSet = new Set();
  for (const rec of listTabRecords()) {
    if (!rec?.owned || !rec?.expectedChannel) continue;
    const page = rec?.lastSnapshot?.page;
    if (!page?.offlineDom || page?.raid) continue;
    const expected = T.normalizeName(rec.expectedChannel);
    const actual = T.normalizeName(page.channel || rec.actualChannel);
    if (expected && (!actual || actual === expected)) domOfflineSet.add(expected);
  }

  if (detectionUnknown || probeUnknownSet.size) {
    await event("LIVE_DETECTION_UNKNOWN", {
      ...detectionMeta,
      channel_unknown: [...probeUnknownSet]
    });
    log("poll_detection_unknown_preserve_tabs", {
      global_unknown: detectionUnknown,
      channel_unknown: [...probeUnknownSet]
    });
  }

  try {
    // The dedicated playback window is entirely manager-owned space. Sweep any
    // unmanaged raid redirects there before planning; these are the orphan tabs
    // that could otherwise pile up after repeated Twitch raids.
    await cleanupManagerWindowOrphanRaidTabs("poll_pre_reconcile");

    // Ownership records can occasionally be lost/released while a Twitch tab
    // remains inside the dedicated TTM window. Those tabs are not user tabs: the
    // manager window itself is TTM-owned. If the live probe positively reports
    // one of those orphan tabs OFFLINE for 90 seconds, remove it so ended streams
    // cannot sit there for hours (for example after a service-worker/state reset).
    await cleanupManagerWindowOrphanOfflineTabs({
      offline: [...probeOfflineSet],
      unknown: [...probeUnknownSet],
      live: liveList
    }, "poll_pre_reconcile");

    // A Twitch raid is positive state, not an UNKNOWN live-detection result.
    // Remove TTM-owned raid redirects before planning so their old source-channel
    // ownership cannot occupy capacity or cause replacement tabs.
    await closeRaidRedirectTabsThatAreNowUnwanted(liveList);

    const now = Date.now();
    const managedNow = await listManaged();
    const liveNowSet = new Set(liveList);

    for (const ch of managedNow) {
      if (liveNowSet.has(ch)) {
        missingLiveSinceByChannel.delete(ch);
      } else if (domOfflineSet.has(ch)) {
        if (!missingLiveSinceByChannel.has(ch)) missingLiveSinceByChannel.set(ch, now);
      } else if (detectionUnknown || probeUnknownSet.has(ch)) {
        // UNKNOWN must not START an offline clock, but it also must not erase a
        // clock that already began from a positive OFFLINE/DOM-offline result.
        // Twitch probes can intermittently flip OFFLINE -> UNKNOWN -> OFFLINE;
        // resetting here allowed genuinely ended streams to survive for hours.
      } else if (probeOfflineSet.has(ch) || !detectionMeta?.probe?.checked) {
        if (!missingLiveSinceByChannel.has(ch)) missingLiveSinceByChannel.set(ch, now);
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
        if (domOfflineSet.has(ch)) {
          return !!missingSince && now - missingSince < LIVE_MISS_CLOSE_DELAY_MS;
        }
        if (detectionUnknown || probeUnknownSet.has(ch)) return true;
        if (!missingSince) return false;
        return now - missingSince < LIVE_MISS_CLOSE_DELAY_MS;
      })
    ]);

    log("poll_reconcile", {
      detected_live: liveList,
      managed_now: managedNow,
      debounced_live: debouncedLiveList,
      debounce_ms: LIVE_MISS_CLOSE_DELAY_MS,
      probe_unknown: [...probeUnknownSet],
      probe_offline: [...probeOfflineSet],
      dom_offline: [...domOfflineSet]
    });

        const shouldSkipMassClose =
      detectionUnknown ||
      (
        debouncedLiveList.length === 0 &&
        managedNow.length > 0 &&
        consecutiveEmptyLivePolls < 4
      );

    if (shouldSkipMassClose) {
      log("poll_skip_mass_close_once", {
        detected_live: liveList,
        managed_now: managedNow,
        consecutiveEmptyLivePolls,
        detectionUnknown,
        detectionMeta
      });
    } else {
      await reconcileTabs(debouncedLiveList, state.settings);
      await closeManagedChannelsThatAreNowBlocked();
    }
  } catch (e) {
    log("poll_reconcile_error", String(e));
  }

  try {
    const managed = await listManaged();

    if (!detectionUnknown) {
      state.lastLive = Array.isArray(liveList) ? liveList.slice() : [];
    }
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
      force: !!force,
      detection: detectionMeta
    });

    return {
      ok: true,
      live_count: Number(state.lastLiveCount || 0),
      live_channels: state.lastLive.slice(),
      open_count: managed.length,
      open_channels: managed.slice(),
      max_tabs: state.settings.max_tabs,
      force: !!force,
      detection: detectionMeta
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

async function poll(options = {}) {
  if (activePollPromise) {
    log("poll_join_existing", { force: !!options?.force, sequence: pollSequence });
    return activePollPromise;
  }

  const sequence = ++pollSequence;
  activePollPromise = (async () => {
    await event("POLL_START", { sequence, force: !!options?.force });
    try {
      const result = await pollImpl(options, sequence);
      await event("POLL_FINISH", {
        sequence,
        ok: result?.ok !== false,
        live_count: Number(result?.live_count || 0),
        open_count: Number(result?.open_count || 0)
      });
      return result;
    } finally {
      activePollPromise = null;
    }
  })();

  return activePollPromise;
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

    try {
      await cleanupLegacyOrphanRaidTabs();
    } catch (e) {
      log("boot_legacy_raid_cleanup_error", String(e));
    }

    try {
      await cleanupManagerWindowOrphanRaidTabs("boot_manager_raid_sweep");
    } catch (e) {
      log("boot_manager_raid_cleanup_error", String(e));
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