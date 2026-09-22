import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Content, PromptPreset } from '../core/product.js';
import { readCharacterCard } from '../server/character-card-file.js';
import { readRisuPresetFile } from '../server/risu-preset-file.js';
import {
  DESKTOP_HEIGHT,
  DESKTOP_WIDTH,
  MOBILE_HEIGHT,
  MOBILE_WIDTH,
} from './fixtures/browser-viewports.js';
import { nativeContent } from './fixtures/native-content.js';
import { nativePrompt } from './fixtures/native-prompt.js';
import { editLibraryContent, navigationAction } from './ui-navigation.js';

async function post<T>(request: APIRequestContext, path: string, data: unknown): Promise<T> {
  const response = await request.post(path, { data });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

async function editorFits(page: Page, editor: Locator, save: Locator, formMaxWidth = 960) {
  await expect(editor).toBeVisible();
  await expect(save).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  ).toBeLessThanOrEqual(1);
  expect(await editor.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(
    1
  );
  // Do not scroll the action into view: the editor must keep its primary action reachable.
  await expect(save).toBeInViewport({ ratio: 1 });
  expect(
    await save.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      return (
        rect.left >= -1 &&
        rect.top >= -1 &&
        rect.right <= window.innerWidth + 1 &&
        rect.bottom <= window.innerHeight + 1
      );
    })
  ).toBe(true);
  if ((page.viewportSize()?.width ?? 0) >= 1200) {
    const workspace = editor.locator('.native-editor');
    const layout = await workspace.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      const parent = node.closest('.library-page')!.getBoundingClientRect();
      return {
        width: rect.width,
        centerOffset: rect.x + rect.width / 2 - parent.x - parent.width / 2,
      };
    });
    expect(layout.width).toBeLessThanOrEqual(1300);
    expect(Math.abs(layout.centerOffset)).toBeLessThanOrEqual(2);
    const form = workspace.locator('.native-section-body:visible').first();
    if (await form.count()) {
      const body = await form.boundingBox();
      const outer = await workspace.boundingBox();
      expect(body!.width).toBeLessThanOrEqual(formMaxWidth);
      expect(Math.abs(body!.x + body!.width / 2 - outer!.x - outer!.width / 2)).toBeLessThanOrEqual(
        2
      );
    }
  }
}

async function advancedWorkspaceFits(page: Page, editor: Locator) {
  const workspace = editor.locator('.native-advanced-workspace');
  const nav = workspace.getByRole('group', { name: '고급 설정 영역', exact: true });
  const detail = workspace.locator('.native-advanced-detail:visible');
  await expect(workspace).toBeVisible();
  await expect(nav).toBeVisible();
  await expect(detail).toHaveCount(1);
  const [pageOverflow, editorOverflow] = await Promise.all([
    page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
    editor.evaluate((node) => node.scrollWidth - node.clientWidth),
  ]);
  expect(Math.max(pageOverflow, editorOverflow)).toBeLessThanOrEqual(1);
  if ((page.viewportSize()?.width ?? 0) >= 1200) {
    const [navBounds, detailBounds] = await Promise.all([nav.boundingBox(), detail.boundingBox()]);
    expect(Math.abs(navBounds!.y - detailBounds!.y)).toBeLessThanOrEqual(1);
  }
}

async function openMenu(editor: Locator, label: string) {
  const trigger = editor.getByLabel(label, { exact: true });
  await expect(trigger).toBeVisible();
  if (!(await trigger.evaluate((node) => (node.parentElement as HTMLDetailsElement).open)))
    await trigger.click();
}

function nextSave(page: Page) {
  return page.waitForResponse(
    (response) =>
      /\/api\/resources\/save$/.test(new URL(response.url()).pathname) &&
      response.request().method() === 'POST'
  );
}

const viewports = [
  { name: 'desktop', width: DESKTOP_WIDTH, height: DESKTOP_HEIGHT },
  { name: 'mobile', width: MOBILE_WIDTH, height: MOBILE_HEIGHT },
];

