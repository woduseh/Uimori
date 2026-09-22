import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { Content } from '../core/product.js';
import { fixtureBotInput } from './fixtures/chat.js';
import { readTranslationGuide } from '../core/translation-guide.js';
import { navigationAction, selectPackageSection } from './ui-navigation.js';

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
  await page.getByRole('button', { name: `${title} 상세 보기`, exact: true }).click();
  await page.getByRole('button', { name: '편집', exact: true }).click();
  await selectPackageSection(page, '번역 지침');
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
for (const width of [1440, 412]) {
  test(`TGUIDE ${width} save, literal preview, raw JSON, recovery and explicit removal`, async ({
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
    await page.getByLabel('표기 1 조건·설명', { exact: true }).fill('인물 이름일 때만. 꽃은 장미.');
    await page.getByText('번역에 전달할 지침 미리보기', { exact: true }).click();
    const preview = page.locator('.translation-guide-preview pre');
    await expect(preview).toContainText('{{char}}');
    await expect(preview).toContainText('로즈');
    const saved = await save(page);
    expect(readTranslationGuide(saved.package.nativeRisu.card).terms[0]).toEqual({
      source: 'Rose',
      target: '로즈',
      note: '인물 이름일 때만. 꽃은 장미.',
    });
    expect(saved.text).toBe(original.text);
    await page.getByLabel('봇 번역 지침', { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({
      path: info.outputPath(`translation-guide-${width}.png`),
      fullPage: true,
    });
    const editor = page.getByRole('region', { name: '봇 번역 지침 편집기', exact: true });
    expect(await editor.evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
    // The regular resource recovery buffer must preserve unfinished term rows, not discard them.
    await page.getByRole('button', { name: '표기 추가', exact: true }).click();
    await page.getByLabel('표기 2 원문', { exact: true }).fill('Mira');
    // The compact header hides this secondary hint; persistence is verified by reload below.
    await expect(page.getByText('이 기기에 복구용 입력 보관됨', { exact: true })).toBeAttached();
    await open(page, title);
    await expect(page.getByLabel('표기 2 원문', { exact: true })).toHaveValue('Mira');
    await expect(page.getByLabel('표기 2 번역', { exact: true })).toHaveValue('');
    await page.getByRole('button', { name: '편집 취소', exact: true }).click();
    await selectPackageSection(page, '번역 지침');
    await expect(page.getByLabel('표기 2 원문', { exact: true })).toHaveCount(0);
    // Raw source edits and GUI edits use exactly the same canonical field.
    await selectPackageSection(page, '고급 설정');
    await page.getByRole('button', { name: '원문', exact: true }).click();
    await page.getByLabel('Risu 원문 편집 대상', { exact: true }).selectOption('card');
    const raw = page.getByLabel('Risu 원문 JSON', { exact: true });
    const card = JSON.parse(await raw.inputValue());
    card.extensions.uimori.translationGuide.instructions = '원문 JSON에서 수정한 번역 지침';
    await raw.fill(JSON.stringify(card));
    await save(page);
    await selectPackageSection(page, '번역 지침');
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
test('TGUIDE invalid incomplete row stays editable; only bot editor exposes the guide', async ({
  page,
  request,
}) => {
  const title = `Invalid guide ${randomUUID().slice(0, 8)}`;
  const bot = await createBot(request, title);
  await open(page, title);
  await page.getByRole('button', { name: '표기 추가', exact: true }).click();
  await page.getByLabel('표기 1 원문', { exact: true }).fill('Mira');
  await page.getByRole('button', { name: '변경사항 저장', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: '표기 1' }).first()).toBeVisible();
  await expect(page.getByLabel('표기 1 원문', { exact: true })).toHaveValue('Mira');
  expect((await (await request.get(`/api/content/${bot.id}`)).json()).revision).toBe(bot.revision);
  await page.getByLabel('표기 1 번역', { exact: true }).fill('미라');
  await save(page);
  const data = fixtureBotInput(`Persona ${randomUUID().slice(0, 8)}`);
  const persona = await (
    await request.post('/api/content', { data: { ...data, kind: 'persona' } })
  ).json();
  await page.goto('/');
  await navigationAction(page, '페르소나');
  await page.getByRole('searchbox', { name: '서재 검색', exact: true }).fill(persona.title);
  await page.getByRole('button', { name: `${persona.title} 상세 보기`, exact: true }).click();
  await page.getByRole('button', { name: '편집', exact: true }).click();
  await expect(page.getByLabel('Risu 자료 이름', { exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: '번역 지침', exact: true })).toHaveCount(0);
});
