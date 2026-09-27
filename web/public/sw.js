// Uimori keeps manuscripts and API responses on the server. Intentionally no fetch handler,
// CacheStorage, background sync, or deferred authoring requests. Updates never force a reload.
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});
