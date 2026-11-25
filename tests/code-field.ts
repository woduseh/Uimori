import { expect, type Locator } from '@playwright/test';

type CodeMirrorContent = { cmTile?: { root?: { view?: { state: { sliceDoc(): string } } } } };

export function readCodeFieldValue(element: Element) {
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement)
    return element.value;
  const state = (element as CodeMirrorContent).cmTile?.root?.view?.state;
  if (!state) throw new Error('Not a textarea or a CodeMirror content element');
  return state.sliceDoc();
}

export function codeFieldValue(field: Locator) {
  return field.evaluate(readCodeFieldValue);
}

export async function expectCodeFieldValue(field: Locator, expected: string) {
  await expect.poll(() => codeFieldValue(field)).toBe(expected);
}
