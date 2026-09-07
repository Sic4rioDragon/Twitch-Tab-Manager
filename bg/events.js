const EVENT_KEY = "ttm_events_v3";
const MAX_EVENTS = 220;

let cache = [];
let loaded = false;

function cleanDetail(detail) {
  if (detail == null) return null;
  if (typeof detail === "string") return detail.slice(0, 300);
  try {
    const json = JSON.stringify(detail);
    if (json.length <= 1200) return JSON.parse(json);
    return { truncated: json.slice(0, 1150) + "…" };
  } catch {
    return String(detail).slice(0, 300);
  }
}

async function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  try {
    const got = await chrome.storage.local.get(EVENT_KEY);
    cache = Array.isArray(got[EVENT_KEY]) ? got[EVENT_KEY].slice(-MAX_EVENTS) : [];
  } catch {
    cache = [];
  }
}

export async function event(kind, detail = null) {
  await ensureLoaded();
  const row = {
    at: Date.now(),
    iso: new Date().toISOString(),
    kind: String(kind || "event"),
    detail: cleanDetail(detail)
  };
  cache.push(row);
  if (cache.length > MAX_EVENTS) cache.splice(0, cache.length - MAX_EVENTS);
  try {
    await chrome.storage.local.set({ [EVENT_KEY]: cache });
  } catch {}
  return row;
}

export async function getEvents(limit = 120) {
  await ensureLoaded();
  return cache.slice(-Math.max(1, Math.min(MAX_EVENTS, Number(limit || 120))));
}

export async function clearEvents() {
  cache = [];
  loaded = true;
  try { await chrome.storage.local.remove(EVENT_KEY); } catch {}
}

export { EVENT_KEY, MAX_EVENTS };
