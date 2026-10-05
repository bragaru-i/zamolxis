// Inline, dependency-free and ES5 so it runs even when the app bundle fails to load
// or crashes: after 12 s without the app marking itself started, explain what happened.
export const startupWatchdog = `(function () {
  var errors = [];
  window.addEventListener("error", function (event) {
    errors.push(String(event.message || (event.error && event.error.message) || "Script failed to load"));
  }, true);
  window.addEventListener("unhandledrejection", function (event) {
    var reason = event.reason;
    errors.push(String((reason && reason.message) || reason));
  });
  setTimeout(function () {
    if (window.__zamolxisStarted) return;
    var box = document.createElement("div");
    box.setAttribute("role", "alert");
    box.style.cssText = "position:fixed;inset:auto 12px 12px 12px;z-index:100;padding:16px;border-radius:12px;background:#fde7e4;color:#5a1410;font:15px/1.45 -apple-system,sans-serif;box-shadow:0 12px 32px rgba(0,0,0,.2)";
    var detail = errors.length ? errors[0] : "No script error was reported; the app may still be downloading or was blocked.";
    box.innerHTML = "<strong>Zamolxis didn't start.</strong><p style=\\"margin:8px 0\\"></p><p style=\\"margin:8px 0;font-size:12px;opacity:.8\\"></p><button type=\\"button\\" style=\\"font:inherit;font-weight:600;padding:10px 14px;border:0;border-radius:10px;background:#a8231a;color:#fff;margin-right:8px\\">Reload</button><button type=\\"button\\" style=\\"font:inherit;font-weight:600;padding:10px 14px;border:0;border-radius:10px;background:#fff;color:#a8231a\\">Reset sign-in</button>";
    box.getElementsByTagName("p")[0].textContent = detail;
    box.getElementsByTagName("p")[1].textContent = navigator.userAgent;
    var buttons = box.getElementsByTagName("button");
    buttons[0].onclick = function () { location.reload(); };
    buttons[1].onclick = function () {
      try {
        for (var i = localStorage.length - 1; i >= 0; i--) {
          var key = localStorage.key(i);
          if (key && key.indexOf("__convexAuth") === 0) localStorage.removeItem(key);
        }
      } catch (e) {}
      location.replace("/");
    };
    document.body.appendChild(box);
  }, 12000);
})();`;
