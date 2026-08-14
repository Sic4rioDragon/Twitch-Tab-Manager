import { $, folTA, downloadText, err, note, ok, readFileText, rpc, uniqNames } from "./core.js";
import { clampConfig, getStoredConfig, loadUI, packagedFollows, readStorage, writeConfigEverywhere } from "./storage.js";

const FOLLOW_SYNC_HISTORY_KEY = "ttm_follow_sync_history_v1";
const FOLLOW_SYNC_LAST_KEY = "ttm_follow_sync_last_v1";
const FOLLOW_SYNC_LIMIT = 20;

function ensureFollowSyncHistoryUI() {
  if ($("#followSyncHistoryWrap")) return;

  const status = $("#folStatus");
  if (!status || !status.parentElement) return;

  const wrap = document.createElement("div");
  wrap.id = "followSyncHistoryWrap";
  wrap.style.marginTop = "12px";

  wrap.innerHTML = `
    <div class="small" style="margin-bottom:6px;"><strong>Last Follow Sync</strong></div>
    <pre id="followSyncHistoryOut" class="miniTA" style="min-height:120px; white-space:pre-wrap;"></pre>
  `;

  status.parentElement.insertBefore(wrap, status.nextSibling);
}

function formatWhen(iso) {
  if (!iso) return "never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString();
}

async function readFollowSyncHistory() {
  const got = await chrome.storage.local.get([FOLLOW_SYNC_HISTORY_KEY, FOLLOW_SYNC_LAST_KEY]);
  return {
    last: got[FOLLOW_SYNC_LAST_KEY] || null,
    history: Array.isArray(got[FOLLOW_SYNC_HISTORY_KEY]) ? got[FOLLOW_SYNC_HISTORY_KEY] : []
  };
}

function getBucketMapFromConfig(cfg) {
  return {
    favorites: uniqNames(cfg.favorites || []),
    priority: uniqNames(cfg.priority || []),
    follows: uniqNames(cfg.follows || []),
    rotation: uniqNames(cfg.rotation || []),
    low_priority: uniqNames(cfg.low_priority || []),
    blacklist: uniqNames(cfg.blacklist || [])
  };
}

function findChannelBucket(channel, bucketMap) {
  const ch = String(channel || "").trim().toLowerCase();
  if (!ch) return "";

  for (const [bucket, list] of Object.entries(bucketMap)) {
    if (list.includes(ch)) return bucket;
  }

  return "";
}

const EXCLUSIVE_BUCKETS = ["favorites", "priority", "rotation", "low_priority", "blacklist"];

function validateExclusiveBuckets(bucketMap) {
  const seen = new Map();

  // The normal Follows list is the base Twitch-follow list and is allowed to
  // overlap with one special bucket. The special bucket decides hierarchy.
  for (const bucket of EXCLUSIVE_BUCKETS) {
    const list = uniqNames(bucketMap?.[bucket] || []);
    for (const ch of list) {
      if (seen.has(ch)) {
        return {
          ok: false,
          channel: ch,
          first: seen.get(ch),
          second: bucket
        };
      }
      seen.set(ch, bucket);
    }
  }

  return { ok: true };
}

function buildBucketMapFromInputs(cfg, overrides = {}) {
  return {
    favorites: uniqNames(overrides.favorites ?? cfg.favorites ?? []),
    priority: uniqNames(overrides.priority ?? cfg.priority ?? []),
    follows: uniqNames(overrides.follows ?? cfg.follows ?? []),
    rotation: uniqNames(overrides.rotation ?? cfg.rotation ?? []),
    low_priority: uniqNames(overrides.low_priority ?? cfg.low_priority ?? []),
    blacklist: uniqNames(overrides.blacklist ?? cfg.blacklist ?? [])
  };
}

function buildFollowUnionFromBucketMap(bucketMap) {
  return uniqNames([
    ...(bucketMap.favorites || []),
    ...(bucketMap.priority || []),
    ...(bucketMap.follows || []),
    ...(bucketMap.rotation || []),
    ...(bucketMap.low_priority || [])
  ]);
}

