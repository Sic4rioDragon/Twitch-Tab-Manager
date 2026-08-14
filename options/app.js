import { $, showManifestVersion } from "./core.js";
import { loadUI } from "./storage.js";
import { setupTabs } from "./tabs.js";
import { setupQuickSettings } from "./quick-settings.js";
import { setupConfigEditor } from "./config-editor.js";
import { setupFollowsPanel, setupPriorityEditor } from "./follows.js";
import { setupTokenTools } from "./tokens.js";
import { setupDebugPanel } from "./debug.js";
import { setupChangelogTab } from "./changelog.js";
import { setupStreakRescuePanel } from "./streaks.js";

async function init() {
  setupTabs();
  setupQuickSettings();
  setupConfigEditor();
  setupFollowsPanel();
  setupPriorityEditor();
  setupTokenTools();
  setupDebugPanel();
  setupChangelogTab();
  setupStreakRescuePanel();

  await showManifestVersion();
  await loadUI();

  // Auto-load changelog if its panel is already active
  if ($("#panel-changelog")?.classList.contains("active")) {
    const { loadChangelogTab } = await import("./changelog.js");
    await loadChangelogTab();
  }
}

document.addEventListener("DOMContentLoaded", () => {
  init().catch((e) => {
    console.error("Options init failed:", e);
  });
});