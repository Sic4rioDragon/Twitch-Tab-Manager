import { $, err, note, ok, rpc } from "./core.js";
import { clampConfig, getStoredConfig, readStorage, writeConfigEverywhere } from "./storage.js";

let refreshTimer = null;

function populate(cfg) {
  if ($("#streakRescueEnabled")) $("#streakRescueEnabled").checked = !!cfg.streak_rescue_enabled;
  if ($("#streakRescueMode")) $("#streakRescueMode").value = String(cfg.streak_rescue_mode || "auto");
  if ($("#streakRequiredMin")) $("#streakRequiredMin").value = String(cfg.streak_rescue_required_watch_min ?? 5);
  if ($("#streakGraceMin")) $("#streakGraceMin").value = String(cfg.streak_rescue_grace_min ?? 10);
  if ($("#streakConfirmSec")) $("#streakConfirmSec").value = String(cfg.streak_rescue_confirm_check_sec ?? 30);
  if ($("#streakRetryMin")) $("#streakRetryMin").value = String(cfg.streak_rescue_retry_min ?? 15);
  updateModeUI();
}

function formatMs(ms) {
  const total = Math.max(0, Math.round(Number(ms || 0) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

function formatAge(ts) {
  const n = Number(ts || 0);
  if (!n) return "never";
  const sec = Math.max(0, Math.round((Date.now() - n) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  return `${hr}h ago`;
}

function updateModeUI(status = null) {
  const enabled = !!$("#streakRescueEnabled")?.checked;
  const mode = $("#streakRescueMode")?.value || "auto";
  const badge = $("#streakModeBadge");
  const warning = $("#streakDetectWarning");

  if (badge) {
    badge.className = "status-pill";
    if (!enabled) {
      badge.textContent = "Disabled";
      badge.classList.add("off");
    } else if (mode === "detect") {
      badge.textContent = "Detect only";
      badge.classList.add("warn");
    } else if (status?.active) {
      badge.textContent = "Rescuing now";
      badge.classList.add("ok");
    } else {
      badge.textContent = "Automatic";
      badge.classList.add("ok");
    }
  }

  if (warning) warning.style.display = enabled && mode === "detect" ? "block" : "none";
}

function renderStatus(resp) {
  const out = $("#streakRescueStatus");
  if (!out) return;

  if (!resp?.ok) {
    out.textContent = `Status unavailable: ${resp?.error || "unknown error"}`;
    $("#streakLastScan") && ($("#streakLastScan").textContent = "error");
    return;
  }

  const s = resp.status || {};
  updateModeUI(s);

  if ($("#streakLastScan")) $("#streakLastScan").textContent = formatAge(s.last_scan_at);
  if ($("#streakDetected")) $("#streakDetected").textContent = String(s.last_scan_count ?? 0);
  if ($("#streakQueue")) $("#streakQueue").textContent = String(s.queue_count ?? 0);
  if ($("#streakActive")) $("#streakActive").textContent = s.active ? s.active.channel : "No";

  const scan = s.last_scan || {};
  const lines = [
    `Enabled: ${s.enabled ? "yes" : "no"}`,
    `Mode: ${s.mode || "auto"}`,
    `Last scan: ${formatAge(s.last_scan_at)}`,
    `Scanner ready: ${scan.ready ? "yes" : "no"}`,
    `Sidebar present: ${scan.sidebar_present ? "yes" : "no"}`,
    `At-risk group present: ${scan.group_present ? "yes" : "no"}`,
    `Candidate links inspected: ${scan.candidate_count ?? 0}`,
    `At risk detected: ${s.last_scan_count ?? 0}`,
    `Queued: ${s.queue_count ?? 0}`
  ];

  if (scan.helper_version) lines.push(`Scanner helper: v${scan.helper_version}`);

  if (s.enabled && s.mode === "detect") {
    lines.push("", "NOTE: Detect-only mode does not open a rescue VOD.");
  }

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
    for (const item of s.queue.slice(0, 8)) lines.push(`- ${item.channel} (streak ${item.streak || 0})`);
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
    const mode = $("#streakRescueMode")?.value || "auto";
    const next = clampConfig({
      ...cfg,
      streak_rescue_enabled: !!$("#streakRescueEnabled")?.checked,
      streak_rescue_mode: mode,
      streak_rescue_detect_only_explicit: mode === "detect",
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

    ok($("#streakRescueSaveStatus"), `Streak Rescue saved in ${next.streak_rescue_mode === "auto" ? "Automatic" : "Detect-only"} mode.`);
    updateModeUI();
    await refreshStatus();
    globalThis.TTMOptions?.refreshDashboard?.();
  } catch (e) {
    err($("#streakRescueSaveStatus"), `Streak Rescue save failed: ${e?.message || e}`);
  }
}

export function setupStreakRescuePanel() {
  readStorage().then((bag) => populate(getStoredConfig(bag))).catch(() => {});

  $("#streakRescueEnabled")?.addEventListener("change", () => {
    // New behavior: when the user turns rescue on, default to Automatic.
    // Detect-only is still available as an explicit choice.
    if ($("#streakRescueEnabled")?.checked && $("#streakRescueMode")?.value === "detect") {
      $("#streakRescueMode").value = "auto";
    }
    updateModeUI();
  });
  $("#streakRescueMode")?.addEventListener("change", () => updateModeUI());
  $("#streakRescueSave")?.addEventListener("click", saveSettings);
  $("#streakRescueRefresh")?.addEventListener("click", refreshStatus);
  $("#streakRescueTick")?.addEventListener("click", async () => {
    note($("#streakRescueSaveStatus"), "Running rescue check and reinjecting the scanner…");
    const resp = await rpc("ttm/streak_tick");
    if (resp?.ok) ok($("#streakRescueSaveStatus"), "Rescue check finished.");
    else err($("#streakRescueSaveStatus"), resp?.error || "Rescue check failed.");
    await refreshStatus();
  });

  refreshStatus().catch(() => {});
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    if (!document.hidden && $("#panel-streaks")?.classList.contains("active")) refreshStatus().catch(() => {});
  }, 10000);
}
