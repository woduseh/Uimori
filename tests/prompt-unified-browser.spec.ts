import { test, expect } from '@playwright/test';
import type { PromptProgram } from '../core/prompt-program.js';

const complexProgram = (): PromptProgram => ({ version: 1,
  controls: Array.from({ length: 45 }, (_, i) => ({ id: `option-${i}`, label: `합성 옵션 ${i}`, type: 'boolean', default: false })),
  blocks: [
    { id: 'instructions', title: '기본 지침', kind: 'message', role: 'system', template: [{ kind: 'text', text: 'SYNTHETIC_ORIGINAL' }] },
    { id: 'conditional', title: '조건부 지침', kind: 'message', role: 'system', template: [{ kind: 'if', condition: { control: 'option-0' }, then: [{ kind: 'text', text: 'SYNTHETIC_DETAIL' }], else: [{ kind: 'text', text: 'SYNTHETIC_BRIEF' }] }] },
    ...Array.from({ length: 42 }, (_, i) => ({ id: `message-${i}`, title: `추가 지침 ${i}`, kind: 'message' as const, role: 'system' as const, template: [{ kind: 'text' as const, text: `SYNTHETIC_REFERENCE_${i}` }] })),
    { id: 'history', title: '대화', kind: 'history', from: 0, to: 'end' },
  ],
  provenance: { sourceHash: 'synthetic', variant: 'normal', conversionVersion: 'test', notes: [] },
});

test('PUNI01 views edit one AST; folding keeps drafts and complex messages cannot become plain text', async ({ page, request }, info) => {
  const program = complexProgram();
  const savedResponse = await request.post('/api/prompt-presets', { data: { title: 'Synthetic unified prompt', role: 'main', program } });
  expect(savedResponse.ok()).toBe(true); const saved = await savedResponse.json();
  expect(saved).not.toHaveProperty('text');
  const chatResponse = await request.post('/api/chats', { data: { title: 'Synthetic unified editor' } });
  expect(chatResponse.ok()).toBe(true); const chat = await chatResponse.json();
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`/?chat=${chat.id}`);
  await page.getByRole('button', { name: '채팅 설정', exact: true }).click();
  await page.getByRole('tab', { name: '프롬프트·창작 프리셋', exact: true }).click();
  const editor = page.getByTestId('prompt-editor'), composer = editor.getByTestId('prompt-composer');
  await editor.getByLabel('불러올 프롬프트', { exact: true }).selectOption(`${saved.id}@${saved.revision}`);
  const body = composer.getByLabel('메시지 본문', { exact: true });
  await expect(body).toHaveValue('SYNTHETIC_ORIGINAL');
  const save = editor.getByRole('button', { name: '기존 프롬프트 수정 저장', exact: true });
  await expect(save).toBeDisabled();
  await composer.getByRole('button', { name: '구성 편집', exact: true }).click();
  await composer.getByRole('button', { name: '간단 편집', exact: true }).click();
  await expect(save).toBeDisabled(); // A view change is not a prompt edit.
  const edited = 'SYNTHETIC_EDITED\n{{literal_text}}';
  await body.fill(edited);
  const fold = composer.getByLabel('프롬프트 구성 접기/펼치기', { exact: true });
  await fold.click(); await expect(body).not.toBeVisible(); await expect(save).toBeEnabled();
  await expect(fold).toContainText('45개 블록 · 45개 제어');
  for (const [name, width, height] of [['desktop', 1440, 1000], ['mobile', 390, 844]] as const) {
    await page.setViewportSize({ width, height });
    await expect(fold).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath(`prompt-collapsed-${name}.png`) });
  }
  await fold.press('Enter'); await expect(body).toHaveValue(edited);
  await page.screenshot({ path: info.outputPath('prompt-simple-mobile.png') });
  await composer.getByRole('button', { name: '구성 편집', exact: true }).click();
  const firstBlock = composer.locator('#prompt-block-instructions'); await firstBlock.locator('summary').first().click();
  await expect(firstBlock.getByLabel('기본 지침 본문', { exact: true })).toHaveValue(edited);
  await composer.getByRole('button', { name: '간단 편집', exact: true }).click();
  await composer.getByLabel('편집할 메시지', { exact: true }).selectOption('conditional');
  await expect(body).toHaveCount(0);
  await expect(composer.getByText('조건이나 참조가 포함된 본문이에요.', { exact: false })).toBeVisible();
  await composer.getByRole('button', { name: '이 메시지 구성 열기', exact: true }).click();
  await expect(composer.locator('#prompt-block-conditional')).toHaveAttribute('open', '');
  await save.click();
  await expect(editor.getByLabel('불러올 프롬프트', { exact: true })).toHaveValue(`${saved.id}@2`);
  const afterResponse = await request.get(`/api/revisions/prompt-preset/${saved.id}/2`); expect(afterResponse.ok()).toBe(true);
  const after = await afterResponse.json(); const expected = structuredClone(program);
  if (expected.blocks[0].kind === 'message') expected.blocks[0].template = [{ kind: 'text', text: edited }];
  expect(after.program).toEqual(expected); expect(after).not.toHaveProperty('text');
  expect((await (await request.get(`/api/revisions/prompt-preset/${saved.id}/1`)).json()).program).toEqual(program);
  expect(errors).toEqual([]);
});

