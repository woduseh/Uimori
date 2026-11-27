// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, test, vi } from 'vitest';
import { deletionEndpoints } from '#contracts';
import { DeleteButton } from '../web/DeleteButton.js';

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

test('confirming deletes the item the dialog was opened for, even after props move to another', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const requests: { url: string; method?: string; body?: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({
        url,
        method: init?.method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return new Response(JSON.stringify({ deleted: true, id: 'a' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    })
  );
  const cleaned: string[] = [];
  const host = document.body.appendChild(document.createElement('div'));
  const root = createRoot(host);
  const show = (id: string, revision: number) =>
    act(() =>
      root.render(
        createElement(DeleteButton, {
          endpoint: deletionEndpoints.deleteContent,
          params: { id },
          revision,
          title: `Item ${id}`,
          onDeleted: () => {
            cleaned.push(id);
          },
        })
      )
    );
  await show('a', 3);
  await act(async () => host.querySelector<HTMLButtonElement>('button.delete-button')!.click());
  await show('b', 7);
  const confirm = [...host.querySelectorAll<HTMLButtonElement>('dialog button.delete-button')];
  await act(async () => confirm.at(-1)!.click());

  expect(requests).toEqual([
    { url: '/api/content/a', method: 'DELETE', body: { expectedRevision: 3 } },
  ]);
  expect(cleaned).toEqual(['a']);
  act(() => root.unmount());
});
