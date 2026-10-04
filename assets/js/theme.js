// Restore the visitor's choice before the stylesheet loads to avoid a light flash.
(() => {
  const root = document.documentElement;
  const storageKey = "wei-ye-theme";
  let theme = "light";

  try {
    if (localStorage.getItem(storageKey) === "dark") theme = "dark";
  } catch {
    // The toggle still works when browser storage is unavailable.
  }

  function applyTheme(value) {
    theme = value === "dark" ? "dark" : "light";
    root.setAttribute("data-theme", theme);

    const button = document.querySelector(".theme-toggle");
    if (!button) return;

    const dark = theme === "dark";
    button.setAttribute("aria-pressed", String(dark));
    button.title = dark ? "Switch to light mode" : "Switch to dark mode";
    button.querySelector(".theme-label").textContent = dark ? "Light" : "Dark";
    button.hidden = false;
  }

  applyTheme(theme);
  document.addEventListener("DOMContentLoaded", () => applyTheme(theme));

  document.addEventListener("click", (event) => {
    if (!event.target.closest(".theme-toggle")) return;
    applyTheme(theme === "dark" ? "light" : "dark");
    try {
      localStorage.setItem(storageKey, theme);
    } catch {
      // Keep the chosen appearance for this page even without storage access.
    }
  });

  window.addEventListener("storage", (event) => {
    if (event.key === storageKey || event.key === null) applyTheme(event.newValue);
  });
})();
