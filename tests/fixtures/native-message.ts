import { expect, type Locator } from '@playwright/test';

export function nativeProse(container: Locator) {
  return container.frameLocator('iframe[title="봇 메시지"]').locator('.risu-chat-text');
}

/** The card's async resize must settle before clicking controls below its frame. */
export async function waitForNativeLayout(container: Locator) {
  const iframe = container.locator('iframe[title="봇 메시지"]');
  const body = iframe.contentFrame().locator('body');
  await expect(nativeProse(container)).not.toBeEmpty();
  const expectedFontSize = await container.evaluate((node) =>
    Number.parseFloat(
      getComputedStyle(node.ownerDocument.documentElement).getPropertyValue('--reading')
    )
  );
  await expect
    .poll(async () => {
      const content = await body.evaluate(async (node) => {
        await document.fonts.ready;
        const bounds = node.getBoundingClientRect();
        return {
          height: Math.ceil(Math.max(bounds.height, bounds.bottom)),
          fontSize: Number.parseFloat(getComputedStyle(node).fontSize),
        };
      });
      const frame = await iframe.boundingBox();
      return {
        fontSize: content.fontSize,
        heightDifference: Math.max(0, Math.abs((frame?.height ?? 0) - content.height) - 2),
      };
    })
    .toEqual({ fontSize: expectedFontSize, heightDifference: 0 });
}
