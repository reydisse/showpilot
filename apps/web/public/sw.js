/// ShowPilot Service Worker — cleanup only
//
// An earlier service worker cached HTML responses for JS assets, breaking
// hydration after deploys. This worker is the migration path for installs
// that still have it registered: the browser's out-of-band SW update check
// fetches this file (served with max-age=0, see _headers), which then
// unregisters itself and wipes its caches. Keep it deployed until legacy
// installs have cycled out; the app itself no longer registers any SW.
self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(self.registration.unregister());
});

// Remove any cached assets from prior versions and release control.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.map((key) => caches.delete(key))))
  );
  self.clients.claim();
});

// No fetch interception. The app should always use the network.
