import { $, err, note, ok, rpc } from "./core.js";
import { clampConfig, getStoredConfig, readStorage, writeConfigEverywhere } from "./storage.js";

function ensureUI() {
  if ($("#streakRescueCard")) return;

  const stack = $("#panel-settings .stack");
  if (!stack) return;

  const quickCard = Array.from(stack.querySelectorAll(":scope > section.card")).find(
    (section) => section.querySelector("h2")?.textContent?.trim() === "Quick Settings"
  );

  const card = document.createElement("section");
  card.className = "card";
  card.id = "streakRescueCard";
  card.innerHTML = `
    <h2>Streak Rescue</h2>
    <p class="small">Detects Twitch's <strong>Save your Streak</strong> entries. In Automatic mode, one dedicated background tab watches the rescue VOD for at least 5 minutes, then waits for Twitch to stop showing that streak as at risk. If Twitch does not confirm it, the tab keeps watching for the extra safety time.</p>

    <div class="grid">
      <div class="subcard">
        <label class="checkbox-row"><input id="streakRescueEnabled" type="checkbox"> Enable Streak Rescue</label>

        <label class="field" style="margin-top:10px;">
          <span class="label-title">Mode</span>
          <select id="streakRescueMode">
            <option value="detect">Detect only</option>
            <option value="auto">Automatic rescue</option>
          </select>
        </label>

        <div class="two" style="margin-top:10px;">
          <label class="field">
            <span class="label-title">Required VOD watch (min)</span>
            <input id="streakRequiredMin" type="number" min="5" step="1">
          </label>

          <label class="field">
            <span class="label-title">Extra safety time (min)</span>
            <input id="streakGraceMin" type="number" min="0" step="1">
          </label>

          <label class="field">
            <span class="label-title">Confirmation check (sec)</span>
            <input id="streakConfirmSec" type="number" min="15" step="5">
          </label>

          <label class="field">
            <span class="label-title">Retry after failure (min)</span>
            <input id="streakRetryMin" type="number" min="5" step="1">
          </label>
        </div>

        <p class="small" style="margin-top:10px;">Dedicated rescue slots: <strong>1</strong> for now. The rescue tab is opened in the background and is never focused by the extension.</p>

        <div class="btns">
          <button id="streakRescueSave" class="primary">Save Streak Rescue</button>
          <button id="streakRescueRefresh">Refresh Status</button>
          <button id="streakRescueTick">Run Rescue Check</button>
        </div>
        <div id="streakRescueSaveStatus" class="status"></div>
      </div>

      <div class="subcard">
        <h4>Rescue Status</h4>
        <pre id="streakRescueStatus" class="miniTA" style="white-space:pre-wrap; min-height:180px;"></pre>
      </div>
    </div>
  `;

  if (quickCard?.nextSibling) stack.insertBefore(card, quickCard.nextSibling);
  else stack.appendChild(card);
}

function populate(cfg) {
  if ($("#streakRescueEnabled")) $("#streakRescueEnabled").checked = !!cfg.streak_rescue_enabled;
  if ($("#streakRescueMode")) $("#streakRescueMode").value = String(cfg.streak_rescue_mode || "detect");
  if ($("#streakRequiredMin")) $("#streakRequiredMin").value = String(cfg.streak_rescue_required_watch_min ?? 5);
  if ($("#streakGraceMin")) $("#streakGraceMin").value = String(cfg.streak_rescue_grace_min ?? 10);
  if ($("#streakConfirmSec")) $("#streakConfirmSec").value = String(cfg.streak_rescue_confirm_check_sec ?? 30);
  if ($("#streakRetryMin")) $("#streakRetryMin").value = String(cfg.streak_rescue_retry_min ?? 15);
}

