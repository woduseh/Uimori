// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeAll, expect, test } from 'vitest';
import { DraftDiscardActions } from '../web/DraftDiscardActions.js';
import { loadLocale, setLocale, UI_LOCALES } from '../web/i18n.js';
import { SaveConflictDialog } from '../web/SaveConflictDialog.js';
import { UiError, uiMessage } from '../web/ui-message.js';

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  return Promise.all(UI_LOCALES.map(loadLocale));
});

afterEach(() => {
  setLocale('ko');
  document.body.replaceChildren();
});

function mount(element: ReturnType<typeof createElement>) {
  const host = document.body.appendChild(document.createElement('div'));
  const root = createRoot(host);
  act(() => root.render(element));
  return { host, root };
}

const alert = (host: HTMLElement) => host.querySelector('[role="alert"]')?.textContent ?? null;

test("a failed save-and-leave shows the save failure, never the thrown error's own text", async () => {
  const { host, root } = mount(
    createElement(DraftDiscardActions, {
      onContinue: () => {},
      onDiscard: () => {},
      onSave: async () => {
        throw new TypeError('Failed to fetch');
      },
    })
  );
  await act(async () => host.querySelector<HTMLButtonElement>('.draft-save-leave')!.click());
  expect(alert(host)).toBe('저장하지 못했어요. 오류나 미적용 입력을 확인해 주세요.');
  act(() => setLocale('en'));
  expect(alert(host)).toBe('Could not save. Check for errors or unapplied input.');
  act(() => root.unmount());
});

test('a saved-version review that fails shows its catalog message in the language shown', async () => {
  const review = async (cause: unknown) => {
    const { host, root } = mount(
      createElement(SaveConflictDialog, {
        open: true,
        title: 'Conflict',
        onClose: () => {},
        readSaved: () => Promise.reject(cause),
      })
    );
    await act(async () => {});
    const shown = alert(host);
    act(() => root.unmount());
    return shown;
  };
  expect(await review(new TypeError('Failed to fetch'))).toBe('저장본을 확인하지 못했어요.');
  setLocale('en');
  expect(await review(new UiError(uiMessage('shared.loadFailed')))).toBe('Could not load.');
});
