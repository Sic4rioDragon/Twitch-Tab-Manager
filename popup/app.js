import {
  $,
  getStoredConfig,
  readStorageFallback,
  send,
  formatPollTime,
  getActiveTabChannel
} from "./core.js";
import { addCurrentChannelToConfig, tempAllowCurrentChannel } from "./actions.js";

document.addEventListener("DOMContentLoaded", () => {
  const ui = {
    toggle: $("toggleManager"),
    status: $("statusText"),
    stateTitle: $("stateText"),
    version: $("popupVersion"),
    updatedVersion: $("updatedVersion"),
    lastPoll: $("lastPoll"),
    health: $("healthText"),
    managerWindow: $("managerWindowText"),
    rotationCard: $("rotationCard"),
    rotationBadge: $("rotationBadge"),
    rotationSlots: $("rotationSlots"),
    rotationNext: $("rotationNext"),
    statOpen: $("statOpen"),
    statLive: $("statLive"),
    statMax: $("statMax"),
    flash: $("popupFlash"),
    btnPoll: $("btnPoll"),
    btnReload: $("btnReload"),
    btnOptions: $("btnOptions"),
    btnDiag: $("btnDiag"),
    actionWrap: $("twitchTabActions"),
    channelLabel: $("currentTwitchChannel"),
    btnAddFollow: $("btnAddFollow"),
    btnAddPriority: $("btnAddPriority"),
    btnAddBlacklist: $("btnAddBlacklist"),
    btnTempAllow: $("btnTempAllow")
  };

  let busy = false;

  function setBusy(nextBusy) {
    busy = !!nextBusy;

    ui.toggle.disabled = busy;
    ui.btnPoll.disabled = busy;
    ui.btnReload.disabled = busy;
    ui.btnOptions.disabled = busy;
    ui.btnDiag.disabled = busy;

    document.body.classList.toggle("is-busy", busy);
  }

  function flash(message, kind = "info") {
    if (!ui.flash) return;
    ui.flash.textContent = message || "";
    ui.flash.className = `flash ${kind}`;
  }

  function setVersionText() {
    try {
      const version = chrome.runtime.getManifest()?.version || "unknown";
      ui.version.textContent = `v${version}`;
    } catch {
      ui.version.textContent = "v?";
    }
  }

  function setStatusText(enabled) {
    const on = enabled !== false;

    ui.stateTitle.textContent = on ? "Enabled" : "Disabled";
    ui.stateTitle.className = on ? "state-title is-on" : "state-title is-off";

    ui.status.textContent = on
      ? "Watching your configured follows and priority channels."
      : "Manager is currently disabled.";
  }

  function setStats({ openCount, liveCount, maxTabs, loading = false }) {
    if (loading) {
      ui.statOpen.textContent = "Loading…";
      ui.statLive.textContent = "Loading…";
      ui.statMax.textContent = Number.isFinite(maxTabs) ? String(maxTabs) : "—";
      return;
    }

    ui.statOpen.textContent = Number.isFinite(openCount) ? String(openCount) : "—";
    ui.statLive.textContent = Number.isFinite(liveCount) ? String(liveCount) : "—";
    ui.statMax.textContent = Number.isFinite(maxTabs) ? String(maxTabs) : "—";
  }

  function getOpenCountFromDiag(diag) {
    const candidates = [];

    if (Number.isFinite(diag?.open_count)) candidates.push(diag.open_count);
    if (Array.isArray(diag?.tracked_open_channels)) candidates.push(diag.tracked_open_channels.length);
    if (Array.isArray(diag?.open_channels)) candidates.push(diag.open_channels.length);
    if (Number.isFinite(diag?.managed_count)) candidates.push(diag.managed_count);

    const valid = candidates.filter(Number.isFinite);
    if (!valid.length) return null;

    return Math.max(...valid);
  }

  function getLiveCountFromDiag(diag) {
    const candidates = [];

    if (Number.isFinite(diag?.live_count)) candidates.push(diag.live_count);
    if (Array.isArray(diag?.live_channels)) candidates.push(diag.live_channels.length);

    const valid = candidates.filter(Number.isFinite);
    if (!valid.length) return null;

    return Math.max(...valid);
  }

  function getMaxTabs(diag, stored) {
    if (Number.isFinite(diag?.owned_tab_cap)) return diag.owned_tab_cap;
    if (Number.isFinite(diag?.rotation?.ownedCap)) return diag.rotation.ownedCap;
    if (Number.isFinite(diag?.max_tabs)) return diag.max_tabs;
    if (Number.isFinite(diag?.settings?.max_tabs)) return diag.settings.max_tabs;
    const base = Number(stored?.max_tabs || 0);
    const rot = stored?.rotation_enabled ? Number(stored?.rotation_slot_count || 0) : 0;
    return base ? base + rot : stored?.max_tabs;
  }

  function setHealth(diag) {
    if (!ui.health) return;
    const h = diag?.health;
    if (!h) {
      ui.health.textContent = "—";
      return;
    }

    const trouble = Number(h.orphan_raid_tabs || 0) + Number(h.failed_tabs || 0);
    if (trouble > 0) {
      const parts = [];
      if (h.orphan_raid_tabs) parts.push(`${h.orphan_raid_tabs} orphan raid`);
      if (h.failed_tabs) parts.push(`${h.failed_tabs} failed`);
      if (h.recovering_tabs) parts.push(`${h.recovering_tabs} recovering`);
      ui.health.textContent = parts.join(" • ");
      return;
    }

    const parts = [`${Number(h.playing_tabs || 0)} playing`];
    if (h.recovering_tabs) parts.push(`${h.recovering_tabs} recovering`);
    if (h.owned_raid_tabs) parts.push(`${h.owned_raid_tabs} raid cleanup`);
    ui.health.textContent = parts.join(" • ");
  }


  function setManagerWindowStatus(diag) {
    if (!ui.managerWindow) return;
    const m = diag?.manager_window;
    if (!m || !m.exists) {
      ui.managerWindow.textContent = "not created";
      return;
    }

    const count = Number(m.managed_tab_count || 0);
    if (m.focused) {
      ui.managerWindow.textContent = `FOCUSED • ${count} managed`;
      return;
    }
    const primeBackoffMs = Number(m.primingBlockedMsRemaining || 0);
    if (primeBackoffMs > 0) {
      ui.managerWindow.textContent = `background • prime backoff ${formatDuration(primeBackoffMs)} • ${count} managed`;
      return;
    }
    if (m.primingDisabledForSession) {
      // Backward compatibility with older diagnostics. v1.0.14.3 uses a
      // temporary focus backoff instead of a permanent session-wide pause.
      ui.managerWindow.textContent = `background • prime paused • ${count} managed`;
      return;
    }
    ui.managerWindow.textContent = `background • ${count} managed`;
  }


  function formatDuration(ms) {
    const total = Math.max(0, Math.ceil(Number(ms || 0) / 1000));
    if (total < 60) return `${total}s`;
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    if (minutes < 60) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const rem = minutes % 60;
    return rem ? `${hours}h ${rem}m` : `${hours}h`;
  }

  function setRotationStatus(diag) {
    const card = ui.rotationCard;
    if (!card) return;
    const r = diag?.rotation;
    if (!r?.enabled) {
      card.style.display = "none";
      return;
    }

    card.style.display = "";
    const slots = Array.isArray(r.slots) ? r.slots : [];
    const requested = Number(r.requestedSlots || 0);
    const active = Number(r.effectiveSlots || 0);
    if (ui.rotationBadge) ui.rotationBadge.textContent = `${active}/${requested} slots`;

    if (ui.rotationSlots) {
      ui.rotationSlots.textContent = "";
      if (!slots.length) {
        const empty = document.createElement("div");
        empty.className = "subtle";
        empty.textContent = "No rotation slot is currently assigned.";
        ui.rotationSlots.appendChild(empty);
      } else {
        for (const slot of slots) {
          const row = document.createElement("div");
          row.className = "rotation-slot";

          const label = document.createElement("span");
          label.className = "subtle";
          label.textContent = `Slot ${Number(slot.slotIndex || 0) + 1}`;

          const channel = document.createElement("strong");
          channel.textContent = slot.channel || "waiting";

          const time = document.createElement("span");
          time.className = "rotation-time";
          if (slot.streakProtected) time.textContent = "streak pinned";
          else if (!slot.channel) time.textContent = "waiting";
          else if (slot.due) time.textContent = "due";
          else time.textContent = formatDuration(slot.remainingMs);

          row.append(label, channel, time);
          ui.rotationSlots.appendChild(row);
        }
      }
    }

    if (ui.rotationNext) {
      const next = Array.isArray(r.nextEligible) ? r.nextEligible : [];
      const cooling = Array.isArray(r.cooling) ? r.cooling : [];
      const parts = [];
      parts.push(next.length ? `Next eligible: ${next.slice(0, 4).join(", ")}` : "No alternate live channel eligible yet");
      if (cooling.length) parts.push(`${cooling.length} cooling down`);
      ui.rotationNext.textContent = parts.join(" • ");
    }
  }

  async function refreshMeta() {
    const bag = await readStorageFallback();

    const updatedVersion =
      bag.ttm_last_update_notified_version ||
      chrome.runtime.getManifest()?.version ||
      "unknown";

    ui.updatedVersion.textContent = updatedVersion;
    ui.lastPoll.textContent = formatPollTime(bag.ttm_last_poll_at);
  }

  async function refreshUI() {
    setBusy(true);
    flash("");

    const active = await getActiveTabChannel();
    if (active.channel) {
      if (ui.actionWrap) ui.actionWrap.style.display = "";
      if (ui.channelLabel) ui.channelLabel.textContent = active.channel;
    } else {
      if (ui.actionWrap) ui.actionWrap.style.display = "none";
    }

    const ping =
      (await send("ttm/ping")) ||
      (await send("PING")) ||
      (await send("TTM_STATUS"));

    const bag = await readStorageFallback();
    const stored = getStoredConfig(bag);

    const enabled =
      ping && typeof ping.enabled === "boolean"
        ? ping.enabled
        : stored.enabled;

    ui.toggle.checked = enabled !== false;
    setStatusText(enabled);

    let diag = null;
    try {
      diag =
        (await send("ttm/diagnose")) ||
        (await send("DIAGNOSE")) ||
        (await send("TTM_DIAG"));
    } catch {}

    const openCount = getOpenCountFromDiag(diag);
    const liveCount = getLiveCountFromDiag(diag);
    const maxTabs = getMaxTabs(diag, stored);
    const isLoading = !!(ping?.loading || diag?.loading);
    setHealth(diag);
    setManagerWindowStatus(diag);
    setRotationStatus(diag);

    setStats({
      openCount,
      liveCount,
      maxTabs,
      loading: isLoading
    });

    await refreshMeta();

    setBusy(false);
  }

  async function onToggleChanged() {
    if (busy) return;

    setBusy(true);
    flash("");

    const enabled = !!ui.toggle.checked;
    const resp = await send("ttm/enable", { enabled });

    if (!resp?.ok) {
      ui.toggle.checked = !enabled;
      flash(resp?.error || "Could not change manager state.", "error");
    } else {
      flash(enabled ? "Manager enabled." : "Manager disabled.", "ok");
    }

    await refreshUI();
    setBusy(false);
  }

  async function onForcePoll() {
    if (busy) return;
    setBusy(true);
    flash("");

    setStats({
      openCount: null,
      liveCount: null,
      maxTabs: Number(ui.statMax?.textContent) || null,
      loading: true
    });

    const resp = await send("ttm/force_poll");

    if (resp?.ok) {
      const liveText = Array.isArray(resp.live_channels)
        ? (resp.live_channels.join(", ") || "none")
        : (Number.isFinite(resp.live_count) ? String(resp.live_count) : "unknown");

      const openText = Array.isArray(resp.open_channels)
        ? (resp.open_channels.join(", ") || "none")
        : (Number.isFinite(resp.open_count) ? String(resp.open_count) : "unknown");

      flash(`Force poll done. Live: ${liveText}. Open: ${openText}.`, "ok");
    } else {
      flash(resp?.error || "Force poll failed.", "error");
    }

    await new Promise((r) => setTimeout(r, 350));
    await refreshUI();
    setBusy(false);
  }

  async function onReload() {
    if (busy) return;
    setBusy(true);
    flash("");

    const resp = await send("ttm/reload_config");
    if (resp?.ok) {
      flash("Config reloaded.", "ok");
    } else {
      flash(resp?.error || "Reload failed.", "error");
    }

    await refreshUI();
    setBusy(false);
  }

  async function onCopyDiag() {
    if (busy) return;
    setBusy(true);
    flash("");

    const diag =
      (await send("ttm/diagnose")) ||
      (await send("DIAGNOSE")) ||
      (await send("TTM_DIAG"));

    setBusy(false);

    if (!diag) {
      flash("Diagnostics failed.", "error");
      return;
    }

    const text = JSON.stringify(diag, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      const liveText = Array.isArray(diag.live_channels)
        ? (diag.live_channels.join(", ") || "none")
        : "unknown";

      flash(`Diagnostics copied. Live: ${liveText}.`, "ok");
    } catch {
      alert(text);
    }
  }

  async function wireChannelAction(kind) {
    const result =
      kind === "temp_allow"
        ? await tempAllowCurrentChannel()
        : await addCurrentChannelToConfig(kind);

    if (!result?.ok) {
      flash(result?.error || "Action failed.", "error");
      return;
    }

    if (kind === "temp_allow") flash(`Temp allowed ${result.channel}.`, "ok");
    else flash(`Updated ${result.channel}.`, "ok");
  }

  ui.toggle?.addEventListener("change", onToggleChanged);
  ui.btnPoll?.addEventListener("click", onForcePoll);
  ui.btnReload?.addEventListener("click", onReload);
  ui.btnOptions?.addEventListener("click", () => {
    try {
      chrome.runtime.openOptionsPage();
    } catch {}
  });
  ui.btnDiag?.addEventListener("click", onCopyDiag);

  ui.btnAddFollow?.addEventListener("click", () => wireChannelAction("follow"));
  ui.btnAddPriority?.addEventListener("click", () => wireChannelAction("priority"));
  ui.btnAddBlacklist?.addEventListener("click", () => wireChannelAction("blacklist"));
  ui.btnTempAllow?.addEventListener("click", () => wireChannelAction("temp_allow"));

  setVersionText();
  refreshUI();
});