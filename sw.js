// Drink Water Bro — service worker
// Receives push messages from the server and shows them as notifications,
// even when the app is closed. Also handles notification clicks.

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(clients.claim());
});

self.addEventListener("push", (event) => {
  let data = { title: "💧 Time to drink water!", body: "Stay hydrated, bro!" };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch (e) { /* keep defaults */ }
  event.waitUntil(self.registration.showNotification(data.title, {
    body: data.body,
    icon: "./icon-192.png",
    badge: "./icon-192.png",
    tag: "drink-water-reminder",
    renotify: true,
    vibrate: [200, 100, 200]
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    for (const client of list) {
      if ("focus" in client) return client.focus();
    }
    return clients.openWindow("./index.html");
  }));
});
