import { visualReview } from './fixtures/visual-review.js';
import { navigationAction } from './ui-navigation.js';
import { test, expect } from '@playwright/test';
import type { PromptProgram } from '../core/prompt-program.js';

const complexProgram = (): PromptProgram => ({
  version: 1,
  controls: Array.from({ length: 45 }, (_, i) => ({
    id: `option-${i}`,
    label: `합성 옵션 ${i}`,
    type: 'boolean',
    default: false,
  })),
  blocks: [
    {
      id: 'instructions',
      title: '기본 지침',
      kind: 'message',
      role: 'system',
      template: [{ kind: 'text', text: 'SYNTHETIC_ORIGINAL' }],
    },
    {
      id: 'conditional',
      title: '조건부 지침',
      kind: 'message',
      role: 'system',
      template: [
        {
          kind: 'if',
          condition: { control: 'option-0' },
          then: [{ kind: 'text', text: 'SYNTHETIC_DETAIL' }],
          else: [{ kind: 'text', text: 'SYNTHETIC_BRIEF' }],
        },
      ],
    },
    ...Array.from({ length: 42 }, (_, i) => ({
      id: `message-${i}`,
      title: `추가 지침 ${i}`,
      kind: 'message' as const,
      role: 'system' as const,
      template: [{ kind: 'text' as const, text: `SYNTHETIC_REFERENCE_${i}` }],
    })),
    { id: 'history', title: '대화', kind: 'history', from: 0, to: 'end' },
  ],
  provenance: { sourceHash: 'synthetic', variant: 'normal', conversionVersion: 'test', notes: [] },
});

