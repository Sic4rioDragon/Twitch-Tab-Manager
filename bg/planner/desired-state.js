import { buildHierarchy, classify, compareRank, norm, rank } from "./hierarchy.js";

export function buildDesiredState(live = [], cfg = {}, { externalOpenChannels = [] } = {}) {
  const hierarchy = buildHierarchy(cfg);
  const seen = new Set();
  const orderedLive = [];

  for (const raw of Array.isArray(live) ? live : []) {
    const ch = norm(raw);
    if (!ch || seen.has(ch) || hierarchy.blacklist.has(ch)) continue;
    seen.add(ch);
    orderedLive.push(ch);
  }

  orderedLive.sort((a, b) => compareRank(a, b, hierarchy));

  const external = new Set(
    (Array.isArray(externalOpenChannels) ? externalOpenChannels : [])
      .map(norm)
      .filter((ch) => seen.has(ch))
  );

  const maxTabs = Math.max(1, Number(cfg.max_tabs || 4) || 4);
  const managedCandidates = orderedLive.filter((ch) => !external.has(ch));
  const desiredManaged = managedCandidates.slice(0, maxTabs);
  const waiting = managedCandidates.slice(maxTabs);

  return {
    maxTabs,
    hierarchy,
    liveConfigured: orderedLive,
    liveSet: seen,
    externalSatisfied: orderedLive.filter((ch) => external.has(ch)),
    desiredManaged,
    desiredManagedSet: new Set(desiredManaged),
    waiting,
    details: orderedLive.map((channel) => ({
      channel,
      class: classify(channel, hierarchy),
      rank: rank(channel, hierarchy),
      external: external.has(channel),
      desiredManaged: desiredManaged.includes(channel),
      waiting: waiting.includes(channel)
    }))
  };
}