test('PUNI02 file import edits the selected message only and both views preview that same text', async ({ page, request }) => {
  const program = complexProgram();
  const saved = await (await request.post('/api/prompt-presets', { data: { title: 'Synthetic body file', role: 'main', program } })).json();
  const chat = await (await request.post('/api/chats', { data: { title: 'Synthetic body import' } })).json();
  await page.goto(`/?chat=${chat.id}`); await page.getByRole('button', { name: '채팅 설정', exact: true }).click();
  await page.getByRole('tab', { name: '프롬프트·창작 프리셋', exact: true }).click();
  const editor = page.getByTestId('prompt-editor'), composer = editor.getByTestId('prompt-composer');
  await editor.getByLabel('불러올 프롬프트').selectOption(`${saved.id}@1`);
  await composer.getByLabel('편집할 메시지').selectOption('message-3');
  const imported = '  BODY FILE\n{{slot}} is literal.  ';
  await composer.getByLabel('메시지 본문 파일 불러오기').setInputFiles({ name: 'body.md', mimeType: 'text/markdown', buffer: Buffer.from(imported) });
  await expect(composer.getByLabel('메시지 본문', { exact: true })).toHaveValue(imported);
  await composer.getByLabel('미리보기 현재 요청').fill('SYNTHETIC_SINGLE_REQUEST');
  const previewResponse = page.waitForResponse(response => response.url().endsWith('/prompt-preview') && response.request().method() === 'POST');
  await composer.getByRole('button', { name: '미리보기 갱신', exact: true }).click();
  const preview = await (await previewResponse).json();
  expect(preview.error).toBeUndefined(); expect(preview.compilation.messages.find((m: { id: string }) => m.id === 'message-3').content[0].text).toBe(imported);
  expect(preview.compilation.messages.filter((m: { provenance: { origin: string } }) => m.provenance.origin === 'current')).toHaveLength(1);
  await editor.getByRole('button', { name: '기존 프롬프트 수정 저장', exact: true }).click();
  await expect(editor.getByLabel('불러올 프롬프트')).toHaveValue(`${saved.id}@2`);
  const after = await (await request.get(`/api/revisions/prompt-preset/${saved.id}/2`)).json();
  const expected = structuredClone(program); const index = expected.blocks.findIndex(block => block.id === 'message-3');
  const selected = expected.blocks[index]; if (selected.kind === 'message') selected.template = [{ kind: 'text', text: imported }];
  expect(after.program).toEqual(expected);
});
