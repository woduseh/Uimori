import { expect, type Locator } from '@playwright/test';

export function nativeProse(container: Locator) {
  return container.locator('.risu-message-surface .risu-chat-text');
}

/** Wait for the rendered message, not an iframe resize handshake. */
export async function waitForNativeLayout(container: Locator) {
  const surface = container.locator('.risu-message-surface');
  const content = surface.locator('.risu-message-content');
  await expect(nativeProse(container)).not.toBeEmpty();
  await expect(surface).toBeVisible();
  await content.evaluate(async () => {
    await document.fonts.ready;
  });
  const expectedFontSize = await container.evaluate((node) =>
    Number.parseFloat(
      getComputedStyle(node.ownerDocument.documentElement).getPropertyValue('--reading')
    )
  );
  await expect
    .poll(() => content.evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize)))
    .toBe(expectedFontSize);
  await expect
    .poll(() =>
      surface.evaluate((host) => {
        const bounds = host.getBoundingClientRect();
        const content = host
          .shadowRoot!.querySelector('.risu-message-content')!
          .getBoundingClientRect();
        return content.top >= bounds.top - 1 && content.bottom <= bounds.bottom + 1;
      })
    )
    .toBe(true);
}
