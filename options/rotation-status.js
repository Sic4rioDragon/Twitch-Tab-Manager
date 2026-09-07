import { $, rpc } from "./core.js";

let refreshTimer = null;

function fmtDuration(ms) {
  const total = Math.max(0, Math.ceil(Number(ms || 0) / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem ? `${hours}h ${rem}m` : `${hours}h`;
}

function fmtTime(ts) {
  const n = Number(ts || 0);
  if (!n) return "—";
  try {
    return new Date(n).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
  } catch {
    return "—";
  }
}

function make(tag, className = "", text = "") {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text) el.textContent = text;
  return el;
}

function ensureStyles() {
  if ($("#ttmRotationStatusStyles")) return;
  const style = document.createElement("style");
  style.id = "ttmRotationStatusStyles";
  style.textContent = `
    .rotation-status-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap}
    .rotation-status-badge{display:inline-flex;align-items:center;padding:4px 9px;border-radius:999px;font-size:12px;font-weight:700;border:1px solid rgba(145,70,255,.35);background:rgba(145,70,255,.14);color:#d8b4fe}
    .rotation-status-badge.off{border-color:#334155;background:#111827;color:#94a3b8}
    .rotation-status-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-top:14px}
    .rotation-status-stat{padding:10px;border-radius:12px;background:var(--panel-3);border:1px solid var(--border)}
    .rotation-status-stat span{display:block;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.04em}
    .rotation-status-stat strong{display:block;margin-top:3px;color:var(--text-strong);font-size:17px}
    .rotation-slot-list{display:grid;gap:8px;margin-top:12px}
    .rotation-slot-row{display:grid;grid-template-columns:70px minmax(130px,1fr) 130px 1.4fr;gap:10px;align-items:center;padding:10px 12px;border:1px solid var(--border);background:var(--panel-3);border-radius:12px;font-size:12px}
    .rotation-slot-row .channel{font-weight:800;color:var(--text-strong);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .rotation-slot-row .muted{color:var(--muted)}
    .rotation-status-columns{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px}
    .rotation-status-list{margin:8px 0 0;padding-left:18px;color:var(--text);font-size:12px;line-height:1.55}
    .rotation-status-list li::marker{color:var(--accent)}
    .rotation-empty{padding:11px;border:1px dashed var(--border-2);border-radius:10px;color:var(--muted);font-size:12px}
    @media(max-width:980px){.rotation-status-stats{grid-template-columns:1fr 1fr}.rotation-slot-row{grid-template-columns:1fr 1fr}.rotation-status-columns{grid-template-columns:1fr}}
  `;
  document.head.appendChild(style);
}

function ensureCard() {
  let card = $("#rotationStatusCard");
  if (card) return card;
  const stack = $("#panel-settings .stack");
  if (!stack) return null;

  card = make("section", "card");
  card.id = "rotationStatusCard";
  const streak = $("#streakRescueCard");
  if (streak?.parentElement === stack) streak.insertAdjacentElement("afterend", card);
  else stack.prepend(card);
  return card;
}

function render(diag) {
  const card = ensureCard();
  if (!card) return;
  const r = diag?.rotation || {};
  const enabled = !!r.enabled;
  const slots = Array.isArray(r.slots) ? r.slots : [];
  const cooling = Array.isArray(r.cooling) ? r.cooling : [];
  const next = Array.isArray(r.nextEligible) ? r.nextEligible : [];
  const history = Array.isArray(r.history) ? r.history : [];

  card.textContent = "";

  const head = make("div", "rotation-status-head");
  const titleWrap = make("div");
  titleWrap.append(make("h2", "", "Rotation Status"));
  titleWrap.append(make("p", "small", "Live view of reusable rotation slots, timers, cooldowns, candidates, and recent switches."));
  const badge = make("span", `rotation-status-badge${enabled ? "" : " off"}`, enabled ? "Enabled" : "Disabled");
  head.append(titleWrap, badge);
  card.appendChild(head);

  const stats = make("div", "rotation-status-stats");
  const values = [
    ["Slots", `${Number(r.effectiveSlots || 0)} / ${Number(r.requestedSlots || 0)}`],
    ["Interval", `${Number(r.intervalMin || 0)} min`],
    ["Live candidates", String(Array.isArray(r.liveCandidates) ? r.liveCandidates.length : 0)],
    ["Cooling", String(cooling.length)]
  ];
  for (const [label, value] of values) {
    const box = make("div", "rotation-status-stat");
    box.append(make("span", "", label), make("strong", "", value));
    stats.appendChild(box);
  }
  card.appendChild(stats);

  const slotList = make("div", "rotation-slot-list");
  if (!enabled) {
    slotList.appendChild(make("div", "rotation-empty", "Rotation is disabled. Enable it above to reserve reusable rotation slots."));
  } else if (!slots.length) {
    slotList.appendChild(make("div", "rotation-empty", "No rotation slot is assigned yet. A slot will bind when an eligible configured rotation channel is live."));
  } else {
    for (const slot of slots) {
      const row = make("div", "rotation-slot-row");
      row.appendChild(make("strong", "", `Slot ${Number(slot.slotIndex || 0) + 1}`));
      row.appendChild(make("div", "channel", slot.channel || "waiting"));
      const timer = slot.streakProtected
        ? "Watch Streak pinned"
        : !slot.channel
          ? "Waiting"
          : slot.due
            ? "Rotation due"
            : `${fmtDuration(slot.remainingMs)} remaining`;
      row.appendChild(make("div", "muted", timer));
      const candidates = Array.isArray(slot.nextEligible) ? slot.nextEligible : [];
      row.appendChild(make("div", "muted", candidates.length ? `Next: ${candidates.slice(0, 5).join(", ")}` : "No alternate eligible yet"));
      slotList.appendChild(row);
    }
  }
  card.appendChild(slotList);

  const cols = make("div", "rotation-status-columns");
  const nextBox = make("div", "subcard");
  nextBox.appendChild(make("h4", "", "Eligible / Cooldown"));
  const nextP = make("p", "small", next.length ? `Eligible now: ${next.join(", ")}` : "No alternate live rotation channel is eligible right now.");
  nextBox.appendChild(nextP);
  if (cooling.length) {
    const list = make("ul", "rotation-status-list");
    for (const item of cooling.slice(0, 12)) {
      list.appendChild(make("li", "", `${item.channel} — ${fmtDuration(item.remainingMs)} cooldown left`));
    }
    nextBox.appendChild(list);
  }

  const historyBox = make("div", "subcard");
  historyBox.appendChild(make("h4", "", "Recent Rotation History"));
  if (!history.length) {
    historyBox.appendChild(make("p", "small", "No completed rotation switches recorded in this browser session yet."));
  } else {
    const list = make("ul", "rotation-status-list");
    for (const item of history.slice(0, 10)) {
      const from = item.from || "empty";
      list.appendChild(make("li", "", `${fmtTime(item.at)} · Slot ${Number(item.slotIndex || 0) + 1}: ${from} → ${item.to}`));
    }
    historyBox.appendChild(list);
  }
  cols.append(nextBox, historyBox);
  card.appendChild(cols);

  const controls = make("div", "btns");
  const refresh = make("button", "", "Refresh Rotation Status");
  refresh.id = "rotationStatusRefresh";
  refresh.addEventListener("click", () => refreshRotationStatus());
  controls.appendChild(refresh);
  card.appendChild(controls);
}

export async function refreshRotationStatus() {
  const diag = await rpc("ttm/diagnose");
  if (!diag?.ok) {
    const card = ensureCard();
    if (card) {
      card.textContent = "";
      card.append(make("h2", "", "Rotation Status"), make("p", "err", diag?.error || "Could not read rotation status."));
    }
    return;
  }
  render(diag);
}

export function setupRotationStatusPanel() {
  ensureStyles();
  ensureCard();
  refreshRotationStatus().catch(() => {});

  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    if (!document.hidden && $("#panel-rotation")?.classList.contains("active")) {
      refreshRotationStatus().catch(() => {});
    }
  }, 15_000);

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshRotationStatus().catch(() => {});
  });
}