function formatMs(ms) {
  const total = Math.max(0, Math.round(Number(ms || 0) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

function renderStatus(resp) {
  const out = $("#streakRescueStatus");
  if (!out) return;

  if (!resp?.ok) {
    out.textContent = `Status unavailable: ${resp?.error || "unknown error"}`;
    return;
  }

  const s = resp.status || {};
  const lines = [
    `Enabled: ${s.enabled ? "yes" : "no"}`,
    `Mode: ${s.mode || "detect"}`,
    `At risk found in last scan: ${s.last_scan_count ?? 0}`,
    `Queued: ${s.queue_count ?? 0}`
  ];

  if (s.active) {
    lines.push("", "ACTIVE RESCUE");
    lines.push(`Channel: ${s.active.channel}`);
    lines.push(`Streak: ${s.active.streak || 0}`);
    lines.push(`Status: ${s.active.status || "watching"}`);
    lines.push(`Watched: ${formatMs(s.active.watched_ms)}`);
    lines.push(`Required remaining: ${formatMs(s.active.required_remaining_ms)}`);
    lines.push(`Safety remaining: ${formatMs(s.active.safety_remaining_ms)}`);
    lines.push(`Playback: ${s.active.playback_ok ? "OK" : "waiting / stalled"}`);
    lines.push(`Tab: ${s.active.tab_id ?? "?"}`);
  } else {
    lines.push("", "No rescue is currently running.");
  }

  if (Array.isArray(s.queue) && s.queue.length) {
    lines.push("", "QUEUE");
    for (const item of s.queue.slice(0, 8)) {
      lines.push(`- ${item.channel} (streak ${item.streak || 0})`);
    }
  }

  if (Array.isArray(s.history) && s.history.length) {
    const last = s.history[s.history.length - 1];
    lines.push("", `Last result: ${last.channel || "?"} — ${last.status || "?"}`);
  }

  out.textContent = lines.join("\n");
}

async function refreshStatus() {
  renderStatus(await rpc("ttm/streak_status"));
}

async function saveSettings() {
  try {
    const bag = await readStorage();
    const cfg = getStoredConfig(bag);
    const next = clampConfig({
      ...cfg,
      streak_rescue_enabled: !!$("#streakRescueEnabled")?.checked,
      streak_rescue_mode: $("#streakRescueMode")?.value || "detect",
      streak_rescue_required_watch_min: Number($("#streakRequiredMin")?.value || 5),
      streak_rescue_grace_min: Number($("#streakGraceMin")?.value || 10),
      streak_rescue_confirm_check_sec: Number($("#streakConfirmSec")?.value || 30),
      streak_rescue_retry_min: Number($("#streakRetryMin")?.value || 15),
      streak_rescue_slots: 1
    });

    await writeConfigEverywhere(next, { reason: "streak_rescue_save" });
    const reload = await rpc("ttm/reload_config");
    if (!reload?.ok) {
      err($("#streakRescueSaveStatus"), "Saved, but background reload failed.");
      return;
    }

    ok($("#streakRescueSaveStatus"), "Streak Rescue saved and reloaded.");
    await refreshStatus();
  } catch (e) {
    err($("#streakRescueSaveStatus"), `Streak Rescue save failed: ${e?.message || e}`);
  }
}

export function setupStreakRescuePanel() {
  ensureUI();

  readStorage()
    .then((bag) => populate(getStoredConfig(bag)))
    .catch(() => {});

  $("#streakRescueSave")?.addEventListener("click", saveSettings);
  $("#streakRescueRefresh")?.addEventListener("click", refreshStatus);
  $("#streakRescueTick")?.addEventListener("click", async () => {
    note($("#streakRescueSaveStatus"), "Running rescue check...");
    const resp = await rpc("ttm/streak_tick");
    if (resp?.ok) ok($("#streakRescueSaveStatus"), "Rescue check finished.");
    else err($("#streakRescueSaveStatus"), resp?.error || "Rescue check failed.");
    await refreshStatus();
  });

  refreshStatus().catch(() => {});
  setInterval(() => refreshStatus().catch(() => {}), 15000);
}
