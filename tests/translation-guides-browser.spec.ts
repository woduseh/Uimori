import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { Content } from '../core/product.js';
import { fixtureBotInput } from './fixtures/chat.js';
import { visualReview } from './fixtures/visual-review.js';
import { readTranslationGuide } from '../core/translation-guide.js';
import { navigationAction, selectEditorSection, discardEdits } from './ui-navigation.js';

async function createBot(request: APIRequestContext, title: string) {
  const response = await request.post('/api/content', {
    data: fixtureBotInput(title, 'Mira speaks calmly; Rose is a person.'),
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as Content;
}
async function open(page: Page, title: string) {
  await page.goto('/');
  await navigationAction(page, '서재');
  await page.getByRole('searchbox', { name: '서재 검색', exact: true }).fill(title);
  await page.getByRole('button', { name: `${title} 편집`, exact: true }).click();
  await selectEditorSection(page, '번역 지침');
}
async function save(page: Page) {
  const response = page.waitForResponse(
    (r) => r.url().endsWith('/api/resources/save') && r.request().method() === 'POST'
  );
  await page.getByRole('button', { name: '변경사항 저장', exact: true }).click();
  const result = await response;
  expect(result.ok(), await result.text()).toBe(true);
  return (await result.json()).saved as Content;
}
for (const width of [412]) {
  test(`TGUIDE ${width} save, raw JSON, recovery and explicit removal`, async ({
    page,
    request,
  }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const title = `Guide ${width} ${randomUUID().slice(0, 8)}`;
    const original = await createBot(request, title);
    const writes: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST') writes.push(new URL(r.url()).pathname);
    });
    await open(page, title);
    const instructions = page.getByLabel('봇 번역 지침', { exact: true });
    await instructions.fill(
      '미라는 담담하게 말한다. 원문에서 바뀌는 말투는 그대로 보존한다. {{char}}는 문자 그대로.'
    );
    await page.getByRole('button', { name: '표기 추가', exact: true }).click();
    await page.getByLabel('표기 1 원문', { exact: true }).fill('Rose');
    await page.getByLabel('표기 1 번역', { exact: true }).fill('로즈');
    await page
      .getByLabel('표기 1 조건과 설명', { exact: true })
      .fill('인물 이름일 때만. 꽃은 장미.');
    const saved = await save(page);
    expect(readTranslationGuide(saved.package.nativeRisu.card).terms[0]).toEqual({
      source: 'Rose',
      target: '로즈',
      note: '인물 이름일 때만. 꽃은 장미.',
    });
    expect(saved.text).toBe(original.text);
    await page.getByLabel('봇 번역 지침', { exact: true }).scrollIntoViewIfNeeded();
    if (visualReview)
      await page.screenshot({
        path: info.outputPath(`translation-guide-${width}.png`),
        fullPage: true,
      });
    const editor = page.getByRole('region', { name: '봇 번역 지침 편집기', exact: true });
    expect(await editor.evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
    await page.getByRole('button', { name: '표기 추가', exact: true }).click();
    await page.getByLabel('표기 2 원문', { exact: true }).fill('Mira');
    await expect
      .poll(() =>
        page.evaluate(async (text) => {
          const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open('uimori-editor-recovery', 1);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          try {
            return await new Promise<boolean>((resolve, reject) => {
              const request = db.transaction('buffers').objectStore('buffers').getAll();
              request.onsuccess = () => resolve(JSON.stringify(request.result).includes(text));
              request.onerror = () => reject(request.error);
            });
          } finally {
            db.close();
          }
        }, 'Mira')
      )
      .toBe(true);
    await open(page, title);
    await expect(page.getByLabel('표기 2 원문', { exact: true })).toHaveValue('Mira');
    await expect(page.getByLabel('표기 2 번역', { exact: true })).toHaveValue('');
    await discardEdits(page);
    await selectEditorSection(page, '번역 지침');
    await expect(page.getByLabel('표기 2 원문', { exact: true })).toHaveCount(0);
    await selectEditorSection(page, 'JSON 소스');
    await page.getByLabel('Risu 원문 편집 대상', { exact: true }).selectOption('card');
    const raw = page.getByLabel('Risu 원문 JSON', { exact: true });
    const card = JSON.parse(await raw.inputValue());
    card.extensions.uimori.translationGuide.instructions = '원문 JSON에서 수정한 번역 지침';
    await raw.fill(JSON.stringify(card));
    await save(page);
    await selectEditorSection(page, '번역 지침');
    await expect(instructions).toHaveValue('원문 JSON에서 수정한 번역 지침');
    await page.getByRole('button', { name: '표기 1 삭제', exact: true }).click();
    await instructions.fill('');
    const cleared = await save(page);
    expect(readTranslationGuide(cleared.package.nativeRisu.card)).toEqual({
      instructions: '',
      terms: [],
    });
    expect(writes.some((p) => /\/(runs|translation|retranslate)$/.test(p))).toBe(false);
    expect(errors).toEqual([]);
  });
}
