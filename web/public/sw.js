// No fetch handler, CacheStorage, background sync or deferred authoring. Worker updates
// follow the browser lifecycle and never force-refresh a page containing a user's draft.
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

const notificationCatalogs = {
  ko: {
    messages: {
      'main-completed': '본문 생성이 완료됐어요.',
      'translation-completed': '번역이 완료됐어요.',
      'request-translated': '새로운 장면을 한국어로 읽을 준비가 됐어요.',
      'auto-translation-failed':
        '원문은 저장됐지만 번역에 실패했어요. 앱에서 다시 시도할 수 있어요.',
      'auto-translation-interrupted':
        '원문은 저장됐지만 번역이 중단됐어요. 앱에서 상태를 확인하고 다시 시도해 주세요.',
      'illustration-completed': '삽화 생성이 완료됐어요.',
      'task-failed': '확인이 필요한 작업이 있어요. 앱에서 상태를 확인해 주세요.',
      test: '이 기기의 테스트 알림이에요.',
    },
    headings: {
      'main-completed': '본문 완성',
      'request-translated': '번역까지 완성',
      'translation-completed': '번역 완성',
      'auto-translation-failed': '번역 확인 필요',
      'auto-translation-interrupted': '번역 확인 필요',
      'illustration-completed': '삽화 완성',
      'task-failed': '작업 확인 필요',
      test: '테스트 알림',
    },
    fallbackBody: '작업실에서 작업 상태를 확인해 주세요.',
    fallbackHeading: '작업 알림',
  },
  ...{
    en: {
      messages: {
        'main-completed': 'Manuscript generation is complete.',
        'translation-completed': 'Translation is complete.',
        'request-translated': 'Your new scene is ready to read in Korean.',
        'auto-translation-failed':
          'The original was saved, but translation failed. You can try again in the app.',
        'auto-translation-interrupted':
          'The original was saved, but translation was interrupted. Check its status in the app and try again.',
        'illustration-completed': 'Illustration generation is complete.',
        'task-failed': 'A task needs your attention. Check its status in the app.',
        test: 'This is a test notification for this device.',
      },
      headings: {
        'main-completed': 'Manuscript complete',
        'translation-completed': 'Translation complete',
        'request-translated': 'Translation also complete',
        'auto-translation-failed': 'Check translation',
        'auto-translation-interrupted': 'Check translation',
        'illustration-completed': 'Illustration complete',
        'task-failed': 'Check task',
        test: 'Test notification',
      },
      fallbackBody: 'Check your task status in the workspace.',
      fallbackHeading: 'Task notification',
    },
    ja: {
      messages: {
        'main-completed': '本文の生成が完了しました。',
        'translation-completed': '翻訳が完了しました。',
        'request-translated': '新しいシーンを韓国語で読む準備ができました。',
        'auto-translation-failed':
          '原文は保存されましたが、翻訳に失敗しました。アプリで再試行できます。',
        'auto-translation-interrupted':
          '原文は保存されましたが、翻訳が中断されました。アプリで状態を確認して再試行してください。',
        'illustration-completed': '挿絵の生成が完了しました。',
        'task-failed': '確認が必要な作業があります。アプリで状態を確認してください。',
        test: 'この端末のテスト通知です。',
      },
      headings: {
        'main-completed': '本文完了',
        'translation-completed': '翻訳完了',
        'request-translated': '翻訳まで完了',
        'auto-translation-failed': '翻訳の確認が必要',
        'auto-translation-interrupted': '翻訳の確認が必要',
        'illustration-completed': '挿絵完了',
        'task-failed': '作業の確認が必要',
        test: 'テスト通知',
      },
      fallbackBody: 'ワークスペースで作業の状態を確認してください。',
      fallbackHeading: '作業通知',
    },
    zh: {
      messages: {
        'main-completed': '正文生成已完成。',
        'translation-completed': '翻译已完成。',
        'request-translated': '新场景已可使用韩语阅读。',
        'auto-translation-failed': '原文已保存，但翻译失败。可在应用中重试。',
        'auto-translation-interrupted': '原文已保存，但翻译已中断。请在应用中检查状态后重试。',
        'illustration-completed': '插图生成已完成。',
        'task-failed': '有任务需要关注。请在应用中检查状态。',
        test: '这是此设备的测试通知。',
      },
      headings: {
        'main-completed': '正文完成',
        'translation-completed': '翻译完成',
        'request-translated': '翻译也已完成',
        'auto-translation-failed': '需要检查翻译',
        'auto-translation-interrupted': '需要检查翻译',
        'illustration-completed': '插图完成',
        'task-failed': '需要检查任务',
        test: '测试通知',
      },
      fallbackBody: '请在工作室中检查任务状态。',
      fallbackHeading: '任务通知',
    },
  },
};
const validLocale = (value) => ['ko', 'en', 'ja', 'zh'].includes(value);
let localeWrites = Promise.resolve();
function localeStore(action, locale) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('uimori-presentation', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('settings');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const transaction = db.transaction('settings', action === 'write' ? 'readwrite' : 'readonly');
      const store = transaction.objectStore('settings');
      const request =
        action === 'write' ? store.put(locale, 'ui-language') : store.get('ui-language');
      transaction.oncomplete = () => {
        db.close();
        resolve(request.result);
      };
      transaction.onerror = () => {
        db.close();
        reject(transaction.error);
      };
      transaction.onabort = () => {
        db.close();
        reject(transaction.error);
      };
    };
  });
}
self.addEventListener('message', (event) => {
  if (event.data?.type !== 'uimori:ui-language' || !validLocale(event.data.locale)) return;
  // Only same-origin app clients may change presentation; no task state is written.
  if (!event.source?.url || new URL(event.source.url).origin !== self.location.origin) return;
  localeWrites = localeWrites.then(() => localeStore('write', event.data.locale)).catch(() => {});
  event.waitUntil(localeWrites);
});
async function notificationLocale() {
  await localeWrites;
  const locale = await localeStore('read').catch(() => 'ko');
  return validLocale(locale) ? locale : 'ko';
}
const identifier = (value) => typeof value === 'string' && value.length > 0 && value.length <= 120;
function targetOf(value) {
  if (!value || typeof value !== 'object' || !identifier(value.chatId)) return null;
  return {
    chatId: value.chatId,
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
  event.waitUntil(
    (async () => {
      const catalog = notificationCatalogs[await notificationLocale()];
      const messages = catalog.messages;
      const valid = payload?.version === 1 && Object.hasOwn(messages, payload.kind);
      const body = valid ? messages[payload.kind] : catalog.fallbackBody;
      const label = valid && typeof payload.title === 'string' ? payload.title.slice(0, 64) : '';
      const heading = catalog.headings;
      const caption = valid ? heading[payload.kind] : catalog.fallbackHeading;
      await self.registration.showNotification(
        label ? `${label} · ${caption}` : `Uimori · ${caption}`,
        {
          body,
          icon: '/icons/app-192.png',
          tag:
            valid && typeof payload.tag === 'string' && payload.tag.length <= 100
              ? payload.tag
              : 'uimori-status',
          data: valid ? targetOf(payload) : null,
        }
      );
    })()
  );
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = targetOf(event.notification.data);
  const url = new URL('/', self.location.origin);
  if (target) {
    url.searchParams.set('chat', target.chatId);
    if (target.sourceId) {
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
