// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, test, vi } from 'vitest';
import { AutoTranslationDefaults } from '../web/AutoTranslationDefaults.js';
import { ChatGenerationDefaults } from '../web/ChatGenerationDefaults.js';

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

test.each([
  ['AutoTranslationDefaults', AutoTranslationDefaults],
  ['ChatGenerationDefaults', ChatGenerationDefaults],
])(
  '%s: a network failure on first load gives a title and a different reason',
  async (_name, Component) => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      })
    );
    const host = document.body.appendChild(document.createElement('div'));
    const root = createRoot(host);
    await act(async () => root.render(createElement(Component)));
    const lines = [...host.querySelectorAll('[role="alert"] p')].map((p) => p.textContent);
    expect(lines).toHaveLength(2);
    expect(lines[0]).not.toBe(lines[1]);
    act(() => root.unmount());
  }
);
