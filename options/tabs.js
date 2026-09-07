import { $, $$ } from "./core.js";

const TAB_KEY = "ttm.options.active_tab.v1";

function activate(tab, { persist = true } = {}) {
  if (!tab) return;
  $$(".tab").forEach((x) => x.classList.remove("active"));
  $$(".panel").forEach((x) => x.classList.remove("active"));

  tab.classList.add("active");
  document.getElementById("panel-" + tab.dataset.tab)?.classList.add("active");

  const title = $("#pageTitle");
  const subtitle = $("#pageSubtitle");
  if (title) title.textContent = tab.dataset.title || tab.textContent?.trim() || "Settings";
  if (subtitle) subtitle.textContent = tab.dataset.description || "";

  if (persist) {
    try { sessionStorage.setItem(TAB_KEY, tab.dataset.tab || "settings"); } catch {}
  }
}

export function setupTabs() {
  $$(".tab").forEach((tab) => tab.addEventListener("click", () => activate(tab)));

  let wanted = "settings";
  try { wanted = sessionStorage.getItem(TAB_KEY) || wanted; } catch {}
  const initial = document.querySelector(`.tab[data-tab="${wanted}"]`) || $(".tab.active") || $(".tab");
  activate(initial, { persist: false });
}
