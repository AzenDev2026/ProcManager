(function () {
  "use strict";
  try {
    var raw = localStorage.getItem("procmanager.settings.v1");
    var settings = raw ? JSON.parse(raw) : {};
    if (settings && settings.theme === "light") {
      document.documentElement.dataset.theme = "light";
    }
    if (settings && settings.sidebarCollapsed) {
      document.documentElement.dataset.sidebar = "collapsed";
    }
  } catch (error) {
    /* localStorage may be unavailable; defaults are fine */
  }
})();
