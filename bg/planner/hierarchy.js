export function norm(value) {
  return String(value || "").trim().toLowerCase();
}

function makeIndex(list = []) {
  const map = new Map();
  (Array.isArray(list) ? list : [])
    .map(norm)
    .filter(Boolean)
    .forEach((channel, index) => {
      if (!map.has(channel)) map.set(channel, index);
    });
  return map;
}

export function buildHierarchy(cfg = {}) {
  return {
    favorites: makeIndex(cfg.favorites),
    priority: makeIndex(cfg.priority),
    follows: makeIndex(cfg.follows),
    rotation: makeIndex(cfg.rotation),
    lowPriority: makeIndex(cfg.low_priority),
    blacklist: new Set((Array.isArray(cfg.blacklist) ? cfg.blacklist : []).map(norm).filter(Boolean))
  };
}

export function classify(channel, hierarchy) {
  const ch = norm(channel);
  if (!ch) return "unknown";
  if (hierarchy.blacklist.has(ch)) return "blacklist";
  if (hierarchy.favorites.has(ch)) return "favorite";
  if (hierarchy.priority.has(ch)) return "priority";
  if (hierarchy.rotation.has(ch)) return "rotation";
  if (hierarchy.lowPriority.has(ch)) return "low_priority";
  return "follow";
}

function streakProtected(channel) {
  try { return !!globalThis.TTM?.isWatchStreakProtected?.(channel); }
  catch { return false; }
}

export function rank(channel, hierarchy) {
  const ch = norm(channel);
  let value;

  if (hierarchy.favorites.has(ch)) value = hierarchy.favorites.get(ch);
  else if (hierarchy.priority.has(ch)) value = 10_000 + hierarchy.priority.get(ch);
  else if (hierarchy.rotation.has(ch)) value = 300_000 + hierarchy.rotation.get(ch);
  else if (hierarchy.lowPriority.has(ch)) value = 400_000 + hierarchy.lowPriority.get(ch);
  else value = 200_000 + (hierarchy.follows.get(ch) ?? 99_999);

  // A live Watch Streak marker is a temporary maintenance boost for ordinary
  // tiers. It never jumps ahead of an explicit Favorite or Priority channel.
  if (streakProtected(ch) && value >= 200_000) value -= 50_000;
  return value;
}

export function compareRank(a, b, hierarchy) {
  const byRank = rank(a, hierarchy) - rank(b, hierarchy);
  if (byRank !== 0) return byRank;

  // Stable tie-breaker: prefer the stream most recently observed live, then
  // the channel name. This avoids unnecessary churn between equal-tier tabs.
  const aLive = globalThis.TTM_STAB?._get?.(norm(a))?.lastLiveTs || 0;
  const bLive = globalThis.TTM_STAB?._get?.(norm(b))?.lastLiveTs || 0;
  if (aLive !== bLive) return bLive - aLive;
  return norm(a).localeCompare(norm(b));
}
