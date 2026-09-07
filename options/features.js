import { $ } from "./core.js";

const RECENT_REVISION_WINDOW = 4;

const FEATURES = [
  {
    title: "Automatic live tab management",
    category: "Tab Management",
    description: "Detects configured Twitch channels going live, opens TTM-owned stream tabs, avoids duplicates, and removes managed tabs after streams end.",
    introduced: "1.0.0",
  },
  {
    title: "Priority hierarchy",
    category: "Tab Management",
    description: "Favorites, Priority, normal follows, rotation candidates, and Low Priority channels are ranked so limited capacity goes to the channels you care about most.",
    introduced: "1.0.12",
  },
  {
    title: "Dedicated playback window",
    category: "Playback & Stability",
    description: "Automatic TTM streams stay together in their own playback window instead of mixing with your normal browsing tabs.",
    introduced: "1.0.13.3",
    updated: "1.0.14.9",
  },
  {
    title: "Focus-safe background management",
    category: "Playback & Stability",
    description: "TTM never focuses or defocuses browser windows. If Twitch fails to initialize in the background, it can use one short internal tab-activation cycle inside the already-unfocused playback window, with automatic backoff if Brave surfaces it.",
    introduced: "1.0.13.3",
    updated: "1.0.14.12",
  },
  {
    title: "Browser mute state preservation",
    category: "Playback & Stability",
    description: "Opening, restoring, rotating, recovering, or managing a Twitch tab does not change that browser tab's existing muted/unmuted state.",
    introduced: "1.0.14.6",
  },
  {
    title: "Non-destructive playback recovery",
    category: "Playback & Stability",
    description: "Background watchdog recovery prefers reinjection, visibility pulses, and a conditional internal prime instead of repeatedly reloading streams or focusing browser windows.",
    introduced: "1.0.11",
    updated: "1.0.14.12",
  },
  {
    title: "Brave/Chromium tab-lock retry",
    category: "Playback & Stability",
    description: "Short-lived 'Tabs cannot be edited right now' locks are retried quietly across automatic opens and other background tab operations.",
    introduced: "1.0.14.7",
    updated: "1.0.14.8",
  },
  {
    title: "Offline and orphan cleanup",
    category: "Tab Management",
    description: "Confirmed-offline managed tabs and stranded Twitch tabs inside the TTM playback window are cleaned up instead of surviving for hours.",
    introduced: "1.0.13.1",
    updated: "1.0.14.6",
  },
  {
    title: "User-open Twitch tab protection",
    category: "Tab Management",
    description: "TTM keeps ownership separate from normal Twitch tabs you opened yourself so automatic cleanup does not casually remove your browsing tabs.",
    introduced: "1.0.12",
  },
  {
    title: "Reusable rotation slots",
    category: "Rotation",
    description: "Dedicated rotation slots switch among eligible live channels on an interval and reuse the same TTM-owned tab instead of constantly opening new tabs.",
    introduced: "1.0.14.0",
  },
  {
    title: "Extra and borrowable rotation capacity",
    category: "Rotation",
    description: "Rotation slots sit above Normal Max Tabs. Unused rotation capacity can temporarily be filled by another normal live stream and yields back when rotation needs it.",
    introduced: "1.0.14.9",
  },
  {
    title: "Rotation status and history",
    category: "Rotation",
    description: "Popup, Options, and Diagnose can show active slots, countdowns, cooldowns, candidates, and recent rotation switches.",
    introduced: "1.0.14.1",
  },
  {
    title: "Watch Streak Rescue",
    category: "Watch Streaks",
    description: "Detects at-risk Twitch watch streaks, queues rescue VODs, verifies real playback progress, and uses a short internal activation fallback when Twitch refuses to start a never-visible rescue tab.",
    introduced: "1.0.10",
    updated: "1.0.14.12",
  },
  {
    title: "Raid redirect cleanup",
    category: "Tab Management",
    description: "TTM detects owned raid redirects and cleans up orphan raid tabs in its playback window while leaving unrelated user tabs alone.",
    introduced: "1.0.13.1",
    updated: "1.0.14.2",
  },
  {
    title: "Fetch My Follows",
    category: "Setup & Tools",
    description: "Pulls Twitch follows into TTM from an active/current Twitch page so large follow lists do not need to be entered manually.",
    introduced: "1.0.8",
  },
  {
    title: "Config and follow backups",
    category: "Setup & Tools",
    description: "Import and export stored configuration and follow lists for backup, migration, and testing.",
    introduced: "1.0.8",
  },
  {
    title: "Health and Diagnose tools",
    category: "Setup & Tools",
    description: "Detailed detector, lifecycle, playback-window, rotation, recovery, and tab-registry diagnostics make regressions easier to trace.",
    introduced: "1.0.11",
    updated: "1.0.14.8",
  },
  {
    title: "Feature list with recent-change badges",
    category: "Interface",
    description: "Replaces the in-extension changelog with a searchable feature overview. NEW and UPDATED badges automatically age out as newer builds arrive.",
    introduced: "1.0.14.10",
  },
  {
    title: "Redesigned Options dashboard",
    category: "Interface",
    description: "Reorganizes settings into Overview, Channels, Rotation, Streak Rescue, Features, Advanced, Debug, and Help with a live status dashboard and cleaner navigation.",
    introduced: "1.0.14.11",
  },
];

