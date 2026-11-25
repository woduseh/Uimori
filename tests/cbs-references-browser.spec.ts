import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Content, PromptPreset } from '../core/product.js';
import { createDefaultRisuPrompt } from '../core/prompt-defaults.js';
import { nativeContent } from './fixtures/native-content.js';
import { DESKTOP_HEIGHT, MOBILE_HEIGHT, MOBILE_WIDTH } from './fixtures/browser-viewports.js';
import { editLibraryContent, navigationAction, selectEditorSection } from './ui-navigation.js';
import { codeFieldValue, expectCodeFieldValue } from './code-field.js';

const screenshotDirectory = 'output/editor-studio-5';
const breakLua =
  "listenEdit('editDisplay', function(id, text) if string.find(text, 'BREAK') then error('deliberate draft failure') end return text end)";

async function capture(page: Page, name: string) {
  mkdirSync(screenshotDirectory, { recursive: true });
  await page.screenshot({ path: `${screenshotDirectory}/${name}.png` });
}

async function seedBot(request: APIRequestContext, title: string, card: Record<string, unknown>) {
  const response = await request.post('/api/content', {
    data: {
      kind: 'bot',
      title,
      package: nativeContent({ name: title, description: '', ...card }),
      loading: 'pinned',
      relatedIds: [],
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as Content;
}

const referenceCard = {
  first_mes: '오늘 기분은 {{getvar::mood}}이고 {{getvar::missing}}도 있어요.',
  alternate_greetings: ['두 번째 인사 {{setvar::mood::bright}}'],
  character_book: {
    entries: [
      {
        keys: ['숲'],
        content: '숲의 분위기는 {{getvar::mood}}예요.',
        comment: '조용한 숲',
        enabled: true,
        insertion_order: 0,
      },
    ],
  },
  extensions: {
    risuai: {
      defaultVariables: 'mood=calm\nspare=1',
      toggles: 'rain=비 오는 날\nsnow=눈 오는 날',
      customScripts: [
        {
          comment: '비 표시',
          type: 'editdisplay',
          in: '비',
          out: '{{#when::toggle::rain}}🌧{{/when}}',
          flag: 'g',
          ableFlag: true,
        },
      ],
    },
  },
};

async function openBot(page: Page, title: string, section: string) {
  await page.goto('/');
  await page.getByTestId('library-panel').getByLabel('서재 검색', { exact: true }).fill(title);
  await editLibraryContent(page, title);
  await selectEditorSection(page, section);
}

for (const viewport of [
  { name: 'desktop', width: 1440, height: DESKTOP_HEIGHT, theme: 'dark' },
  { name: 'phone', width: MOBILE_WIDTH, height: MOBILE_HEIGHT, theme: 'light' },
] as const)
  test(`CBSREF01 ${viewport.name} variable uses expand, jump and add a missing default`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ colorScheme: viewport.theme, reducedMotion: 'reduce' });
    await page.addInitScript((mode) => localStorage.setItem('uimori:theme', mode), viewport.theme);
    const title = `CBSREF01 ${randomUUID().slice(0, 8)}`;
    await seedBot(request, title, referenceCard);
    await openBot(page, title, '변수와 토글 초기값');
    const references = page.getByRole('region', { name: '변수와 토글 사용처', exact: true });
    await expect(references).toBeVisible();
    const mood = references.locator('details', {
      has: page.locator('code', { hasText: /^mood$/u }),
    });
    await expect(mood.locator('summary')).toContainText('읽기 2');
    await expect(mood.locator('summary')).toContainText('쓰기 1');
    const spare = references.locator('details', {
      has: page.locator('code', { hasText: /^spare$/u }),
    });
    await expect(spare.locator('summary')).toContainText('읽는 곳 없음');
    const snow = references.locator('details', {
      has: page.locator('code', { hasText: /^snow$/u }),
    });
    await expect(snow.locator('summary')).toContainText('쓰지 않는 토글');
    await snow.locator('summary').click();
    await expect(snow).toContainText('사용처를 찾지 못함');
    await mood.locator('summary').click();
    await expect(mood.getByRole('button')).toHaveCount(3);
    await mood.getByRole('button').filter({ hasText: '조용한 숲' }).scrollIntoViewIfNeeded();
    await capture(page, `variables-${viewport.name}-${viewport.theme}`);

    await mood.getByRole('button').filter({ hasText: '대체 첫 메시지 1' }).click();
    const alternate = page.getByRole('textbox', { name: '대체 첫 메시지', exact: true });
    await expect(alternate).toBeFocused();
    await expectCodeFieldValue(alternate, referenceCard.alternate_greetings[0]!);
    await expect
      .poll(() =>
        alternate.evaluate(() => {
          const selection = document.getSelection();
          return selection?.toString() ?? '';
        })
      )
      .toBe('mood');

    await selectEditorSection(page, '변수와 토글 초기값');
    await mood.getByRole('button').filter({ hasText: '조용한 숲' }).click();
    const lore = page.getByRole('textbox', { name: '로어 본문', exact: true });
    await expect(lore).toBeFocused();
    await expectCodeFieldValue(lore, referenceCard.character_book.entries[0]!.content);

    await selectEditorSection(page, '변수와 토글 초기값');
    const missing = references.locator('.cbs-missing-defaults');
    await expect(missing).toContainText('missing');
    await missing.getByRole('button', { name: 'missing 기본값 추가', exact: true }).click();
    const defaults = page.getByRole('textbox', { name: '기본 변수', exact: true });
    await expect(defaults).toHaveValue('mood=calm\nspare=1\nmissing=');
    await expect(defaults).toBeFocused();
    await page.keyboard.type('없음');
    await expect(missing).toHaveCount(0);
  });