for (const viewport of viewports) {
  test.describe(`UI recovery ${viewport.name} ${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('long block lists stay readable and settings retain the centered workspace', async ({
      page,
      request,
    }, info) => {
      const title = `UIREC long preset ${randomUUID().slice(0, 8)}`;
      const names = Array.from(
        { length: 48 },
        (_, i) => `${i + 1}. Perspective, Character Motivation and Narrative Continuity ${i + 1}`
      );
      const program = nativePrompt('Long-list fixture', {
        promptTemplate: names.map((name, i) => ({
          type: 'plain',
          role: i === 0 ? 'bot' : 'system',
          name,
          text: `Instruction ${i + 1}`,
        })),
        customPromptTemplateToggle: 'tone=분위기=select=Quiet,Bright',
        templateDefaultVariables: 'place=library',
      });
      await post<PromptPreset>(request, '/api/prompt-presets', {
        title,
        role: 'main',
        program,
        values: {},
      });
      await page.goto('/');
      await navigationAction(page, '프롬프트');
      await page.getByLabel('프롬프트 검색', { exact: true }).fill(title);
      await page.getByRole('button', { name: `${title} 프롬프트 편집`, exact: true }).click();
      const editor = page.getByTestId('prompt-editor');
      const save = editor.getByRole('button', { name: '프리셋 저장', exact: true });
      await editorFits(page, editor, save);
      const role = editor.getByLabel('1번 블록 역할', { exact: true });
      await expect(role).toHaveValue('assistant');
      await expect(role.locator('option')).toHaveText(['system', 'user', 'assistant']);
      await role.focus();
      const roleBounds = await role.evaluate((node) => {
        const control = node.getBoundingClientRect();
        const detail = node.closest('.native-item-detail')!.getBoundingClientRect();
        return { right: control.right, limit: detail.right };
      });
      expect(roleBounds.right + 3).toBeLessThanOrEqual(roleBounds.limit);
      await page.screenshot({ path: info.outputPath(`message-role-${viewport.name}.png`) });
      await role.selectOption('user');
      await role.selectOption('assistant');
      await editor.getByLabel('1번 블록 이름', { exact: true }).fill('Assistant instruction');
      const savedResponse = nextSave(page);
      await save.click();
      const saved = (await (await savedResponse).json()).saved;
      expect(saved.program.nativeRisuPreset.preset.promptTemplate[0].role).toBe('bot');
      if (viewport.name === 'desktop') {
        const list = editor.getByRole('complementary', { name: '프롬프트 블록 목록' });
        const rows = list.locator(':scope > button');
        await expect(rows).toHaveCount(48);
        const bounds = await rows.evaluateAll((nodes) =>
          nodes.map((node) => {
            const row = node.getBoundingClientRect();
            const title = node.querySelector('strong')!.getBoundingClientRect();
            const subtitle = node.querySelector('small')!.getBoundingClientRect();
            return {
              top: row.top,
              bottom: row.bottom,
              titleBottom: title.bottom,
              subtitleTop: subtitle.top,
              subtitleBottom: subtitle.bottom,
            };
          })
        );
        for (let i = 0; i < bounds.length; i++) {
          expect(bounds[i].subtitleTop).toBeGreaterThanOrEqual(bounds[i].titleBottom - 1);
          expect(bounds[i].subtitleBottom).toBeLessThanOrEqual(bounds[i].bottom + 1);
          if (i) expect(bounds[i].top).toBeGreaterThanOrEqual(bounds[i - 1].bottom);
        }
        await page.screenshot({ path: info.outputPath('long-list-desktop.png') });
        await rows.last().click();
      } else {
        await editor.getByLabel('현재 프롬프트 블록', { exact: true }).selectOption('47');
      }
      await expect(editor.getByLabel('48번 프롬프트 본문', { exact: true })).toHaveValue(
        'Instruction 48'
      );
      await editor.getByRole('tab', { name: '변수·토글', exact: true }).click();
      await editorFits(page, editor, save, 1200);
      await page.screenshot({ path: info.outputPath(`centered-variables-${viewport.name}.png`) });
    });

    test('native basic options preserve input types, captions and retired-field removal', async ({
      page,
      request,
    }, info) => {
      const title = `UIREC toggle options ${randomUUID().slice(0, 8)}`;
      const declarations =
        '=기본 입력=group\nshort=짧은 입력=text\n=짧은 입력에 사용할 이름을 작성해요.=caption\n=추가 입력=divider\nlong=긴 입력=textarea\nflag=분위기 강조\nmode=시점=select=1인칭,3인칭\n==groupEnd\n=그룹 밖 안내예요.=caption\n=안내만 있는 그룹=group\n=입력 없이도 안내를 표시해요.=caption\n==groupEnd';
      await post<PromptPreset>(request, '/api/prompt-presets', {
        title,
        role: 'main',
        program: nativePrompt('Toggle options fixture', {
          customPromptTemplateToggle: declarations,
          jailbreakToggle: true,
          chainOfThought: true,
          promptSettings: {
            sendName: true,
            sendChatAsSystem: true,
            postEndInnerFormat: 'Retired suffix',
            assistantPrefill: 'Retired prefill',
          },
        }),
        values: { short: '서울', long: '첫 줄\n둘째 줄', flag: '1', mode: '0' },
      });
      await page.goto('/');
      await navigationAction(page, '프롬프트');
      await page.getByLabel('프롬프트 검색', { exact: true }).fill(title);
      await page.getByRole('button', { name: `${title} 프롬프트 편집`, exact: true }).click();
      const editor = page.getByTestId('prompt-editor');
      const save = editor.getByRole('button', { name: '프리셋 저장', exact: true });
      await editor.locator('summary').filter({ hasText: '블록 종류' }).click();
      const blockType = editor.getByLabel('1번 블록 종류', { exact: true });
      await expect(blockType.locator('option[value="jailbreak"], option[value="cot"]')).toHaveCount(
        0
      );
      await expect(editor.locator('option[value="jailbreak"]')).toHaveCount(0);
      await expect(
        editor.getByLabel('시스템 메시지로 보내기 설정에서도 원래 대화 역할 유지', { exact: true })
      ).toHaveCount(0);
      await editor.getByRole('tab', { name: '기본 옵션', exact: true }).click();
      for (const label of [
        '탈옥 프롬프트 사용',
        '사고 지침 사용',
        '대화에 화자 이름 포함',
        '대화를 시스템 메시지로 보내기',
        '마지막 지침 뒤에 추가할 문구',
        '응답 시작 문구',
      ])
        await expect(editor.getByLabel(label, { exact: true })).toHaveCount(0);
      await expect(editor.locator('.prompt-option-caption')).toHaveText([
        '짧은 입력에 사용할 이름을 작성해요.',
        '그룹 밖 안내예요.',
        '입력 없이도 안내를 표시해요.',
      ]);
      await expect(editor.locator('.prompt-option-divider')).toHaveText('추가 입력');
      const caption = editor
        .getByRole('tabpanel', { name: '기본 옵션', exact: true })
        .getByText('짧은 입력에 사용할 이름을 작성해요.', { exact: true });
      const captionBounds = await caption.boundingBox();
      const input = editor.getByLabel('짧은 입력', { exact: true });
      const textarea = editor.getByLabel('긴 입력', { exact: true });
      const inputBounds = await input.boundingBox();
      const nextBounds = await textarea.boundingBox();
      expect(captionBounds!.y).toBeGreaterThan(inputBounds!.y + inputBounds!.height);
      expect(captionBounds!.y + captionBounds!.height).toBeLessThan(nextBounds!.y);
      await expect(input).toHaveJSProperty('tagName', 'INPUT');
      await expect(textarea).toHaveJSProperty('tagName', 'TEXTAREA');
      await input.fill('부산');
      await textarea.fill('수정 첫 줄\n수정 둘째 줄');
      const toggle = editor.getByRole('switch', { name: '분위기 강조', exact: true });
      await expect(toggle).toBeChecked();
      await toggle.press('Space');
      await expect(toggle).not.toBeChecked();
      await toggle.click();
      await expect(toggle).toBeChecked();
      await toggle.press('Space');
      await expect(toggle).not.toBeChecked();
      await expect(editor.getByLabel('시점', { exact: true })).toHaveValue('"0"');
      await editorFits(page, editor, save, 1200);
      expect((await toggle.boundingBox())!.width).toBe(44);
      await page.screenshot({ path: info.outputPath(`native-options-${viewport.name}.png`) });
    });

    test('native toggle editor preserves source, isolated previews and grouped inline edits', async ({
      page,
      request,
    }, info) => {
      const title = `UIREC toggle preset ${randomUUID().slice(0, 8)}`;
      const declarations =
        '=기본 입력=group\nshort=짧은 입력=text\n=짧은 입력에 사용할 이름을 작성해요.=caption\nmode=시점=select=1인칭,,3인칭\n=시점을 골라요.=caption\n==groupEnd\n=보조 입력=group\nlong=긴 입력=textarea\nflag=분위기 강조\n==groupEnd\n=그룹 밖 안내예요.=caption\nunknown source line';
      const defaultVariables = 'number=001\ntruth=false\njson={"nested":true}\nempty=';
      await post<PromptPreset>(request, '/api/prompt-presets', {
        title,
        role: 'main',
        program: nativePrompt('Toggle form fixture', {
          customPromptTemplateToggle: declarations,
          templateDefaultVariables: defaultVariables,
        }),
        values: { short: '서울', long: '첫 줄\n둘째 줄', flag: '1', mode: '0' },
      });
      await page.goto('/');
      await navigationAction(page, '프롬프트');
      await page.getByLabel('프롬프트 검색', { exact: true }).fill(title);
      await page.getByRole('button', { name: `${title} 프롬프트 편집`, exact: true }).click();
      const editor = page.getByTestId('prompt-editor');
      const save = editor.getByRole('button', { name: '프리셋 저장', exact: true });
      await editor.getByRole('tab', { name: '변수·토글', exact: true }).click();
      const definitions = editor.getByRole('region', { name: '토글 정의 편집기', exact: true });
      const editView = definitions.getByRole('button', { name: '편집', exact: true });
      const previewView = definitions.getByRole('button', { name: '미리보기', exact: true });
      const rawView = definitions.getByRole('button', { name: '원문', exact: true });
      await expect(editView).toHaveAttribute('aria-pressed', 'true');
      await expect(
        definitions.getByRole('button', { name: '토글 구성', exact: true })
      ).toHaveAttribute('aria-pressed', 'true');
      await expect(definitions.getByLabel('이름, 키, 설명 검색', { exact: true })).toBeVisible();
      if (viewport.name === 'desktop') {
        await expect(definitions.getByRole('navigation', { name: '토글 그룹' })).toBeVisible();
        await expect(definitions.getByLabel('토글 그룹 선택', { exact: true })).toBeHidden();
      } else {
        await expect(definitions.getByLabel('토글 그룹 선택', { exact: true })).toBeVisible();
        await expect(definitions.getByRole('navigation', { name: '토글 그룹' })).toBeHidden();
      }
      const chooseGroup = async (label: string) => {
        if (viewport.name === 'mobile')
          await definitions.getByLabel('토글 그룹 선택', { exact: true }).selectOption({ label });
        else await definitions.getByRole('button', { name: new RegExp(`^${label}`) }).click();
      };

      // Preview values are local UI state and must not dirty either persisted document.
      await previewView.click();
      await definitions.getByLabel('짧은 입력', { exact: true }).fill('미리보기 전용');
      await definitions.getByLabel('시점', { exact: true }).selectOption({ label: '3인칭' });
      await expect(definitions.getByLabel('긴 입력', { exact: true })).toHaveCount(0);
      await expect(
        definitions.getByRole('switch', { name: '분위기 강조', exact: true })
      ).toHaveCount(0);
      await chooseGroup('보조 입력');
      await expect(definitions.getByLabel('짧은 입력', { exact: true })).toHaveCount(0);
      await expect(definitions.getByLabel('긴 입력', { exact: true })).toBeVisible();
      const previewToggle = definitions.getByRole('switch', {
        name: '분위기 강조',
        exact: true,
      });
      await expect(previewToggle).not.toBeChecked();
      await previewToggle.click();
      await expect(previewToggle).toBeChecked();
      await previewToggle.click();
      await expect(previewToggle).not.toBeChecked();
      await expect(save).toBeDisabled();
      await chooseGroup('기본 입력');
      await rawView.click();
      let raw = definitions.getByLabel('토글 정의 원문', { exact: true });
      await expect(raw).toHaveValue(declarations);
      await editView.click();

      // Basic-variable strings and the untouched toggle source survive view switches byte-for-byte.
      await definitions.getByRole('button', { name: '기본 변수', exact: true }).click();
      await expect(definitions.getByLabel('변수 1 키', { exact: true })).toHaveValue('number');
      await expect(definitions.getByLabel('number 기본값', { exact: true })).toHaveValue('001');
      await expect(definitions.getByLabel('truth 기본값', { exact: true })).toHaveValue('false');
      await expect(definitions.getByLabel('json 기본값', { exact: true })).toHaveValue(
        '{"nested":true}'
      );
      const guiDefaultVariables = defaultVariables.replace('number=001', 'number=0007');
      await definitions.getByLabel('number 기본값', { exact: true }).fill('0007');
      await definitions.getByRole('button', { name: '편집 되돌리기', exact: true }).click();
      await expect(definitions.getByLabel('number 기본값', { exact: true })).toHaveValue('001');
      await definitions.getByRole('button', { name: '편집 다시 적용', exact: true }).click();
      await expect(definitions.getByLabel('number 기본값', { exact: true })).toHaveValue('0007');
      await rawView.click();
      await expect(definitions.getByLabel('Risu 기본 변수', { exact: true })).toHaveValue(
        guiDefaultVariables
      );
      await editView.click();
      await definitions.getByRole('button', { name: '토글 구성', exact: true }).click();
      await rawView.click();
      raw = definitions.getByLabel('토글 정의 원문', { exact: true });
      await expect(raw).toHaveValue(declarations);
      await editView.click();

      // Search includes captions, and an unknown line stays represented instead of being dropped.
      const search = definitions.getByLabel('이름, 키, 설명 검색', { exact: true });
      await search.fill('시점을 골라요.');
      await expect(
        definitions.getByRole('button', { name: '시점 편집', exact: true })
      ).toBeVisible();
      await search.fill('unknown source line');
      await expect(definitions.getByText('unknown source line', { exact: true })).toBeVisible();
      await search.fill('');

      // Inline edits update the shared source; undo and redo restore the exact field value.
      await definitions.getByRole('button', { name: '짧은 입력 편집', exact: true }).click();
      const displayName = definitions.getByLabel('표시 이름', { exact: true });
      await displayName.fill('이름 입력');
      await definitions.getByRole('button', { name: '편집 되돌리기', exact: true }).click();
      await expect(
        definitions.getByRole('button', { name: '짧은 입력 편집', exact: true })
      ).toBeVisible();
      await definitions.getByRole('button', { name: '편집 다시 적용', exact: true }).click();
      await definitions.getByRole('button', { name: '이름 입력 편집', exact: true }).click();
      await expect(definitions.getByLabel('표시 이름', { exact: true })).toHaveValue('이름 입력');
      let variableKey = definitions.getByLabel('변수 키', { exact: true });
      await variableKey.fill('');
      await expect(variableKey).toHaveValue('');
      await expect(variableKey).toHaveAttribute('aria-invalid', 'true');
      await save.click();
      await expect(
        editor
          .getByRole('alert')
          .filter({ hasText: '잘못 입력된 토글 또는 변수 값을 확인해 주세요.' })
      ).toBeVisible();
      await editor.getByRole('tab', { name: '구성', exact: true }).click();
      await editor.getByRole('tab', { name: '변수·토글', exact: true }).click();
      variableKey = definitions.getByLabel('변수 키', { exact: true });
      await expect(variableKey).toHaveValue('');
      await variableKey.fill('short');
      await expect(save).toBeEnabled();
      await definitions.getByLabel('입력 형식', { exact: true }).selectOption('textarea');
      await definitions.getByLabel('설명', { exact: true }).fill('이름을 여러 줄로 작성해요.');
      await definitions
        .getByLabel('소속 그룹', { exact: true })
        .selectOption({ label: '보조 입력' });

      await chooseGroup('기본 입력');
      await expect(
        definitions.getByRole('button', { name: '이름 입력 편집', exact: true })
      ).toHaveCount(0);
      await chooseGroup('보조 입력');
      await expect(
        definitions.getByRole('button', { name: '이름 입력 편집', exact: true })
      ).toBeVisible();
      await expect(
        definitions.getByText('이름을 여러 줄로 작성해요.', { exact: true })
      ).toBeVisible();

      await chooseGroup('기본 입력');
      await definitions.getByRole('button', { name: '시점 편집', exact: true }).click();
      await definitions.getByLabel('선택지 0', { exact: true }).fill('주인공 시점');
      await editorFits(page, editor, save, 1200);
      await page.screenshot({
        path: info.outputPath(`native-toggle-editor-${viewport.name}.png`),
      });

      // Both valid raw documents survive tab switches and are included in the ordinary save.
      await rawView.click();
      raw = definitions.getByLabel('토글 정의 원문', { exact: true });
      const editedSource = await raw.inputValue();
      const withPendingSource = `${editedSource}\nsecond unknown line`;
      await raw.fill(withPendingSource);
      await expect(save).toBeEnabled();
      await editor.getByRole('tab', { name: '구성', exact: true }).click();
      await editor.getByRole('tab', { name: '변수·토글', exact: true }).click();
      await rawView.click();
      raw = definitions.getByLabel('토글 정의 원문', { exact: true });
      await expect(raw).toHaveValue(withPendingSource);
      await definitions.getByRole('button', { name: '기본 변수', exact: true }).click();
      const rawDefaults = definitions.getByLabel('Risu 기본 변수', { exact: true });
      const withPendingDefaults = `${guiDefaultVariables}\nleadingZero=0007`;
      await rawDefaults.fill(withPendingDefaults);
      await expect(save).toBeEnabled();
      await definitions.getByRole('button', { name: '토글 구성', exact: true }).click();
      raw = definitions.getByLabel('토글 정의 원문', { exact: true });
      await expect(raw).toHaveValue(withPendingSource);
      const responsePromise = nextSave(page);
      await save.click();
      const response = await responsePromise;
      expect(response.ok(), await response.text()).toBe(true);
      const saved = (await response.json()).saved as PromptPreset;
      expect(saved.values).toEqual({ short: '서울', long: '첫 줄\n둘째 줄', flag: '1', mode: '0' });
      expect(saved.program.nativeRisuPreset.preset.templateDefaultVariables).toBe(
        withPendingDefaults
      );
      expect(saved.program.nativeRisuPreset.preset.customPromptTemplateToggle).toBe(
        withPendingSource
      );
    });

    test('bot edits survive tabs and save into a current CHARX download', async ({
      page,
      request,
    }, info) => {
      const title = `UIREC bot ${randomUUID().slice(0, 8)}`;
      const description = 'Synthetic {{char}} in a quiet forest.';
      const globalNote = 'Keep {{original}} and the authored global note.';
      const example = '{{user}}: Example\n{{char}}: Reply';
      const pkg = nativeContent({
        name: title,
        description,
        creator_notes: 'Synthetic creator notes must survive.',
        extensions: {
          risuai: {
            customScripts: [
              {
                comment: 'Greeting display',
                in: 'greet',
                out: 'original',
                find: 'greet',
                replace: 'original',
                type: 'editdisplay',
                untouched: 'keep',
              },
            ],
            triggerscript: [
              {
                comment: 'Arrival trigger',
                type: 'start',
                conditions: [{ type: 'exists', value: 'place', untouched: 'condition' }],
                effect: [{ type: 'triggerlua', code: 'return "original"', untouched: 'effect' }],
                untouched: 'trigger',
              },
            ],
          },
        },
        first_mes: 'Original opening {{user}}',
        alternate_greetings: ['Unchanged alternate opening'],
        post_history_instructions: globalNote,
        mes_example: example,
        unknown_active: { preserved: true },
      });
      // Submit obsolete fields too: the end-to-end save/export path must exclude them.
      Object.assign(pkg.nativeRisu.card, {
        personality: 'Obsolete personality',
        scenario: 'Obsolete scenario',
        system_prompt: 'Obsolete system prompt',
      });
      const bot = await post<Content>(request, '/api/content', {
        kind: 'bot',
        title,
        description: pkg.description,
        text: description,
        loading: 'pinned',
        relatedIds: [],
        package: pkg,
      });
      await page.addInitScript(() => localStorage.setItem('uimori:theme', 'dark'));
      await page.goto('/');
      await navigationAction(page, '봇');
      await page.getByLabel('서재 검색', { exact: true }).fill(title);
      await editLibraryContent(page, title);
      const editor = page.getByRole('region', { name: '자료 상세', exact: true });
      const save = editor.getByRole('button', { name: '변경사항 저장', exact: true });
      const editedName = title + ' 편집됨';
      const opening = '<b>{{char}}</b> greets {{user}}.\n{{getvar::place}}';
      await editor.getByLabel('Risu 자료 이름', { exact: true }).fill(editedName);
      await openMenu(editor, '자료 메뉴');
      await expect(
        editor.getByRole('button', { name: 'CHARX 내보내기', exact: true })
      ).toBeDisabled();
      await page.keyboard.press('Escape');
      await editorFits(page, editor, save);
      await page.screenshot({ path: info.outputPath(`bot-basic-${viewport.name}.png`) });

      await editor.getByRole('tab', { name: '첫 메시지', exact: true }).click();
      await editor.getByLabel('기본 시작문', { exact: true }).fill(opening);
      await editor.getByRole('tab', { name: '기본 정보', exact: true }).click();
      await expect(editor.getByLabel('Risu 자료 이름', { exact: true })).toHaveValue(editedName);
      await editor.getByRole('tab', { name: '첫 메시지', exact: true }).click();
      await expect(editor.getByLabel('기본 시작문', { exact: true })).toHaveValue(opening);
      await editorFits(page, editor, save);
      await page.screenshot({ path: info.outputPath(`bot-opening-${viewport.name}.png`) });

      await editor.getByRole('tab', { name: '고급 설정', exact: true }).click();
      const advancedNav = editor.getByRole('group', { name: '고급 설정 영역', exact: true });
      await expect(advancedNav.getByRole('button')).toHaveCount(6);
      for (const label of ['지침', '기본 변수·토글', '표시', '스크립트', '연결 모듈', '원문'])
        await expect(advancedNav.getByRole('button', { name: label, exact: true })).toBeVisible();

      await advancedNav.getByRole('button', { name: '표시', exact: true }).click();
      await advancedWorkspaceFits(page, editor);
      await page.screenshot({ path: info.outputPath(`bot-advanced-display-${viewport.name}.png`) });

      await advancedNav.getByRole('button', { name: '연결 모듈', exact: true }).click();
      await advancedWorkspaceFits(page, editor);
      const moduleEditor = editor.getByLabel('패키지 모듈과 기능 편집', { exact: true });
      const modulePicker = moduleEditor.getByRole('button', {
        name: '연결할 공통 모듈',
        exact: true,
      });
      const moduleConnect = moduleEditor.getByRole('button', { name: '모듈 연결', exact: true });
      await expect(modulePicker).toBeEnabled();
      await expect(moduleConnect).toBeDisabled();
      await expect(
        moduleEditor.getByRole('button', { name: '목록 새로고침', exact: true })
      ).toBeVisible();
      const [pickerBounds, connectBounds] = await Promise.all([
        modulePicker.boundingBox(),
        moduleConnect.boundingBox(),
      ]);
      if (viewport.width >= 1200) {
        expect(
          Math.abs(
            pickerBounds!.y + pickerBounds!.height - connectBounds!.y - connectBounds!.height
          )
        ).toBeLessThanOrEqual(1);
        expect(connectBounds!.x).toBeGreaterThan(pickerBounds!.x + pickerBounds!.width);
      } else {
        expect(connectBounds!.y).toBeGreaterThanOrEqual(pickerBounds!.y + pickerBounds!.height);
        expect(Math.abs(connectBounds!.width - pickerBounds!.width)).toBeLessThanOrEqual(1);
      }
      await page.screenshot({ path: info.outputPath(`bot-advanced-modules-${viewport.name}.png`) });

      const moduleDialogErrors: string[] = [];
      const recordConsoleError = (message: { type(): string; text(): string }) => {
        if (message.type() === 'error') moduleDialogErrors.push(message.text());
      };
      const recordPageError = (error: Error) => moduleDialogErrors.push(error.message);
      page.on('console', recordConsoleError);
      page.on('pageerror', recordPageError);
      await modulePicker.click();
      const moduleDialog = page.getByRole('dialog', { name: '연결할 공통 모듈', exact: true });
      await expect(moduleDialog).toBeVisible();
      await expect(moduleDialog.getByText('검색', { exact: true })).toBeVisible();
      await expect(moduleDialog.getByLabel('연결할 공통 모듈 검색', { exact: true })).toBeVisible();
      await expect(moduleDialog.getByLabel('연결할 공통 모듈 폴더', { exact: true })).toBeVisible();
      expect(
        await moduleDialog.evaluate((node) => node.scrollWidth - node.clientWidth)
      ).toBeLessThanOrEqual(1);
      const dialogBounds = await moduleDialog.boundingBox();
      expect(dialogBounds!.x).toBeGreaterThanOrEqual(0);
      expect(dialogBounds!.y).toBeGreaterThanOrEqual(0);
      expect(dialogBounds!.x + dialogBounds!.width).toBeLessThanOrEqual(viewport.width + 1);
      expect(dialogBounds!.y + dialogBounds!.height).toBeLessThanOrEqual(viewport.height + 1);
      await page.screenshot({
        path: info.outputPath(`bot-advanced-module-picker-${viewport.name}.png`),
      });
      await page.keyboard.press('Escape');
      await expect(moduleDialog).toBeHidden();
      await expect(modulePicker).toBeFocused();
      page.off('console', recordConsoleError);
      page.off('pageerror', recordPageError);
      expect(moduleDialogErrors).toEqual([]);

      await advancedNav.getByRole('button', { name: '스크립트', exact: true }).click();
      await advancedWorkspaceFits(page, editor);
      await page.screenshot({ path: info.outputPath(`bot-advanced-scripts-${viewport.name}.png`) });
      await editor.getByLabel('트리거 이름', { exact: true }).fill('Edited arrival trigger');
      await editor.getByLabel('Lua 원문', { exact: true }).fill('return "edited"');
      await editor.getByText('실행 조건과 순서 · 원문 편집', { exact: true }).click();
      const triggerRaw = editor.getByLabel('트리거 원문 JSON', { exact: true });
      const pendingTriggerRaw = '{"unfinished":';
      await triggerRaw.fill(pendingTriggerRaw);
      await save.click();
      await expect(page.getByRole('alert').filter({ hasText: /JSON/ }).first()).toBeVisible();
      expect((await (await request.get(`/api/content/${bot.id}`)).json()).revision).toBe(
        bot.revision
      );
      await advancedNav.getByRole('button', { name: '표시', exact: true }).click();
      await advancedWorkspaceFits(page, editor);
      await advancedNav.getByRole('button', { name: '스크립트', exact: true }).click();
      await expect(triggerRaw).toHaveValue(pendingTriggerRaw);
      await editor.getByRole('button', { name: '입력 되돌리기', exact: true }).click();
      await editor.getByText('정규식 스크립트', { exact: true }).click();
      const currentRegex = editor.getByLabel('현재 정규식', { exact: true });
      if (viewport.name === 'desktop') {
        await expect(currentRegex).toBeVisible();
        await expect(currentRegex).toHaveJSProperty('tagName', 'SELECT');
      }
      await editor.getByLabel('정규식 바꿀 내용', { exact: true }).fill('Edited display {{char}}');
      await advancedWorkspaceFits(page, editor);
      await page.screenshot({ path: info.outputPath(`bot-advanced-regex-${viewport.name}.png`) });

      // An unapplied source document remains byte-for-byte intact while visiting other advanced panes.
      await advancedNav.getByRole('button', { name: '원문', exact: true }).click();
      const raw = editor.getByLabel('Risu 원문 JSON', { exact: true });
      const pendingRaw = '{"unfinished":';
      await raw.fill(pendingRaw);
      await save.click();
      await expect(page.getByRole('alert').first()).toBeVisible();
      expect((await (await request.get(`/api/content/${bot.id}`)).json()).revision).toBe(
        bot.revision
      );
      await advancedNav.getByRole('button', { name: '표시', exact: true }).click();
      await advancedWorkspaceFits(page, editor);
      await advancedNav.getByRole('button', { name: '원문', exact: true }).click();
      await expect(raw).toHaveValue(pendingRaw);
      await editor.getByRole('button', { name: '입력 되돌리기', exact: true }).click();
      await editor.getByRole('tab', { name: '첫 메시지', exact: true }).click();

      const responsePromise = nextSave(page);
      await save.click();
      const response = await responsePromise;
      expect(response.ok(), await response.text()).toBe(true);
      const saved = (await response.json()).saved as Content;
      expect(saved.id).toBe(bot.id);
      expect(saved.revision).toBe(bot.revision + 1);
      expect(saved.package.nativeRisu.card).toMatchObject({ name: editedName, first_mes: opening });
      await expect(editor.locator('.resource-editor-status').getByRole('status')).toHaveText(
        '저장됨'
      );
      await editorFits(page, editor, save);
      await page.screenshot({ path: info.outputPath(`bot-saved-${viewport.name}.png`) });

      await openMenu(editor, '자료 메뉴');
      const exportButton = editor.getByRole('button', { name: 'CHARX 내보내기', exact: true });
      await expect(exportButton).toBeEnabled();
      const downloadPromise = page.waitForEvent('download');
      await exportButton.click();
      const download = await downloadPromise;
      expect(download.suggestedFilename()).toMatch(/\.charx$/i);
      const downloadedPath = await download.path();
      expect(downloadedPath).not.toBeNull();
      const read = readCharacterCard({
        name: download.suggestedFilename(),
        base64: (await readFile(downloadedPath!)).toString('base64'),
      });
      expect(read.nativeCard).toMatchObject({
        name: editedName,
        first_mes: opening,
        description,
        alternate_greetings: ['Unchanged alternate opening'],
        post_history_instructions: globalNote,
        mes_example: example,
        creator_notes: 'Synthetic creator notes must survive.',
        unknown_active: { preserved: true },
        extensions: {
          risuai: {
            customScripts: [
              {
                in: 'greet',
                out: 'Edited display {{char}}',
                find: 'greet',
                replace: 'Edited display {{char}}',
                type: 'editdisplay',
                untouched: 'keep',
              },
            ],
            triggerscript: [
              {
                comment: 'Edited arrival trigger',
                type: 'start',
                conditions: [{ type: 'exists', value: 'place', untouched: 'condition' }],
                effect: [{ type: 'triggerlua', code: 'return "edited"', untouched: 'effect' }],
                untouched: 'trigger',
              },
            ],
          },
        },
      });
      for (const key of ['personality', 'scenario', 'system_prompt'])
        expect(read.nativeCard).not.toHaveProperty(key);
    });

    test('preset body survives tabs and save into a current RISUP download', async ({
      page,
      request,
    }, info) => {
      const title = `UIREC preset ${randomUUID().slice(0, 8)}`;
      const toggle = 'mood=분위기=select=Calm,Vivid';
      const program = nativePrompt('Original {{char}} instructions.', {
        name: title,
        customPromptTemplateToggle: toggle,
        templateDefaultVariables: 'place=forest',
        regex: [{ in: 'hello', out: 'Hello {{user}}', type: 'editoutput' }],
        mainPrompt: 'Obsolete main prompt',
        jailbreak: 'Obsolete jailbreak',
        globalNote: 'Obsolete global note',
      });
      const preset = await post<PromptPreset>(request, '/api/prompt-presets', {
        title,
        role: 'main',
        program,
        values: { mood: '1' },
      });
      await page.goto('/');
      await navigationAction(page, '프롬프트');
      await page.getByLabel('프롬프트 검색', { exact: true }).fill(title);
      await page.getByRole('button', { name: `${title} 프롬프트 편집`, exact: true }).click();
      const editor = page.getByTestId('prompt-editor');
      const save = editor.getByRole('button', { name: '프리셋 저장', exact: true });
      const body = '{{#when::mood::tis::1}}Vivid {{char}}{{/when}}\nEdited {{getvar::place}}.';
      await editor.getByLabel('1번 프롬프트 본문', { exact: true }).fill(body);
      await openMenu(editor, '프롬프트 관리');
      await expect(
        editor.getByRole('button', { name: 'RISUP 내보내기', exact: true })
      ).toBeDisabled();
      await page.keyboard.press('Escape');
      await editor.getByRole('tab', { name: '기본 옵션', exact: true }).click();
      await expect(editor.getByLabel('분위기', { exact: true })).toHaveValue('"1"');
      await editor.getByRole('tab', { name: '구성', exact: true }).click();
      await expect(editor.getByLabel('1번 프롬프트 본문', { exact: true })).toHaveValue(body);
      await editorFits(page, editor, save);
      await page.screenshot({ path: info.outputPath(`preset-body-${viewport.name}.png`) });

      await editor.getByRole('tab', { name: '정규식', exact: true }).click();
      await editor.getByLabel('정규식 바꿀 내용', { exact: true }).fill('Edited regex {{user}}');
      await page.screenshot({ path: info.outputPath(`preset-regex-${viewport.name}.png`) });
      await editor.getByRole('tab', { name: '구성', exact: true }).click();

      const responsePromise = nextSave(page);
      await save.click();
      const response = await responsePromise;
      expect(response.ok(), await response.text()).toBe(true);
      const saved = (await response.json()).saved as PromptPreset;
      expect(saved.id).toBe(preset.id);
      expect(saved.revision).toBe(preset.revision + 1);
      expect(
        (saved.program.nativeRisuPreset.preset.promptTemplate as Record<string, unknown>[])[0]
      ).toMatchObject({ text: body });
      await expect(
        editor.getByRole('status').filter({ hasText: '프롬프트를 저장했어요.' })
      ).toBeVisible();
      await expect(save).toBeDisabled();
      await editorFits(page, editor, save);
      await page.screenshot({ path: info.outputPath(`preset-saved-${viewport.name}.png`) });

      await openMenu(editor, '프롬프트 관리');
      const exportButton = editor.getByRole('button', { name: 'RISUP 내보내기', exact: true });
      await expect(exportButton).toBeEnabled();
      const downloadPromise = page.waitForEvent('download');
      await exportButton.click();
      const download = await downloadPromise;
      expect(download.suggestedFilename()).toMatch(/\.risup$/i);
      const downloadedPath = await download.path();
      expect(downloadedPath).not.toBeNull();
      const read = readRisuPresetFile({
        name: download.suggestedFilename(),
        base64: (await readFile(downloadedPath!)).toString('base64'),
      });
      expect(read.format).toBe('risu-preset-binary');
      expect(read.preset.name).toBe(title);
      expect(read.preset.promptTemplate).toEqual(
        saved.program.nativeRisuPreset.preset.promptTemplate
      );
      expect(read.preset).toMatchObject({
        customPromptTemplateToggle: toggle,
        templateDefaultVariables: 'place=forest',
        regex: [{ in: 'hello', out: 'Edited regex {{user}}', type: 'editoutput' }],
      });
      for (const key of ['mainPrompt', 'jailbreak', 'globalNote'])
        expect(read.preset).not.toHaveProperty(key);
    });
  });
}
