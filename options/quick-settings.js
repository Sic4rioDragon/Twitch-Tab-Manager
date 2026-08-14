import { $, ok, err, rpc, uniqNames } from "./core.js";
import { clampConfig, getStoredConfig, readStorage, writeConfigEverywhere } from "./storage.js";

function getEditorLines(selector) {
  return uniqNames(($(selector)?.value || "").split("\n"));
}

function buildHierarchyUnion(cfg, follows, priority, blacklist) {
  return uniqNames([
    ...(cfg.favorites || []),
    ...(priority || []),
    ...(follows || []),
    ...(cfg.rotation || []),
    ...(cfg.low_priority || [])
  ]);
}

function validateSpecialBuckets(cfg, priority, blacklist) {
  const buckets = {
    favorites: uniqNames(cfg.favorites || []),
    priority: uniqNames(priority || []),
    rotation: uniqNames(cfg.rotation || []),
    low_priority: uniqNames(cfg.low_priority || []),
    blacklist: uniqNames(blacklist || [])
  };

  const seen = new Map();
  for (const [bucket, list] of Object.entries(buckets)) {
    for (const ch of list) {
      if (seen.has(ch)) {
        return { ok: false, channel: ch, first: seen.get(ch), second: bucket };
      }
      seen.set(ch, bucket);
    }
  }
  return { ok: true };
}