test('CBSREF02 variable and toggle names complete inside CBS calls', async ({ page, request }) => {
  await page.setViewportSize({ width: 1440, height: DESKTOP_HEIGHT });
  const title = `CBSREF02 ${randomUUID().slice(0, 8)}`;
  await seedBot(request, title, referenceCard);
  await openBot(page, title, '첫 메시지');
  const field = page.getByRole('textbox', { name: '기본 첫 메시지', exact: true });
  await expect(field).toHaveClass(/cm-content/u);
  await field.locator('.cm-line').last().click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(' {{getvar::m');
  const completion = page.locator('.cm-tooltip-autocomplete');
  await expect(completion.getByRole('option', { name: 'mood', exact: true })).toBeVisible();
  await expect(completion.getByRole('option', { name: 'missing', exact: true })).toBeVisible();
  await capture(page, 'completion-variable');
  await completion.getByRole('option', { name: 'mood', exact: true }).click();
  await page.keyboard.type('}} {{#when::toggle::r');
  await completion.getByRole('option', { name: 'rain', exact: true }).click();
  await expect
    .poll(() => codeFieldValue(field))
    .toBe(`${referenceCard.first_mes} {{getvar::mood}} {{#when::toggle::rain`);
});

test('CBSREF03 preset toggles show their uses and jump to the block', async ({ page, request }) => {
  await page.setViewportSize({ width: 1440, height: DESKTOP_HEIGHT });
  const program = createDefaultRisuPrompt('Synthetic reference fixture.');
  program.nativeRisuPreset.preset.customPromptTemplateToggle = 'nsfw=수위 조절\nspare=남는 토글';
  program.nativeRisuPreset.preset.templateDefaultVariables = 'tone=dry';
  program.nativeRisuPreset.preset.promptTemplate = [
    {
      type: 'plain',
      role: 'system',
      name: '수위 블록',
      text: '{{#when::toggle::nsfw}}허용{{/when}}',
    },
    { type: 'plain', role: 'system', name: '말투 블록', text: '{{getvar::tone}} {{getvar::pace}}' },
  ];
  const response = await request.post('/api/prompt-presets', {
    data: { title: `CBSREF03 ${randomUUID().slice(0, 8)}`, role: 'main', program },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const preset = (await response.json()) as PromptPreset;
  await page.goto('/');
  await navigationAction(page, '프롬프트');
  await page.getByLabel('프롬프트 검색', { exact: true }).fill(preset.title);
  await page.getByRole('button', { name: `${preset.title} 프롬프트 편집`, exact: true }).click();
  const editor = page.getByTestId('prompt-editor');
  await selectEditorSection(editor, '변수와 토글');
  const definitions = editor.getByRole('region', { name: '토글 정의 편집기', exact: true });
  const nsfw = definitions.getByRole('button', { name: '수위 조절 편집', exact: true });
  await expect(nsfw).toContainText('사용처 1');
  await expect(
    definitions.getByRole('button', { name: '남는 토글 편집', exact: true })
  ).toContainText('쓰지 않는 토글');
  await definitions.getByRole('button', { name: '남는 토글 편집', exact: true }).click();
  await expect(definitions.locator('.nt-uses')).toContainText('사용처를 찾지 못함');
  await nsfw.click();
  await definitions.locator('.nt-uses').getByRole('button').click();
  await expect(
    editor.getByRole('textbox', { name: '1번 프롬프트 본문', exact: true })
  ).toBeFocused();

  await selectEditorSection(editor, '변수와 토글');
  await definitions.getByRole('button', { name: '기본 변수', exact: true }).click();
  const references = definitions.getByRole('region', { name: '변수와 토글 사용처', exact: true });
  await references.getByRole('button', { name: 'pace 기본값 추가', exact: true }).click();
  await expect(definitions.getByLabel('pace 기본값', { exact: true })).toBeVisible();
});

async function openPreview(page: Page, title: string) {
  await openBot(page, title, '첫 메시지');
  const field = page.getByRole('textbox', { name: '기본 첫 메시지', exact: true });
  await expect(field).toHaveClass(/cm-content/u);
  return field;
}

const previewCard = {
  first_mes: '<p>{{char}}가 문을 열어요. 기분은 {{getvar::mood}}.</p>',
  extensions: {
    risuai: {
      defaultVariables: 'mood=calm',
      triggerscript: [
        { comment: '오류 검사', type: 'start', effect: [{ type: 'triggerlua', code: breakLua }] },
      ],
    },
  },
};

for (const width of [1440, 1280])
  test(`PREVIEW01 ${width} live first message preview updates and survives an evaluation error`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width, height: DESKTOP_HEIGHT });
    const title = `PREVIEW01 ${randomUUID().slice(0, 8)}`;
    await seedBot(request, title, previewCard);
    const field = await openPreview(page, title);
    const preview = page.getByRole('region', { name: '저장 전 미리보기', exact: true });
    await expect(preview).toContainText(`${title}가 문을 열어요. 기분은 calm.`);
    await capture(page, `preview-desktop-${width}`);

    const requests: string[] = [];
    page.on('request', (item) => {
      if (item.method() === 'POST' && item.url().includes('/risu-preview'))
        requests.push(item.url());
    });
    await field.locator('.cm-line').last().click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type(' 새 문장');
    await expect(preview).toContainText('새 문장');
    expect(requests.length).toBeLessThanOrEqual(2);

    await page.keyboard.type(' BREAK');
    await expect(preview.getByRole('alert')).toContainText('deliberate draft failure');
    await expect(preview).toContainText('새 문장');
    if (width === 1440) await capture(page, 'preview-error');
    for (let i = 0; i < ' BREAK'.length; i++) await page.keyboard.press('Backspace');
    await expect(preview.getByRole('alert')).toHaveCount(0);

    await page.keyboard.type(' {{img::없는그림}}');
    await expect(preview.getByText(/미리보기에서 확인이 필요한 항목/u)).toBeVisible();
    if (width === 1440) {
      await preview.getByText(/미리보기에서 확인이 필요한 항목/u).click();
      await capture(page, 'preview-warning');
    }

    const toggle = page.getByRole('button', { name: '미리보기 표시', exact: true });
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await toggle.click();
    await expect(preview).toHaveCount(0);
    await selectEditorSection(page, '로어북');
    await selectEditorSection(page, '첫 메시지');
    await expect(page.getByRole('region', { name: '저장 전 미리보기', exact: true })).toHaveCount(
      0
    );
    await page.getByRole('button', { name: '미리보기 표시', exact: true }).click();
    await expect(page.getByRole('region', { name: '저장 전 미리보기', exact: true })).toBeVisible();
  });

test('PREVIEW02 phone switches between editing and the live preview', async ({ page, request }) => {
  await page.setViewportSize({ width: MOBILE_WIDTH, height: MOBILE_HEIGHT });
  const title = `PREVIEW02 ${randomUUID().slice(0, 8)}`;
  await seedBot(request, title, previewCard);
  const field = await openPreview(page, title);
  const modes = page.getByRole('group', { name: '첫 메시지 보기 방식', exact: true });
  await expect(modes.getByRole('button', { name: '편집', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await field.locator('.cm-line').last().click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(' 휴대폰 문장');
  await capture(page, 'preview-phone-edit');
  await modes.getByRole('button', { name: '미리보기', exact: true }).click();
  const preview = page.getByRole('region', { name: '저장 전 미리보기', exact: true });
  await expect(preview).toContainText('휴대폰 문장');
  await expect(field).toHaveCount(0);
  await capture(page, 'preview-phone-preview');
  await modes.getByRole('button', { name: '편집', exact: true }).click();
  await expectCodeFieldValue(
    page.getByRole('textbox', { name: '기본 첫 메시지', exact: true }),
    `${previewCard.first_mes} 휴대폰 문장`
  );
});
