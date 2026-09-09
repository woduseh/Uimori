import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { Content } from '../core/product.js';
import type { EditDraft } from '../core/edit-drafts.js';
import { fixtureBotInput } from './fixtures/chat.js';
import { editLibraryContent, selectPackageSection } from './ui-navigation.js';
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function behavior(page: Page) {
  await selectPackageSection(page, '상태와 행동');
  const summary = page.getByText('제작자용 동작 JSON 편집', { exact: true });
  if (!(await summary.evaluate((node) => (node.parentElement as HTMLDetailsElement).open)))
    await summary.click();
  return page.getByLabel('동작 정의 JSON', { exact: true });
}

for (const [index, width] of [390, 1440].entries()) {
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
    const json = await behavior(page);
    await json.fill('{"actions":[');
    const current = async () =>
      (
        (await (
          await request.get(`/api/edit-drafts?editorKey=content:${content.id}`)
        ).json()) as EditDraft[]
      )[0];
    await expect
      .poll(async () => (await current())?.rawFields['package.behavior'])
      .toBe('{"actions":[');
    await expect(page.getByRole('button', { name: '변경사항 저장', exact: true })).toBeDisabled();

    const secondContext = await browser.newContext({ baseURL, viewport: { width, height: 950 } });
    try {
      const second = await secondContext.newPage();
      await second.goto('/');
      await editLibraryContent(second, title);
      await expect(await behavior(second)).toHaveValue('{"actions":[');
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
    await page.getByLabel('자료 이름', { exact: true }).fill(`${title} local`);
    await arrived.promise;
    const helper = await request.patch(`/api/edit-drafts/${before.id}`, {
      data: {
        expectedRevision: before.revision,
        operationId: randomUUID(),
        model: { ...before.model, title: `${title} helper` },
        rawFields: before.rawFields,
        unappliedFields: before.unappliedFields,
      },
    });
    expect(helper.ok()).toBe(true);
    release.resolve();
    await expect(page.getByRole('button', { name: '두 초안 비교', exact: true })).toBeVisible();
    await expect(page.getByLabel('자료 이름', { exact: true })).toHaveValue(`${title} local`);
    await page.unroute(`**/api/edit-drafts/${before.id}`);
    await page.getByRole('button', { name: '두 초안 비교', exact: true }).click();
    await page
      .getByRole('button', { name: '확인한 서버 초안에 내 입력 적용', exact: true })
      .click();
    await expect(page.getByRole('button', { name: '두 초안 비교', exact: true })).toBeHidden();
    await json.fill('');
    await expect(page.getByRole('button', { name: '변경사항 저장', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '변경사항 저장', exact: true }).click();
    await expect
      .poll(async () => (await (await request.get(`/api/content/${content.id}`)).json()).title)
      .toBe(`${title} local`);
    await page.getByLabel('편집 초안 메뉴', { exact: true }).click();
    await page.getByRole('button', { name: '변경 내용·공유 영향·저장 이력', exact: true }).click();
    const review = page.getByRole('region', { name: '편집 변경 검토', exact: true });
    await review.locator('summary').filter({ hasText: '최근 저장 이력' }).click();
    await review
      .getByRole('button', { name: '이 저장 되돌리기 검토', exact: true })
      .first()
      .click();
    await expect(review).toContainText(`${title} local`);
    await review.getByRole('button', { name: '확인한 저장 되돌리기', exact: true }).click();
    await expect(page.getByLabel('자료 이름', { exact: true })).toHaveValue(title);
    await expect
      .poll(async () => (await (await request.get(`/api/content/${content.id}`)).json()).revision)
      .toBe(content.revision + 2);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
    ).toBe(true);
    await page.screenshot({ path: info.outputPath(`edit-drafts-${width}.png`), fullPage: true });
  });
}
