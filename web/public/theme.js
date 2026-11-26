// Light is the default. If this device chose dark before, apply it now,
// before anything is drawn, so the page never flashes the wrong theme.
(function () {
  try {
    if (localStorage.getItem("theme") === "dark") {
      document.documentElement.classList.add("dark");
      var meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.content = "#0e1118";
    }
  } catch (e) {
    /* private mode: use the default */
  }
})();
