/* Theme preference only. This controller never reads reconciliation files. */
(function () {
  "use strict";
  const key = "csv-reconciliation-demo.theme";
  const valid = new Set(["system", "light", "dark"]);
  const root = document.documentElement;
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  let preference = "system";
  try {const saved = window.localStorage.getItem(key); if (valid.has(saved)) preference = saved;} catch (_) {}
  function apply(announce) {
    const dark = preference === "dark" || (preference === "system" && media.matches);
    root.dataset.theme = dark ? "dark" : "light";
    root.classList.toggle("mdui-theme-dark", dark);
    root.classList.toggle("mdui-theme-light", !dark);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", dark ? "#1d1d1f" : "#f5f5f7");
    const choice = document.getElementById("theme-choice");
    if (choice) choice.value = preference;
    const status = document.getElementById("theme-status");
    if (announce && status) status.textContent = dark ? "Тёмная тема" : "Светлая тема";
  }
  apply(false);
  const systemChanged = () => {if (preference === "system") apply(true);};
  if (media.addEventListener) media.addEventListener("change", systemChanged);
  else media.addListener(systemChanged);
  function bind() {
    const choice = document.getElementById("theme-choice");
    if (!choice) return;
    choice.value = preference;
    choice.addEventListener("change", () => {
      if (!valid.has(choice.value)) return;
      preference = choice.value;
      try {window.localStorage.setItem(key, preference);} catch (_) {}
      apply(true);
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind, {once:true});
  else bind();
})();
