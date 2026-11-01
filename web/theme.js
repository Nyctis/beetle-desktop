"use strict";

// Runs before the first paint, so a light Mac never flashes dark. "auto" follows the system.
(() => {
  const KEY = "beetle.theme", system = matchMedia("(prefers-color-scheme: light)");
  const read = () => { try { return localStorage.getItem(KEY) || "auto"; } catch { return "auto"; } };
  const apply = () => {
    const pick = read();
    document.documentElement.dataset.theme = pick === "auto" ? (system.matches ? "light" : "dark") : pick;
  };
  system.addEventListener("change", apply);
  window.beetleTheme = {
    get: read,
    set(pick) { try { localStorage.setItem(KEY, pick); } catch { /* the choice lasts this session */ } apply(); },
  };
  apply();
})();
