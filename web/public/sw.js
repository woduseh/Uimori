// No fetch handler, CacheStorage, background sync or deferred authoring. Worker updates
// follow the browser lifecycle and never force-refresh a page containing a user's draft.
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

const messages = {
  'main-completed': '본문 생성이 완료됐어요.',
  'translation-completed': '번역이 완료됐어요.',
  'illustration-completed': '삽화 생성이 완료됐어요.',
  'task-failed': '확인이 필요한 작업이 있어요. 앱에서 상태를 확인해 주세요.',
  test: '이 기기의 테스트 알림이에요.',
};
const identifier = (value) => typeof value === 'string' && value.length > 0 && value.length <= 120;
function targetOf(value) {
  if (!value || typeof value !== 'object' || !identifier(value.chatId)) return null;
  return {
    chatId: value.chatId,
    branchId: identifier(value.branchId) ? value.branchId : `main:${value.chatId}`,
    sourceId: identifier(value.sourceId) ? value.sourceId : null,
    representation: value.representation === 'translation' ? 'translation' : 'original',
  };
}
self.addEventListener('push', (event) => {
  let payload;
  try {
    payload = event.data?.json();
  } catch {
    /* Unsupported data never becomes executable markup or a URL. */
  }
  const valid = payload?.version === 1 && Object.hasOwn(messages, payload.kind);
  const body = valid ? messages[payload.kind] : '작업실에서 작업 상태를 확인해 주세요.';
  const label = valid && typeof payload.title === 'string' ? payload.title.slice(0, 120) : '';
  event.waitUntil(
    self.registration.showNotification('Uimori', {
      body: label ? `${label}\n${body}` : body,
      icon: '/icons/app-192.png',
      tag:
        valid && typeof payload.tag === 'string' && payload.tag.length <= 100
          ? payload.tag
          : 'uimori-status',
      data: valid ? targetOf(payload) : null,
    })
  );
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = targetOf(event.notification.data);
  const url = new URL('/', self.location.origin);
  if (target) {
    url.searchParams.set('chat', target.chatId);
    if (target.sourceId) {
      url.searchParams.set('branch', target.branchId);
      url.searchParams.set('source', target.sourceId);
      url.searchParams.set('mode', target.representation);
    }
  }
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const candidates = windows.filter(
        (client) => new URL(client.url).origin === self.location.origin
      );
      const existing = candidates.find((client) => client.focused) ?? candidates[0];
      if (existing) {
        // Let the existing application's unsaved-edit navigation guard decide. Never navigate()
        // or reload a client, and never take an arbitrary external URL from a push payload.
        if (target) existing.postMessage({ type: 'uimori:notification-open', payload: target });
        await existing.focus();
      } else await self.clients.openWindow(url.href);
    })()
  );
});
