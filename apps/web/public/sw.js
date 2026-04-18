/// ShowPilot Service Worker — cleanup only

// Keep this worker as a safe migration path for old installs.
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
