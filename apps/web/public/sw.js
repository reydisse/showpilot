/// ShowPilot Service Worker — Push Notifications + Offline Shell

const CACHE_NAME = "showpilot-v1";

// Install — cache minimal shell
self.addEventListener("install", (event) => {
  self.skipWaiting();
});

// Activate — clean old caches
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// Push notification handler
self.addEventListener("push", (event) => {
  let data = { title: "ShowPilot", body: "New notification", type: "text" };

  if (event.data) {
    try {
      data = { ...data, ...event.data.json() };
    } catch {
      data.body = event.data.text();
    }
  }

  const options = {
    body: data.body,
    icon: "/logo192.png",
    badge: "/logo192.png",
    vibrate: [200, 100, 200],
    tag: data.type || "default",
    renotify: true,
    data: {
      url: data.url || "/",
      type: data.type,
    },
  };

  // Style based on message type
  if (data.type === "alert") {
    options.vibrate = [300, 100, 300, 100, 300];
    options.requireInteraction = true;
  } else if (data.type === "cue") {
    options.vibrate = [100, 50, 100];
  }

  event.waitUntil(self.registration.showNotification(data.title, options));
});

// Notification click — open or focus the app
self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const url = event.notification.data?.url || "/";

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      // If a window is already open, focus it
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && "focus" in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      // Otherwise open a new window
      return clients.openWindow(url);
    })
  );
});

// Fetch — network first, no aggressive caching (production tool needs fresh data)
self.addEventListener("fetch", (event) => {
  // Don't cache API calls or server functions
  if (
    event.request.url.includes("/api/") ||
    event.request.method !== "GET"
  ) {
    return;
  }

  // For navigation requests, always go to network
  if (event.request.mode === "navigate") {
    return;
  }

  // For static assets, use cache-first
  if (
    event.request.url.match(/\.(js|css|png|svg|ico|woff2?)$/)
  ) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request).then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        });
      })
    );
  }
});
