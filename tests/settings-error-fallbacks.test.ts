// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, test, vi } from 'vitest';
import { formatUiMessage, uiMessage } from '../web/ui-message.js';

const fonts = vi.hoisted(() => ({
  catalog: { fonts: [], preferences: { appFontId: null, readerFontId: null, revision: 1 } },
  loading: false,
  error: null,
  runtimeError: false,
  appFamily: null,
  readerFamily: null,
  refresh: async () => {},
  accept: () => {},
}));
vi.mock('../web/FontContext.js', () => ({ useFonts: () => fonts }));
vi.mock('../web/ThemeContext.js', () => ({ useThemes: () => ({ disabled: false }) }));

const { FontSettings } = await import('../web/FontSettings.js');
const { PushSettings } = await import('../web/PushSettings.js');

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

test('a font file the browser cannot read reports the read failure, not a generic one', async () => {
  vi.stubGlobal(
    'FileReader',
    class {
      error = new DOMException('NotReadableError');
      onerror: (() => void) | null = null;
      readAsDataURL() {
        queueMicrotask(() => this.onerror?.());
      }
    }
  );
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const { host, unmount } = mount(createElement(FontSettings));
  const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
  input.required = false;
  Object.defineProperty(input, 'files', {
    configurable: true,
    value: [new File(['x'], 'Serif.woff2', { type: 'font/woff2' })],
  });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await act(async () => {
    host
      .querySelector('form.font-upload')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });

  expect(fetch).not.toHaveBeenCalled();
  expect(host.textContent).toContain(formatUiMessage(uiMessage('transfer.m190')));
  expect(host.textContent).not.toContain(formatUiMessage(uiMessage('fonts.failed')));
  unmount();
});

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