function bucketLabel(bucket) {
  return String(bucket || "").replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

export function fillQuickSettings(cfg) {
  const liveSource = $("#liveSource");
  const checkInterval = $("#checkIntervalSec");
  const maxTabs = $("#maxTabs");
  const enabled = $("#enabledSelect");
  const forceUnmute = $("#forceUnmute");
  const unmuteStreams = $("#unmuteStreams");
  const forceResume = $("#forceResume");
  const autoplayStreams = $("#autoplayStreams");
  const softWakeTabs = $("#softWakeTabs");
  const softWakeFocusedOnly = $("#softWakeFocusedOnly");
  const closeUnfollowedTabs = $("#closeUnfollowedTabs");
  const allowExtraTwitchTabs = $("#allowExtraTwitchTabs");
  const tempWhitelistHours = $("#tempWhitelistHours");
  const blacklistBox = $("#blacklistBox");

  if (liveSource) liveSource.value = cfg.live_source || "auto";
  if (checkInterval) checkInterval.value = String(cfg.check_interval_sec ?? 60);
  if (maxTabs) maxTabs.value = String(cfg.max_tabs ?? 4);
  if (enabled) enabled.value = String(cfg.enabled !== false);

  if (forceUnmute) forceUnmute.checked = !!cfg.force_unmute;
  if (unmuteStreams) unmuteStreams.checked = !!cfg.unmute_streams;
  if (forceResume) forceResume.checked = !!cfg.force_resume;
  if (autoplayStreams) autoplayStreams.checked = !!cfg.autoplay_streams;
  if (softWakeTabs) softWakeTabs.checked = !!cfg.soft_wake_tabs;
  if (softWakeFocusedOnly) softWakeFocusedOnly.checked = !!cfg.soft_wake_only_when_browser_focused;
  if (closeUnfollowedTabs) closeUnfollowedTabs.checked = !!cfg.close_unfollowed_tabs;
  if (allowExtraTwitchTabs) allowExtraTwitchTabs.checked = !!cfg.allow_extra_twitch_tabs;

  if (tempWhitelistHours) tempWhitelistHours.value = String(cfg.temp_whitelist_hours ?? 12);
  if (blacklistBox) blacklistBox.value = uniqNames(cfg.blacklist).join("\n");
}

export function readQuickSettings(baseCfg = {}) {
  return clampConfig({
    ...baseCfg,
    live_source: $("#liveSource")?.value || baseCfg.live_source || "auto",
    check_interval_sec: Number($("#checkIntervalSec")?.value || baseCfg.check_interval_sec || 60),
    max_tabs: Number($("#maxTabs")?.value || baseCfg.max_tabs || 4),
    enabled: $("#enabledSelect")?.value !== "false",
    force_unmute: !!$("#forceUnmute")?.checked,
    unmute_streams: !!$("#unmuteStreams")?.checked,
    force_resume: !!$("#forceResume")?.checked,
    autoplay_streams: !!$("#autoplayStreams")?.checked,
    soft_wake_tabs: !!$("#softWakeTabs")?.checked,
    soft_wake_only_when_browser_focused: !!$("#softWakeFocusedOnly")?.checked,
    close_unfollowed_tabs: !!$("#closeUnfollowedTabs")?.checked,
    allow_extra_twitch_tabs: !!$("#allowExtraTwitchTabs")?.checked,
    temp_whitelist_hours: Number($("#tempWhitelistHours")?.value || baseCfg.temp_whitelist_hours || 12),
    blacklist: getEditorLines("#blacklistBox"),

    client_id: baseCfg.client_id || "",
    access_token: baseCfg.access_token || "",
    temp_whitelist_entries: baseCfg.temp_whitelist_entries || {},
    follows: Array.isArray(baseCfg.follows) ? baseCfg.follows : [],
    priority: Array.isArray(baseCfg.priority) ? baseCfg.priority : [],
    followUnion: Array.isArray(baseCfg.followUnion) ? baseCfg.followUnion : []
  });
}

export async function saveQuickSettings({ reload = false } = {}) {
  try {
    const bag = await readStorage();
    const cfg = getStoredConfig(bag);

    const follows = getEditorLines("#fol").length
      ? getEditorLines("#fol")
      : uniqNames(Array.isArray(bag.follows) ? bag.follows : cfg.follows);

    const priority = getEditorLines("#priorityBox").length
      ? getEditorLines("#priorityBox")
      : uniqNames(Array.isArray(bag.priority) ? bag.priority : cfg.priority);

    const blacklist = getEditorLines("#blacklistBox").length
      ? getEditorLines("#blacklistBox")
      : uniqNames(Array.isArray(cfg.blacklist) ? cfg.blacklist : []);

    const validation = validateSpecialBuckets(cfg, priority, blacklist);
    if (!validation.ok) {
      err(
        $("#quickStatus"),
        `Channel "${validation.channel}" is already in ${bucketLabel(validation.first)} and cannot also be in ${bucketLabel(validation.second)}. It can still remain in the normal Follows list.`
      );
      return;
    }

    const baseCfg = clampConfig({
      ...cfg,
      follows,
      priority,
      blacklist,
      followUnion: buildHierarchyUnion(cfg, follows, priority, blacklist)
    });

    const nextCfg = readQuickSettings(baseCfg);
    nextCfg.follows = follows;
    nextCfg.priority = priority;
    nextCfg.blacklist = blacklist;
    nextCfg.followUnion = buildHierarchyUnion(nextCfg, follows, priority, blacklist);
    nextCfg.client_id = baseCfg.client_id || "";
    nextCfg.access_token = baseCfg.access_token || "";
    nextCfg.temp_whitelist_entries = baseCfg.temp_whitelist_entries || {};

    const saved = await writeConfigEverywhere(nextCfg, { reason: "quick_settings_save" });

    if ($("#cfg")) $("#cfg").value = JSON.stringify(saved, null, 2);
    if ($("#fol")) $("#fol").value = saved.follows.join("\n");
    if ($("#priorityBox")) $("#priorityBox").value = saved.priority.join("\n");
    if ($("#blacklistBox")) $("#blacklistBox").value = saved.blacklist.join("\n");

    if (reload) {
      const resp = await rpc("ttm/reload_config");
      if (resp?.ok) ok($("#quickStatus"), "Quick settings saved and reloaded.");
      else err($("#quickStatus"), "Saved quick settings, but reload failed.");
      return;
    }

    ok($("#quickStatus"), "Quick settings saved.");
  } catch (e) {
    err($("#quickStatus"), `Quick settings save failed: ${e?.message || e || "unknown error"}`);
  }
}

export function setupQuickSettings() {
  $("#quickSave")?.addEventListener("click", () => {
    saveQuickSettings({ reload: false });
  });

  $("#quickApplyReload")?.addEventListener("click", () => {
    saveQuickSettings({ reload: true });
  });
}