import { visualReview } from './fixtures/visual-review.js';
import { navigationAction, openPromptTools, openPromptBlocks } from './ui-navigation.js';
import { test, expect } from '@playwright/test';
import type { PromptProgram } from '../core/prompt-program.js';

const program: PromptProgram = {
  version: 1,
  controls: [
    {
      id: 'tone',
      label: '합성 분위기',
      type: 'select',
      default: null,
      options: [
        { label: '차분하게', value: 'calm' },
        { label: '활기차게', value: 'bright' },
      ],
    },
  ],
  blocks: [
    {
      id: 'system',
      title: '합성 지침',
      kind: 'message',
      role: 'system',
      template: [
        { kind: 'text', text: 'SYNTHETIC TONE=' },
        { kind: 'value', expression: { control: 'tone' } },
      ],
    },
    {
      id: 'user',
      title: '합성 예시 질문',
      kind: 'message',
      role: 'user',
      template: [{ kind: 'text', text: 'Synthetic example question.' }],
    },
    {
      id: 'assistant',
      title: '합성 예시 응답',
      kind: 'message',
      role: 'assistant',
      template: [{ kind: 'text', text: 'Synthetic example response.' }],
      completion: 'complete',
    },
    { id: 'history', title: '합성 대화 범위', kind: 'history', from: 0, to: 'end' },
  ],
};

test('NUI01 native prompt metadata import, default options and authoring persistence', async ({
  page,
  request,
}, info) => {
  const title = `Native authoring ${crypto.randomUUID()}`;
  const before = await (await request.get('/api/prompt-workspace')).json();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await navigationAction(page, '프롬프트');
  await page.getByRole('button', { name: '새 프롬프트', exact: true }).click();
  const editor = page.getByTestId('prompt-editor');
  const composer = editor.getByTestId('prompt-composer');
  await openPromptTools(composer);
  await composer.getByLabel('프롬프트 구성 JSON 불러오기', { exact: true }).setInputFiles({
    name: 'native-prompt.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({ title, role: 'translation', program, values: { tone: 'bright' } })
    ),
  });
  await expect(editor.getByLabel('프롬프트 이름', { exact: true })).toHaveValue(title);
  await expect(editor.getByLabel('프롬프트 역할', { exact: true })).toHaveValue('translation');
  await expect(composer.locator('.pc-block')).toHaveCount(4);
  await expect(composer.getByLabel('합성 분위기', { exact: true })).toHaveValue('"bright"');
  await expect(editor.getByRole('button', { name: '현재 옵션 저장', exact: true })).toHaveCount(0);
  await expect(editor.getByRole('button', { name: '옵션 조합 저장', exact: true })).toHaveCount(0);
  await openPromptTools(composer);
  await composer.getByLabel('프롬프트 구성 JSON 불러오기', { exact: true }).setInputFiles({
    name: 'different-controls.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        version: 1,
        controls: [{ id: 'other', label: '다른 옵션', type: 'text', default: 'imported' }],
        blocks: [{ id: 'current', title: '현재 입력', kind: 'current' }],
      })
    ),
  });
  await expect(composer.getByLabel('다른 옵션', { exact: true })).toHaveValue('imported');
  await composer.getByLabel('프롬프트 구성 도구', { exact: true }).press('Escape');
  await composer.getByRole('button', { name: '이전 편집으로', exact: true }).click();
  await expect(composer.getByLabel('합성 분위기', { exact: true })).toHaveValue('"bright"');
  await expect(composer.getByLabel('다른 옵션', { exact: true })).toHaveCount(0);
  const jsonSection = composer
    .locator('.pc-section')
    .filter({ has: page.locator('summary', { hasText: '전체 구성 JSON · 고급 편집' }) });
  await jsonSection.locator('summary').first().click();
  const raw = composer.getByLabel('전체 프롬프트 구성 JSON', { exact: true });
  await raw.fill('{ malformed native JSON');
  await jsonSection.getByRole('button', { name: 'JSON 적용', exact: true }).click();
  await expect(raw).toHaveValue('{ malformed native JSON');
  await expect(composer.locator('.pc-block')).toHaveCount(4);
  await jsonSection.getByRole('button', { name: '적용된 값으로 되돌리기', exact: true }).click();
  await expect(raw).toHaveValue(JSON.stringify(program, null, 2));
  await composer.getByLabel('합성 분위기', { exact: true }).selectOption('"calm"');
  await editor.getByRole('button', { name: '저장', exact: true }).click();
  await expect
    .poll(async () => {
      const library = await (await request.get('/api/library')).json();
      return library.promptPresets.find((item: { title: string }) => item.title === title)?.values;
    })
    .toEqual({ tone: 'calm' });
  expect(await (await request.get('/api/prompt-workspace')).json()).toEqual(before);
  await openPromptTools(composer);
  const downloadPromise = page.waitForEvent('download');
  await composer.getByRole('button', { name: 'JSON 내보내기', exact: true }).click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  const exported = JSON.parse(Buffer.concat(chunks).toString());
  expect(exported).toMatchObject({ title, role: 'translation', program, values: { tone: 'calm' } });
  await composer.getByRole('button', { name: 'JSON 내보내기', exact: true }).press('Escape');
  await openPromptBlocks(composer);
  await composer.locator('.pc-block').first().locator('summary').first().click();
  for (const [name, width, height] of [
    ['desktop', 1440, 1000],
    ['mobile', 390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true
    );
    if (visualReview)
      await page.screenshot({ path: info.outputPath(`native-composer-${name}.png`) });
  }
  await page.reload();
  await navigationAction(page, '프롬프트');
  await page.getByRole('button', { name: `${title} 프롬프트 편집`, exact: true }).click();
  await expect(
    page.getByTestId('prompt-composer').getByLabel('합성 분위기', { exact: true })
  ).toHaveValue('"calm"');
  expect(errors).toEqual([]);
});
