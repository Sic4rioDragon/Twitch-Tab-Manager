import { showManifestVersion } from "./core.js";
import { loadUI } from "./storage.js";
import { setupTabs } from "./tabs.js";
import { setupQuickSettings } from "./quick-settings.js";
import { setupConfigEditor } from "./config-editor.js";
import { setupFollowsPanel, setupPriorityEditor } from "./follows.js";
import { setupTokenTools } from "./tokens.js";
import { setupDebugPanel } from "./debug.js";
import { setupFeaturesPanel } from "./features.js";
import { setupStreakRescuePanel } from "./streaks.js";
import { setupRotationStatusPanel } from "./rotation-status.js";
import { setupDashboard } from "./dashboard.js";

async function init() {
  setupTabs();
  setupQuickSettings();
  setupConfigEditor();
  setupFollowsPanel();
  setupPriorityEditor();
  setupTokenTools();
  setupDebugPanel();
  setupFeaturesPanel();
  setupStreakRescuePanel();
  setupRotationStatusPanel();
  setupDashboard();

  await showManifestVersion();
  await loadUI();
}

document.addEventListener("DOMContentLoaded", () => {
  init().catch((e) => {
    console.error("Options init failed:", e);
  });
});
