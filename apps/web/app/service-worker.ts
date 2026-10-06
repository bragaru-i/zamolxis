// Inline, ES5 registration of /sw.js (installability and an offline page only; see
// public/sw.js). Service workers need a secure context, so it is skipped elsewhere.
export const registerServiceWorker = `(function () {
  if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
  window.addEventListener("load", function () {
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(function () {});
  });
})();`;
