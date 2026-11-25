import { expect, type Locator } from '@playwright/test';

export function codeFieldValue(field: Locator) {
  return field.evaluate((element) => {
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement)
      return element.value;
    return [...element.querySelectorAll(':scope > .cm-line')]
      .map((line) => {
        const copy = line.cloneNode(true) as HTMLElement;
        for (const extra of copy.querySelectorAll('.cm-placeholder, .cm-widgetBuffer'))
          extra.remove();
        return copy.textContent ?? '';
      })
      .join('\n');
  });
}

export async function expectCodeFieldValue(field: Locator, expected: string) {
  await expect.poll(() => codeFieldValue(field)).toBe(expected);
}
