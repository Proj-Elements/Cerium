// Runs before styles and React; version the filename when changing this immutable asset.
(() => {
  let theme = "system";
  try {
    const stored = localStorage.getItem("cerium-theme");
    if (["system", "light", "dark"].includes(stored)) theme = stored;
  } catch {}
  document.documentElement.dataset.theme = theme;
  document.documentElement.classList.toggle(
    "dark",
    theme === "dark" ||
      (theme === "system" &&
        matchMedia("(prefers-color-scheme: dark)").matches),
  );
})();
