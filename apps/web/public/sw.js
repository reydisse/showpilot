/// ShowPilot notification service worker.
// Intentionally does not intercept fetches or cache application assets.
// That preserves deploy safety while still enabling background Web Push.
self.addEventListener("install", (event) => {
  self.skipWaiting();
});

// Remove any cached assets from prior versions and release control.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.map((key) => caches.delete(key))))
  );
  self.clients.claim();
});

// No fetch interception. The app always uses the network.
self.addEventListener("push", (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch { payload = {}; }
  const title = payload.title || "ShowPilot";
  event.waitUntil(Promise.all([
    self.registration.showNotification(title, {
      body: payload.body || "You have a new production update.",
      icon: "/logo192.png",
      badge: "/logo192.png",
      tag: payload.tag || "showpilot-update",
      data: { url: payload.url || "/" },
    }),
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) client.postMessage({ type: "showpilot-notification" });
    }),
  ]));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (clients) => {
    const sameOrigin = clients.find((client) => new URL(client.url).origin === self.location.origin);
    if (sameOrigin) {
      await sameOrigin.focus();
      if ("navigate" in sameOrigin) await sameOrigin.navigate(target);
      return;
    }
    await self.clients.openWindow(target);
  }));
});
