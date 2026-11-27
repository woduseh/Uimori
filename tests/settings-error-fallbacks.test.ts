// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, test, vi } from 'vitest';
import { PushSettings } from '../web/PushSettings.js';
import { formatUiMessage, uiMessage } from '../web/ui-message.js';

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

function mount(element: ReturnType<typeof createElement>) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.body.appendChild(document.createElement('div'));
  const root = createRoot(host);
  act(() => root.render(element));
  return { host, unmount: () => act(() => root.unmount()) };
}

test('a browser refusal while turning push on shows the push failure, not the raw browser text', async () => {
  const browserText = 'Registration failed - permission denied';
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal(
    'Notification',
    Object.assign(function Notification() {}, {
      permission: 'default',
      requestPermission: () => Promise.reject(new DOMException(browserText, 'NotAllowedError')),
    })
  );
  vi.stubGlobal('PushManager', function PushManager() {});
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: {} });
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ available: true, device: null }), {
          headers: { 'Content-Type': 'application/json' },
        })
    )
  );
  try {
    const { host, unmount } = mount(createElement(PushSettings));
    await act(async () => {});
    const toggle = host.querySelector<HTMLInputElement>('input[role="switch"]')!;
    await act(async () => toggle.click());

    expect(host.textContent).toContain(formatUiMessage(uiMessage('outside.pushFailure')));
    expect(host.textContent).not.toContain(browserText);
    unmount();
  } finally {
    Reflect.deleteProperty(navigator, 'serviceWorker');
  }
});