function bucketLabel(bucket) {
  return String(bucket || "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

function showBucketConflict(statusEl, validation) {
  err(
    statusEl,
    `Channel "${validation.channel}" is already in ${bucketLabel(validation.first)} and cannot also be in ${bucketLabel(validation.second)}. It can still remain in the normal Follows list.`
  );
}

function ensureAdvancedBucketsUI() {
  if ($("#advancedBucketsWrap")) return;

  const fol = $("#fol");
  if (!fol || !fol.parentElement) return;

  const wrap = document.createElement("div");
  wrap.id = "advancedBucketsWrap";
  wrap.style.marginTop = "16px";

  wrap.innerHTML = `
    <div class="grid">
      <div class="card">
        <h4>Favorites</h4>
        <p class="small">Favorites are your highest-priority channels. When live, they should be preferred above all other normal channel groups and should not be rotated out.</p>
        <textarea id="favoritesBox" class="miniTA" placeholder="one username per line"></textarea>
      </div>

      <div class="card">
        <h4>Rotation</h4>
        <p class="small">Rotation channels use dedicated rotation slots. They do not take over your stable favorites / priority slots.</p>
        <textarea id="rotationBox" class="miniTA" placeholder="one username per line"></textarea>
      </div>

      <div class="card">
        <h4>Low Priority</h4>
        <p class="small">Low priority channels only open if there are free slots left after favorites, priority channels, normal followed channels, and rotation decisions. They are the first channels to lose a slot when something more important goes live.</p>
        <textarea id="lowPriorityBox" class="miniTA" placeholder="one username per line"></textarea>
      </div>

      <div class="card">
        <h4>Rotation Settings</h4>
        <label class="field">
          <span class="label-title">Enable rotation</span>
          <select id="rotationEnabled">
            <option value="false">Disabled</option>
            <option value="true">Enabled</option>
          </select>
        </label>

        <label class="field" style="margin-top:10px;">
          <span class="label-title">Rotation interval (minutes)</span>
          <input id="rotationIntervalMin" type="number" min="5" step="1" />
        </label>

        <label class="field" style="margin-top:10px;">
          <span class="label-title">Dedicated rotation slots</span>
          <input id="rotationSlotCount" type="number" min="0" step="1" />
        </label>

        <label class="field" style="margin-top:10px;">
          <span class="label-title">Rotation cooldown (minutes)</span>
          <input id="rotationCooldownMin" type="number" min="5" step="1" />
        </label>

        <label class="field" style="margin-top:10px;">
          <span class="label-title">Include low priority in rotation</span>
          <select id="rotationIncludeLowPriority">
            <option value="false">No</option>
            <option value="true">Yes</option>
          </select>
        </label>
      </div>
    </div>
  `;

  fol.parentElement.appendChild(wrap);
}

async function pushFollowSyncHistory(entry) {
  const got = await chrome.storage.local.get([FOLLOW_SYNC_HISTORY_KEY]);
  const history = Array.isArray(got[FOLLOW_SYNC_HISTORY_KEY]) ? got[FOLLOW_SYNC_HISTORY_KEY] : [];

  history.push(entry);
  while (history.length > FOLLOW_SYNC_LIMIT) history.shift();

  await chrome.storage.local.set({
    [FOLLOW_SYNC_LAST_KEY]: entry,
    [FOLLOW_SYNC_HISTORY_KEY]: history
  });
}

function renderFollowSyncHistory(last) {
  ensureFollowSyncHistoryUI();

  const out = $("#followSyncHistoryOut");
  if (!out) return;

  if (!last) {
    out.textContent = "No follow sync has been recorded yet.";
    return;
  }

  const added = Array.isArray(last.added) ? last.added : [];
  const removed = Array.isArray(last.removed) ? last.removed : [];

  out.textContent =
    `When: ${formatWhen(last.at)}\n` +
    `Mode: ${last.mode || "unknown"}\n` +
    `Fetched: ${last.count ?? 0}\n` +
    `Added (${added.length}): ${added.length ? added.join(", ") : "none"}\n` +
    `Removed (${removed.length}): ${removed.length ? removed.join(", ") : "none"}`;
}

async function refreshFollowSyncHistoryUI() {
  const { last } = await readFollowSyncHistory();
  renderFollowSyncHistory(last);
}

function populateAdvancedBucketsUI(cfg) {
  if ($("#favoritesBox")) $("#favoritesBox").value = (cfg.favorites || []).join("\n");
  if ($("#rotationBox")) $("#rotationBox").value = (cfg.rotation || []).join("\n");
  if ($("#lowPriorityBox")) $("#lowPriorityBox").value = (cfg.low_priority || []).join("\n");

  if ($("#rotationEnabled")) $("#rotationEnabled").value = String(!!cfg.rotation_enabled);
  if ($("#rotationIntervalMin")) $("#rotationIntervalMin").value = String(cfg.rotation_interval_min ?? 30);
  if ($("#rotationSlotCount")) $("#rotationSlotCount").value = String(cfg.rotation_slot_count ?? 1);
  if ($("#rotationCooldownMin")) $("#rotationCooldownMin").value = String(cfg.rotation_cooldown_min ?? 30);
  if ($("#rotationIncludeLowPriority")) {
    $("#rotationIncludeLowPriority").value = String(!!cfg.rotation_include_low_priority);
  }
}

export function setupFollowsPanel() {
  ensureFollowSyncHistoryUI();
  ensureAdvancedBucketsUI();
  refreshFollowSyncHistoryUI().catch(() => {});

    readStorage()
    .then((bag) => {
      const cfg = getStoredConfig(bag);
      populateAdvancedBucketsUI(cfg);
    })
    .catch(() => {});

    $("#saveFol")?.addEventListener("click", async () => {
    try {
      const bag = await readStorage();
      const cfg = getStoredConfig(bag);
      const follows = uniqNames((folTA()?.value || "").split("\n"));

      // Follows is the base list from Twitch, so channels are allowed to also
      // exist in one special bucket such as Favorites or Priority.
      const bucketMap = buildBucketMapFromInputs(cfg, { follows });

      const clean = await writeConfigEverywhere(clampConfig({
        ...cfg,
        follows,
        followUnion: buildFollowUnionFromBucketMap(bucketMap)
      }));

      if (folTA()) folTA().value = clean.follows.join("\n");
      if ($("#cfg")) $("#cfg").value = JSON.stringify(clean, null, 2);
      ok($("#folStatus"), "Follows saved.");
    } catch (e) {
      err($("#folStatus"), `Follows save failed: ${e.message || e}`);
    }
  });

  $("#exportFol")?.addEventListener("click", () => {
    downloadText("ttm-follows.txt", folTA()?.value || "", "text/plain");
  });

  $("#importFol")?.addEventListener("click", () => {
    $("#fileFol")?.click();
  });

  $("#fileFol")?.addEventListener("change", async (ev) => {
    const file = ev.target?.files?.[0];
    if (!file) return;

    try {
      const text = await readFileText(file);
      const follows = uniqNames(text.split(/\r?\n/));
      if (folTA()) folTA().value = follows.join("\n");
      note($("#folStatus"), "Follows imported into editor. Save to apply.");
    } catch (e) {
      err($("#folStatus"), `Follows import failed: ${e.message || e}`);
    }

    ev.target.value = "";
  });

  $("#resetFol")?.addEventListener("click", async () => {
    const follows = await packagedFollows();
    if (folTA()) folTA().value = follows.join("\n");
    note($("#folStatus"), "Follows reset to packaged follows. Save to apply.");
  });

  $("#refreshFol")?.addEventListener("click", async () => {
    await loadUI();

    try {
      const bag = await readStorage();
      const cfg = getStoredConfig(bag);
      populateAdvancedBucketsUI(cfg);
    } catch {}

    await refreshFollowSyncHistoryUI();
    ok($("#folStatus"), "Follows refreshed from storage.");
  });

  $("#fetchFollows")?.addEventListener("click", async () => {
    const mode = $("#fetchMode")?.value || "active";
    note($("#folStatus"), "Fetching follows...");

    const bag = await readStorage();
    const cfg = getStoredConfig(bag);
    const before = uniqNames(Array.isArray(cfg.follows) ? cfg.follows : []);

    const resp = await rpc("TTM_FETCH_FOLLOWS", { mode });
    if (!resp?.ok) {
      err($("#folStatus"), resp?.error || "Fetch follows failed.");
      return;
    }

    const follows = uniqNames(resp.usernames || []);
    if (folTA()) folTA().value = follows.join("\n");

    const added = follows.filter((x) => !before.includes(x));
    const removed = before.filter((x) => !follows.includes(x));

    const entry = {
      at: new Date().toISOString(),
      mode,
      count: follows.length,
      added,
      removed
    };

    await pushFollowSyncHistory(entry);
    renderFollowSyncHistory(entry);

    note(
      $("#folStatus"),
      `Fetched ${follows.length} follows. Added ${added.length}, removed ${removed.length}. Save to apply.`
    );
  });

  $("#forcePoll")?.addEventListener("click", async () => {
    note($("#folStatus"), "Requesting force poll...");
    const resp = await rpc("ttm/force_poll");
    if (resp?.ok) ok($("#folStatus"), "Force poll requested.");
    else err($("#folStatus"), resp?.error || "Force poll failed.");
  });

  $("#reloadConfig")?.addEventListener("click", async () => {
    note($("#folStatus"), "Reloading config...");
    const resp = await rpc("ttm/reload_config");
    if (resp?.ok) ok($("#folStatus"), "Config reloaded in background.");
    else err($("#folStatus"), resp?.error || "Reload config failed.");
  });

  $("#favoritesBox")?.addEventListener("change", async () => {
    try {
      const bag = await readStorage();
      const cfg = getStoredConfig(bag);
      const favorites = uniqNames(($("#favoritesBox")?.value || "").split("\n"));

      const bucketMap = buildBucketMapFromInputs(cfg, { favorites });
      const validation = validateExclusiveBuckets(bucketMap);
      if (!validation.ok) {
        showBucketConflict($("#folStatus"), validation);
        return;
      }

      const clean = await writeConfigEverywhere(clampConfig({
        ...cfg,
        favorites,
        followUnion: buildFollowUnionFromBucketMap(bucketMap)
      }));

      $("#favoritesBox").value = clean.favorites.join("\n");
      if ($("#cfg")) $("#cfg").value = JSON.stringify(clean, null, 2);
      ok($("#folStatus"), "Favorites saved.");
    } catch (e) {
      err($("#folStatus"), `Favorites save failed: ${e.message || e}`);
    }
  });

  $("#rotationBox")?.addEventListener("change", async () => {
    try {
      const bag = await readStorage();
      const cfg = getStoredConfig(bag);
      const rotation = uniqNames(($("#rotationBox")?.value || "").split("\n"));

      const bucketMap = buildBucketMapFromInputs(cfg, { rotation });
      const validation = validateExclusiveBuckets(bucketMap);
      if (!validation.ok) {
        showBucketConflict($("#folStatus"), validation);
        return;
      }

      const clean = await writeConfigEverywhere(clampConfig({
        ...cfg,
        rotation,
        followUnion: buildFollowUnionFromBucketMap(bucketMap)
      }));

      $("#rotationBox").value = clean.rotation.join("\n");
      if ($("#cfg")) $("#cfg").value = JSON.stringify(clean, null, 2);
      ok($("#folStatus"), "Rotation channels saved.");
    } catch (e) {
      err($("#folStatus"), `Rotation save failed: ${e.message || e}`);
    }
  });

  $("#lowPriorityBox")?.addEventListener("change", async () => {
    try {
      const bag = await readStorage();
      const cfg = getStoredConfig(bag);
      const low_priority = uniqNames(($("#lowPriorityBox")?.value || "").split("\n"));

      const bucketMap = buildBucketMapFromInputs(cfg, { low_priority });
      const validation = validateExclusiveBuckets(bucketMap);
      if (!validation.ok) {
        showBucketConflict($("#folStatus"), validation);
        return;
      }

      const clean = await writeConfigEverywhere(clampConfig({
        ...cfg,
        low_priority,
        followUnion: buildFollowUnionFromBucketMap(bucketMap)
      }));

      $("#lowPriorityBox").value = clean.low_priority.join("\n");
      if ($("#cfg")) $("#cfg").value = JSON.stringify(clean, null, 2);
      ok($("#folStatus"), "Low priority channels saved.");
    } catch (e) {
      err($("#folStatus"), `Low priority save failed: ${e.message || e}`);
    }
  });

  const saveRotationSettings = async () => {
    try {
      const bag = await readStorage();
      const cfg = getStoredConfig(bag);

      const clean = await writeConfigEverywhere(clampConfig({
        ...cfg,
        rotation_enabled: $("#rotationEnabled")?.value === "true",
        rotation_interval_min: Number($("#rotationIntervalMin")?.value || cfg.rotation_interval_min || 30),
        rotation_slot_count: Number($("#rotationSlotCount")?.value || cfg.rotation_slot_count || 1),
        rotation_cooldown_min: Number($("#rotationCooldownMin")?.value || cfg.rotation_cooldown_min || 30),
        rotation_include_low_priority: $("#rotationIncludeLowPriority")?.value === "true"
      }));

      if ($("#cfg")) $("#cfg").value = JSON.stringify(clean, null, 2);
      ok($("#folStatus"), "Rotation settings saved.");
    } catch (e) {
      err($("#folStatus"), `Rotation settings save failed: ${e.message || e}`);
    }
  };

  $("#rotationEnabled")?.addEventListener("change", saveRotationSettings);
  $("#rotationIntervalMin")?.addEventListener("change", saveRotationSettings);
  $("#rotationSlotCount")?.addEventListener("change", saveRotationSettings);
  $("#rotationCooldownMin")?.addEventListener("change", saveRotationSettings);
  $("#rotationIncludeLowPriority")?.addEventListener("change", saveRotationSettings);
}

export function setupPriorityEditor() {
  $("#prioritySave")?.addEventListener("click", async () => {
    try {
      const bag = await readStorage();
      const cfg = getStoredConfig(bag);
      const priority = uniqNames(($("#priorityBox")?.value || "").split("\n"));

      const bucketMap = buildBucketMapFromInputs(cfg, { priority });
      const validation = validateExclusiveBuckets(bucketMap);
      if (!validation.ok) {
        showBucketConflict($("#folStatus"), validation);
        return;
      }

      const clean = await writeConfigEverywhere(clampConfig({
        ...cfg,
        priority,
        followUnion: buildFollowUnionFromBucketMap(bucketMap)
      }));

      if ($("#priorityBox")) $("#priorityBox").value = clean.priority.join("\n");
      if ($("#cfg")) $("#cfg").value = JSON.stringify(clean, null, 2);

      ok($("#folStatus"), "Priority saved.");
    } catch (e) {
      err($("#folStatus"), `Priority save failed: ${e.message || e}`);
    }
  });
}