function parseVersion(value) {
  const parts = String(value || "")
    .split(".")
    .map((x) => Number.parseInt(x, 10));
  if (!parts.length || parts.some((x) => !Number.isFinite(x))) return null;
  while (parts.length < 4) parts.push(0);
  return parts.slice(0, 4);
}

function recentRevisionDistance(current, target) {
  const c = parseVersion(current);
  const t = parseVersion(target);
  if (!c || !t) return Number.POSITIVE_INFINITY;
  if (c[0] !== t[0] || c[1] !== t[1] || c[2] !== t[2]) {
    return Number.POSITIVE_INFINITY;
  }
  const distance = c[3] - t[3];
  return distance >= 0 ? distance : Number.POSITIVE_INFINITY;
}

function badgeFor(feature, currentVersion) {
  if (feature.updated && recentRevisionDistance(currentVersion, feature.updated) <= RECENT_REVISION_WINDOW) {
    return { type: "updated", label: `UPDATED · v${feature.updated}` };
  }
  if (recentRevisionDistance(currentVersion, feature.introduced) <= RECENT_REVISION_WINDOW) {
    return { type: "new", label: `NEW · v${feature.introduced}` };
  }
  return null;
}

function renderFeatureCard(feature, currentVersion) {
  const card = document.createElement("article");
  card.className = "feature-card";

  const top = document.createElement("div");
  top.className = "feature-card-top";

  const titleWrap = document.createElement("div");
  const title = document.createElement("h3");
  title.className = "feature-title";
  title.textContent = feature.title;
  const category = document.createElement("div");
  category.className = "feature-category";
  category.textContent = feature.category;
  titleWrap.append(title, category);

  const badges = document.createElement("div");
  badges.className = "feature-badges";
  const badge = badgeFor(feature, currentVersion);
  if (badge) {
    const el = document.createElement("span");
    el.className = `feature-badge ${badge.type}`;
    el.textContent = badge.label;
    badges.appendChild(el);
  }

  const description = document.createElement("p");
  description.className = "feature-description";
  description.textContent = feature.description;

  top.append(titleWrap, badges);
  card.append(top, description);
  return card;
}

function renderFeatures() {
  const list = $("#featureList");
  const summary = $("#featureSummary");
  if (!list) return;

  const currentVersion = chrome.runtime.getManifest()?.version || "0.0.0.0";
  const search = String($("#featureSearch")?.value || "").trim().toLowerCase();
  const selectedCategory = $("#featureCategory")?.value || "all";

  const visible = FEATURES.filter((feature) => {
    if (selectedCategory !== "all" && feature.category !== selectedCategory) return false;
    if (!search) return true;
    const haystack = `${feature.title} ${feature.category} ${feature.description}`.toLowerCase();
    return haystack.includes(search);
  });

  list.replaceChildren();
  if (!visible.length) {
    const empty = document.createElement("div");
    empty.className = "feature-empty";
    empty.textContent = "No features match this filter.";
    list.appendChild(empty);
  } else {
    visible.forEach((feature) => list.appendChild(renderFeatureCard(feature, currentVersion)));
  }

  const recentCount = FEATURES.filter((feature) => badgeFor(feature, currentVersion)).length;
  if (summary) {
    summary.textContent = `${visible.length} of ${FEATURES.length} features shown · ${recentCount} recently added or updated`;
  }
}

export function setupFeaturesPanel() {
  const categorySelect = $("#featureCategory");
  const categories = [...new Set(FEATURES.map((feature) => feature.category))].sort();
  for (const category of categories) {
    const option = document.createElement("option");
    option.value = category;
    option.textContent = category;
    categorySelect?.appendChild(option);
  }

  const currentVersion = chrome.runtime.getManifest()?.version || "unknown";
  const version = $("#featureVersion");
  if (version) version.textContent = `Current build: v${currentVersion}`;

  $("#featureSearch")?.addEventListener("input", renderFeatures);
  categorySelect?.addEventListener("change", renderFeatures);
  renderFeatures();
}
