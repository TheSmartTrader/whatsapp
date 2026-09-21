// Minimal service worker — required for the browser/PWABuilder to treat
// this site as an installable app. It doesn't need to do offline caching
// for this app to work (it needs a live connection to Firebase anyway),
// so it just passes all requests straight through to the network.
self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  event.respondWith(fetch(event.request));
});
