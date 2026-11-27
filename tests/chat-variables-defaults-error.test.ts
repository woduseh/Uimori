// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, test, vi } from 'vitest';
import { ChatVariables } from '../web/ChatVariables.js';

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

test('a resource default-variable overflow is explained, never shown as its contract code', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            revision: 1,
            values: {},
            defaults: {},
            resolved: {},
            sourceHash: null,
            pending: false,
            variableDefaultsError: 'TEMPLATE_VARIABLE_DEFAULTS_LIMIT',
          }),
          { headers: { 'Content-Type': 'application/json' } }
        )
    )
  );
  const host = document.body.appendChild(document.createElement('div'));
  const root = createRoot(host);
  await act(async () => root.render(createElement(ChatVariables, { chatId: 'chat' })));
  const alert = host.querySelector('p.error[role="alert"]');
  expect(alert).not.toBeNull();
  expect(alert!.textContent).not.toContain('TEMPLATE_VARIABLE_DEFAULTS_LIMIT');
  act(() => root.unmount());
});
