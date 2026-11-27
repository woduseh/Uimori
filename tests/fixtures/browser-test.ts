import { test as base, type Page } from '@playwright/test';

export * from '@playwright/test';

async function shownDescriptors(page: Page) {
  return page.evaluate(() => {
    const mark = '\u001f';
    const found: string[] = [];
    const add = (where: string, value: string | null | undefined) => {
      if (value?.includes(mark))
        found.push(
          `${where}: ${JSON.stringify(value.slice(value.indexOf(mark), value.indexOf(mark) + 80))}`
        );
    };
    add('text', document.body?.innerText);
    add('document title', document.title);
    for (const element of document.querySelectorAll('[title], [aria-label], [placeholder], [alt]'))
      for (const name of ['title', 'aria-label', 'placeholder', 'alt'])
        add(`${element.tagName.toLowerCase()}[${name}]`, element.getAttribute(name));
    for (const element of document.querySelectorAll<HTMLInputElement>(
      'input, textarea, select, button, fieldset, output, object'
    ))
      add(`${element.tagName.toLowerCase()} validationMessage`, element.validationMessage);
    return found;
  });
}

export const test = base.extend({
  page: async ({ page }, use, info) => {
    await use(page);
    if (info.status !== info.expectedStatus) return;
    const found: string[] = [];
    for (const shown of page.context().pages()) {
      if (shown.isClosed()) continue;
      found.push(...(await shownDescriptors(shown)));
    }
    if (found.length)
      throw new Error(
        `The page shows a raw message descriptor. Pass the value through translateMessage() or t() before rendering it.\n${found.join('\n')}`
      );
  },
});
