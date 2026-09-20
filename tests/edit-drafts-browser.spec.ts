import { DEFAULT_WIDTHS } from './fixtures/browser-viewports.js';
import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { Content } from '../core/product.js';
import type { EditDraft } from '../core/edit-drafts.js';
import { nativeDraftTitle } from './fixtures/native-content.js';
import { fixtureBotInput } from './fixtures/chat.js';
import { editLibraryContent } from './ui-navigation.js';
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function nativeJson(page: Page) {
  await page.getByRole('tab', { name: '고급 설정', exact: true }).click();
  await page
    .getByRole('group', { name: '고급 설정 영역', exact: true })
    .getByRole('button', { name: '원문', exact: true })
    .click();
  return page.getByLabel('Risu 원문 JSON', { exact: true });
}

for (const [index, width] of DEFAULT_WIDTHS.entries()) {
  test(`ED0${index + 1} shared editor preserves incomplete JSON, helper races and reviewed undo at ${width}px`, async ({
    page,
    browser,
    request,
    baseURL,
  }, info) => {
    const title = `ED0${index + 1} ${Date.now()}`;
    const response = await request.post('/api/content', {
      data: fixtureBotInput(title, 'Synthetic body'),
    });
    expect(response.ok()).toBe(true);
    const content = (await response.json()) as Content;
    await page.setViewportSize({ width, height: 950 });
    await page.goto('/');
    await editLibraryContent(page, title);
    await page.getByLabel('Risu 자료 이름', { exact: true }).fill(`${title} local`);
    const json = await nativeJson(page);
    await json.fill('[{"content":');
    const current = async () =>
      (
        (await (
          await request.get(`/api/edit-drafts?editorKey=content:${content.id}`)
        ).json()) as EditDraft[]
      )[0];
    await expect
      .poll(async () => (await current())?.rawFields['package.native.source'])
      .toBe(JSON.stringify({ part: 'lore', text: '[{"content":' }));
    await expect(page.getByRole('button', { name: '변경사항 저장', exact: true })).toBeDisabled();
    await expect(page.getByLabel('Risu 자료 이름', { exact: true })).toBeDisabled();

    const secondContext = await browser.newContext({ baseURL, viewport: { width, height: 950 } });
    try {
      const second = await secondContext.newPage();
      await second.goto('/');
      await editLibraryContent(second, title);
      await expect(second.getByLabel('Risu 자료 이름', { exact: true })).toHaveValue(
        `${title} local`
      );
      await expect(await nativeJson(second)).toHaveValue('[{"content":');
      await expect(
        second.getByRole('button', { name: '변경사항 저장', exact: true })
      ).toBeDisabled();
    } finally {
      await secondContext.close();
    }

    const before = await current();
    const arrived = latch(),
      release = latch();
    await page.route(`**/api/edit-drafts/${before.id}`, async (route) => {
      if (route.request().method() !== 'PATCH') {
        await route.continue();
        return;
      }
      arrived.resolve();
      await release.promise;
      await route.continue();
    });
    const localJson = '[{"content":"local';
    await json.fill(localJson);
    await arrived.promise;
    const helper = await request.patch(`/api/edit-drafts/${before.id}`, {
      data: {
        expectedRevision: before.revision,
        operationId: randomUUID(),
        model: nativeDraftTitle(before.model, `${title} helper`),
        rawFields: before.rawFields,
        unappliedFields: before.unappliedFields,
      },
    });
    expect(helper.ok()).toBe(true);
    release.resolve();
    const status = page.getByRole('button', { name: '초안 상태와 변경 검토', exact: true });
    await expect(status).toHaveAttribute('title', '초안 충돌 확인');
    await page.unroute(`**/api/edit-drafts/${before.id}`);
    await status.click();
    const draftDialog = page.getByRole('dialog', { name: '초안 상태와 변경 검토', exact: true });
    await draftDialog.getByRole('button', { name: '두 초안 비교', exact: true }).click();
    await expect(draftDialog).toContainText(`${title} helper`);
    await expect(draftDialog).toContainText(`${title} local`);
    await draftDialog
      .getByRole('button', { name: '확인한 서버 초안에 내 입력 적용', exact: true })
      .click();
    await expect(
      draftDialog.getByRole('button', { name: '두 초안 비교', exact: true })
    ).toBeHidden();
    await draftDialog
      .getByRole('button', { name: '초안 상태와 변경 검토 닫기', exact: true })
      .click();
    await expect(json).toHaveValue(localJson);
    await expect(page.getByLabel('Risu 자료 이름', { exact: true })).toHaveValue(`${title} local`);
    await expect(page.getByRole('button', { name: '변경사항 저장', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '입력 되돌리기', exact: true }).click();
    await expect(page.getByRole('button', { name: '변경사항 저장', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '변경사항 저장', exact: true }).click();
    await expect
      .poll(async () => (await (await request.get(`/api/content/${content.id}`)).json()).title)
      .toBe(`${title} local`);
    await status.click();
    await draftDialog.getByRole('button', { name: '변경 검토', exact: true }).click();
    const review = page.getByRole('region', { name: '편집 변경 검토', exact: true });
    await review.locator('summary').filter({ hasText: '최근 저장 이력' }).click();
    await review
      .getByRole('button', { name: '이 저장 되돌리기 검토', exact: true })
      .first()
      .click();
    await expect(review).toContainText(`${title} local`);
    expect((await (await request.get(`/api/content/${content.id}`)).json()).revision).toBe(
      content.revision + 1
    );
    await review.getByRole('button', { name: '확인한 저장 되돌리기', exact: true }).click();
    await expect
      .poll(async () => (await (await request.get(`/api/content/${content.id}`)).json()).revision)
      .toBe(content.revision + 2);
    await draftDialog
      .getByRole('button', { name: '초안 상태와 변경 검토 닫기', exact: true })
      .click();
    await page.getByRole('tab', { name: '기본 정보', exact: true }).click();
    await expect(page.getByLabel('Risu 자료 이름', { exact: true })).toHaveValue(title);
    await expect(
      page.getByText(`${title} local 저장됨 · 다음 실행부터 사용해요.`, { exact: true })
    ).toBeHidden();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
    ).toBe(true);
    await page.screenshot({ path: info.outputPath(`edit-drafts-${width}.png`), fullPage: true });
  });
}
