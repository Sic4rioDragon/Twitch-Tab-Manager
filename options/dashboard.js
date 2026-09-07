import { $, rpc } from "./core.js";
import { getStoredConfig, readStorage } from "./storage.js";

let timer = null;

function text(id, value) {
  const el = $(id);
  if (el) el.textContent = String(value ?? "—");
}

function setHealth(label, type = "") {
  const el = $("#dashHealthPill");
  if (!el) return;
  el.textContent = label;
  el.className = `status-pill${type ? ` ${type}` : ""}`;
}

export async function refreshDashboard() {
  const [bag, diag] = await Promise.all([
    readStorage().catch(() => ({})),
    rpc("ttm/diagnose").catch(() => ({ ok: false }))
  ]);

  const cfg = getStoredConfig(bag || {});
  text("#dashEnabled", cfg.enabled !== false ? "Enabled" : "Disabled");

  if (!diag?.ok) {
    text("#dashLive", "?");
    text("#dashManaged", "?");
    text("#dashRotation", "?");
    text("#dashRescue", "?");
    setHealth("Background unavailable", "warn");
    return;
  }

  text("#dashLive", Number(diag.live_count || 0));
  text("#dashManaged", Number(diag.open_count || 0));

  const rotation = diag.rotation || {};
  const activeSlots = Array.isArray(rotation.slots)
    ? rotation.slots.filter((x) => x?.channel).length
    : 0;
  text("#dashRotation", rotation.enabled ? `${activeSlots}/${Number(rotation.requestedSlots || 0)}` : "Off");

  const rescue = diag.streak_rescue || {};
  const rescueActive = rescue.active ? 1 : 0;
  const rescueQueued = Number(rescue.queue_count || 0);
  text("#dashRescue", rescue.enabled ? `${rescueActive} active · ${rescueQueued} queued` : "Off");

  const attention = Array.isArray(diag.attention) ? diag.attention.length : 0;
  const failed = Number(diag.health?.failed_tabs || 0);
  if (attention || failed) setHealth(`${attention + failed} item${attention + failed === 1 ? "" : "s"} need attention`, "warn");
  else setHealth("Healthy", "ok");
}

function activateTab(name) {
  document.querySelector(`.tab[data-tab="${name}"]`)?.click();
}

export function setupDashboard() {
  $("#dashboardRefresh")?.addEventListener("click", () => refreshDashboard().catch(() => {}));
  $("#dashboardForcePoll")?.addEventListener("click", async () => {
    setHealth("Polling…");
    await rpc("ttm/force_poll");
    setTimeout(() => refreshDashboard().catch(() => {}), 500);
  });

  refreshDashboard().catch(() => {});
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    if (!document.hidden) refreshDashboard().catch(() => {});
  }, 15000);

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshDashboard().catch(() => {});
  });

  // Handy for other options modules without adding another import dependency.
  globalThis.TTMOptions = globalThis.TTMOptions || {};
  globalThis.TTMOptions.activateTab = activateTab;
  globalThis.TTMOptions.refreshDashboard = refreshDashboard;
}