test('PUNI01 structured editor preserves one AST; folding keeps drafts and complex messages cannot become plain text', async ({
  page,
  request,
}, info) => {
  const program = complexProgram();
  const savedResponse = await request.post('/api/prompt-presets', {
    data: { title: 'Synthetic unified prompt', role: 'main', program },
  });
  expect(savedResponse.ok()).toBe(true);
  const saved = await savedResponse.json();
  expect(saved).not.toHaveProperty('text');
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await navigationAction(page, '프롬프트');
  await page
    .getByTestId('prompt-library')
    .getByRole('button', { name: `${saved.title} 프롬프트 편집`, exact: true })
    .click();
  const editor = page.getByTestId('prompt-editor'),
    composer = editor.getByTestId('prompt-composer');
  const firstBlock = composer.locator('#prompt-block-instructions');
  await firstBlock.locator('summary').first().click();
  const body = firstBlock.getByLabel('기본 지침 본문', { exact: true });
  await expect(body).toHaveValue('SYNTHETIC_ORIGINAL');
  const save = editor.getByRole('button', { name: '수정 저장', exact: true });
  await expect(save).toBeDisabled();
  await expect(composer.getByRole('button', { name: '간단 편집', exact: true })).toHaveCount(0);
  await firstBlock.locator('summary').first().click();
  await firstBlock.locator('summary').first().click();
  await expect(save).toBeDisabled(); // Folding is not a prompt edit.
  const edited = 'SYNTHETIC_EDITED\n{{literal_text}}';
  await body.fill(edited);
  const blockFold = composer.getByLabel('프롬프트 블록 접기/펼치기', { exact: true });
  await blockFold.click();
  await expect(body).not.toBeVisible();
  await expect(composer.getByText('제어 정의 · 45개', { exact: true })).toBeVisible();
  await expect(composer.getByLabel('전송 미리보기 접기/펼치기')).toBeVisible();
  await blockFold.press('Enter');
  await expect(body).toBeVisible();
  await expect(body).toHaveValue(edited);
  const fold = composer.getByLabel('프롬프트 구성 접기/펼치기', { exact: true });
  await fold.click();
  await expect(body).not.toBeVisible();
  await expect(save).toBeEnabled();
  await expect(fold).toContainText('45개 블록 · 45개 제어');
  for (const [name, width, height] of [
    ['desktop', 1440, 1000],
    ['mobile', 390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    await expect(fold).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true
    );
    if (visualReview)
      await page.screenshot({ path: info.outputPath(`prompt-collapsed-${name}.png`) });
  }
  await fold.press('Enter');
  await expect(body).toHaveValue(edited);
  if (visualReview) await page.screenshot({ path: info.outputPath('prompt-structure-mobile.png') });
  await expect(firstBlock.getByLabel('기본 지침 본문', { exact: true })).toHaveValue(edited);
  const conditional = composer.locator('#prompt-block-conditional');
  await conditional.locator('summary').first().click();
  await expect(conditional.getByLabel('조건부 지침 본문', { exact: true })).toHaveCount(0);
  await expect(
    conditional.getByText('조건·값·참조가 있는 템플릿이에요.', { exact: false })
  ).toBeVisible();
  await expect(conditional.getByLabel('조건부 지침 본문 JSON', { exact: true })).toHaveValue(
    JSON.stringify(program.blocks[1].kind === 'message' ? program.blocks[1].template : [], null, 2)
  );
  await save.click();
  await expect
    .poll(
      async () => (await (await request.get(`/api/prompt-presets/${saved.id}`)).json()).revision
    )
    .toBe(2);
  const afterResponse = await request.get(`/api/revisions/prompt-preset/${saved.id}/2`);
  expect(afterResponse.ok()).toBe(true);
  const after = await afterResponse.json();
  const expected = structuredClone(program);
  if (expected.blocks[0].kind === 'message')
    expected.blocks[0].template = [{ kind: 'text', text: edited }];
  expect(after.program).toEqual(expected);
  expect(after).not.toHaveProperty('text');
  expect(
    (await (await request.get(`/api/revisions/prompt-preset/${saved.id}/1`)).json()).program
  ).toEqual(program);
  expect(errors).toEqual([]);
});

test('PUNI02 file import edits one block and folded preview retains its snapshot', async ({
  page,
  request,
}) => {
  const program = complexProgram();
  const saved = await (
    await request.post('/api/prompt-presets', {
      data: { title: 'Synthetic body file', role: 'main', program },
    })
  ).json();
  await page.goto('/');
  await navigationAction(page, '프롬프트');
  await page
    .getByTestId('prompt-library')
    .getByRole('button', { name: `${saved.title} 프롬프트 편집`, exact: true })
    .click();
  const editor = page.getByTestId('prompt-editor'),
    composer = editor.getByTestId('prompt-composer');
  const block = composer.locator('#prompt-block-message-3');
  await block.locator('summary').first().click();
  const imported = '  BODY FILE\n{{slot}} is literal.  ';
  await block
    .getByLabel('추가 지침 3 본문 파일 불러오기')
    .setInputFiles({ name: 'body.md', mimeType: 'text/markdown', buffer: Buffer.from(imported) });
  await expect(block.getByLabel('추가 지침 3 본문', { exact: true })).toHaveValue(imported);
  const previewFold = composer.getByLabel('전송 미리보기 접기/펼치기', { exact: true });
  await expect(composer.getByLabel('미리보기 현재 요청')).not.toBeVisible();
  await previewFold.click();
  await composer.getByLabel('미리보기 현재 요청').fill('SYNTHETIC_SINGLE_REQUEST');
  await composer.getByRole('button', { name: '미리보기 갱신', exact: true }).click();
  const messages = composer.locator('.pc-message-list > li');
  const importedMessage = messages.filter({
    has: page.getByText('6. 추가 지침 3 · prompt', { exact: true }),
  });
  await importedMessage.locator('summary').click();
  await expect(importedMessage.locator('pre')).toHaveText(imported);
  await expect(messages.filter({ hasText: 'SYNTHETIC_SINGLE_REQUEST' })).toHaveCount(1);
  await composer.getByText('블록별 조건과 포함 결과', { exact: true }).click();
  const traceName = composer.getByRole('cell', { name: '6. 추가 지침 3', exact: true });
  await expect(traceName).toBeVisible();
  await previewFold.click();
  await expect(traceName).not.toBeVisible();
  await previewFold.press('Enter');
  await expect(traceName).toBeVisible();
  await expect(composer.getByLabel('미리보기 현재 요청')).toHaveValue('SYNTHETIC_SINGLE_REQUEST');
  await editor.getByRole('button', { name: '수정 저장', exact: true }).click();
  await expect
    .poll(
      async () => (await (await request.get(`/api/prompt-presets/${saved.id}`)).json()).revision
    )
    .toBe(2);
  const after = await (await request.get(`/api/revisions/prompt-preset/${saved.id}/2`)).json();
  const expected = structuredClone(program);
  const index = expected.blocks.findIndex((block) => block.id === 'message-3');
  const selected = expected.blocks[index];
  if (selected.kind === 'message') selected.template = [{ kind: 'text', text: imported }];
  expect(after.program).toEqual(expected);
});

test('PUNI03 translation list preview uses exact source and one current request; role and folding preserve drafts', async ({
  page,
}) => {
  await page.goto('/');
  await navigationAction(page, '프롬프트');
  await page
    .getByTestId('prompt-library')
    .getByRole('button', { name: '새 프롬프트', exact: true })
    .first()
    .click();
  const editor = page.getByTestId('prompt-editor');
  const composer = editor.getByTestId('prompt-composer');
  const fold = composer.getByLabel('전송 미리보기 접기/펼치기', { exact: true });
  await fold.click();
  await composer.getByLabel('미리보기 현재 요청', { exact: true }).fill('MAIN_DRAFT');
  await editor.getByLabel('프롬프트 역할', { exact: true }).selectOption('translation');
  await fold.click();
  const source = '  Exact translation source.\n\n원문 한글  ';
  await composer.getByLabel('미리보기 원문', { exact: true }).fill(source);
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET') writes.push(`${request.method()} ${request.url()}`);
  });
  await composer.getByRole('button', { name: '미리보기 갱신', exact: true }).click();
  const messages = composer.locator('.pc-message-list > li');
  await expect(messages).toHaveCount(5);
  await expect(composer.locator('.pc-preview-result')).not.toContainText('합성 이전');
  const sourceMessage = messages.filter({ hasText: 'source:' });
  await sourceMessage.locator('summary').click();
  await expect(sourceMessage.locator('pre')).toHaveText(`source:\n${source}`);
  const jsonSection = composer
    .locator('details')
    .filter({ has: page.locator(':scope > summary', { hasText: '전체 구성 JSON · 고급 편집' }) });
  await jsonSection.locator(':scope > summary').click();
  const json = jsonSection.getByLabel('전체 프롬프트 구성 JSON', { exact: true });
  const program = JSON.parse(await json.inputValue()) as PromptProgram;
  program.blocks = program.blocks.map((block) =>
    block.kind === 'history' ? { id: 'current', title: 'Current', kind: 'current' } : block
  );
  await json.fill(JSON.stringify(program));
  await jsonSection.getByRole('button', { name: 'JSON 적용', exact: true }).click();
  await composer.getByRole('button', { name: '미리보기 갱신', exact: true }).click();
  await expect(messages).toHaveCount(5);
  await expect(composer).not.toContainText('PROMPT_HISTORY_OMITTED');
  await fold.click();
  await fold.click();
  await expect(composer.getByLabel('미리보기 원문', { exact: true })).toHaveValue(source);
  await editor.getByLabel('프롬프트 역할', { exact: true }).selectOption('main');
  await fold.click();
  await expect(composer.getByLabel('미리보기 현재 요청', { exact: true })).toHaveValue(
    'MAIN_DRAFT'
  );
  await editor.getByLabel('프롬프트 역할', { exact: true }).selectOption('translation');
  await fold.click();
  await expect(composer.getByLabel('미리보기 원문', { exact: true })).toHaveValue(source);
  expect(writes).toEqual([]);
});
