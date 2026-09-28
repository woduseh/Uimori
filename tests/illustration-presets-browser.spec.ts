import { readFile } from 'node:fs/promises';
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import type { Chat } from '../core/types.js';
import {
  DEFAULT_ILLUSTRATION_PRESET_ID,
  emptyIllustrationPreset,
  type IllustrationPreset,
  type IllustrationPresetCatalog,
} from '../core/illustration-presets.js';
import { postFixtureChat } from './fixtures/chat.js';
import { FIXTURE_WORKFLOW } from './fixtures/comfyui-server.js';
import { navigationAction, selectSettingsSection } from './ui-navigation.js';
import { DESKTOP_WIDTH, MOBILE_WIDTH } from './fixtures/browser-viewports.js';

test.setTimeout(60000);
const catalog = async (request: APIRequestContext): Promise<IllustrationPresetCatalog> => {
  const response = await request.get('/api/illustration-presets');
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
};
async function open(page: Page, request: APIRequestContext) {
  const response = await postFixtureChat(request, { data: { title: '삽화 프리셋 검증' } });
  expect(response.ok()).toBe(true);
  const chat = (await response.json()) as Chat;
  await page.goto(`/?chat=${chat.id}`);
  await navigationAction(page, '설정');
  await selectSettingsSection(page, '삽화');
  const section = page.getByRole('region', { name: '삽화 프리셋', exact: true });
  await expect(section.getByRole('button', { name: '새 삽화 프리셋', exact: true })).toBeVisible();
  return {
    chat,
    section,
    editor: section.getByRole('region', { name: '삽화 프리셋 편집기', exact: true }),
  };
}

test('IPUI01 named recipes save, apply by scope, duplicate and round-trip through an exported file without changing runtime settings', async ({
  page,
  request,
}, info) => {
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: 1000 });
  const runtime = await (await request.get('/api/illustration-settings')).json();
  const { chat, section, editor } = await open(page, request);
  const title = `수채화 ${Date.now().toString(36).slice(-5)}`;
  const previous = (await catalog(request)).preferences;
  await section.getByRole('button', { name: '새 삽화 프리셋', exact: true }).click();
  await editor.getByLabel('삽화 프리셋 이름', { exact: true }).fill(title);
  await editor
    .getByLabel('삽화 프리셋 설명', { exact: true })
    .fill('부드러운 빛과 종이 질감으로 장면을 표현해요.');
  await editor
    .getByLabel('삽화 그림 지침', { exact: true })
    .fill('watercolor, soft light, textured paper');
  await editor
    .getByLabel('ComfyUI 네거티브 프롬프트 지침', { exact: true })
    .fill('text, watermark');
  await editor.getByLabel('ComfyUI 워크플로 JSON', { exact: true }).fill(FIXTURE_WORKFLOW);
  await editor.getByRole('button', { name: '프리셋 저장', exact: true }).click();
  await expect(editor.getByRole('button', { name: '프리셋 저장', exact: true })).toBeDisabled();
  const original = (await catalog(request)).presets.find((item) => item.title === title)!;
  expect(original).toBeTruthy();
  expect((await catalog(request)).preferences).toEqual(previous);
  await editor.getByRole('button', { name: '편집 닫기', exact: true }).click();
  await section.getByLabel('삽화 프리셋 적용 범위').selectOption('bot');
  await section.getByRole('button', { name: `${title} 삽화 프리셋 적용`, exact: true }).click();
  await expect(section.locator('.illustration-preset-current')).toContainText(title);
  expect((await catalog(request)).preferences.botPresets[chat.botId!]).toBe(original.id);
  await section.getByLabel('삽화 프리셋 적용 범위').selectOption('chat');
  await section.getByRole('button', { name: '기본 삽화 프리셋 적용', exact: true }).click();
  expect((await catalog(request)).preferences.chatPresets[chat.id]).toBe(
    DEFAULT_ILLUSTRATION_PRESET_ID
  );
  await section.getByRole('button', { name: '상위 설정 따르기', exact: true }).click();
  await expect(section.locator('.illustration-preset-current')).toContainText(title);
  expect((await catalog(request)).preferences.chatPresets[chat.id]).toBeUndefined();

  await section
    .locator('summary')
    .filter({ hasText: `${title} 프리셋 메뉴` })
    .click();
  await section.getByRole('button', { name: `${title} 삽화 프리셋 복제`, exact: true }).click();
  await expect(editor.getByLabel('삽화 그림 지침')).toHaveValue(original.styleGuidance);
  await editor.getByRole('button', { name: '프리셋 저장', exact: true }).click();
  await expect(editor.getByRole('button', { name: '프리셋 저장', exact: true })).toBeDisabled();
  await editor.getByRole('button', { name: '편집 닫기', exact: true }).click();
  const downloadPromise = page.waitForEvent('download');
  await section
    .locator('summary')
    .filter({ hasText: `${title} 프리셋 메뉴` })
    .click();
  await section.getByRole('button', { name: `${title} 삽화 프리셋 내보내기`, exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(`${title}.uimori-illustration.json`);
  const bytes = await readFile((await download.path())!);
  const file = JSON.parse(bytes.toString());
  expect(file.preset.comfyui.workflow).toBe(FIXTURE_WORKFLOW);
  expect(file.preset).not.toHaveProperty('id');
  expect(file.preset).not.toHaveProperty('codex');
  expect(file.preset.comfyui).not.toHaveProperty('baseUrl');
  const count = (await catalog(request)).presets.length;
  await section.getByLabel('삽화 프리셋 파일', { exact: true }).setInputFiles({
    name: download.suggestedFilename(),
    mimeType: 'application/json',
    buffer: bytes,
  });
  await expect(editor.getByLabel('삽화 그림 지침')).toHaveValue(original.styleGuidance);
  expect((await catalog(request)).presets).toHaveLength(count);
  await editor.getByLabel('삽화 프리셋 이름').fill(`${title} 가져옴`);
  await editor.getByRole('button', { name: '프리셋 저장', exact: true }).click();
  await expect(editor.getByRole('button', { name: '프리셋 저장', exact: true })).toBeDisabled();
  const imported = (await catalog(request)).presets.find(
    (item) => item.title === `${title} 가져옴`
  )!;
  expect(imported.id).not.toBe(original.id);
  await editor.getByRole('button', { name: '편집 닫기', exact: true }).click();
  for (const width of [DESKTOP_WIDTH, MOBILE_WIDTH]) {
    await page.setViewportSize({ width, height: 1000 });
    await section
      .getByRole('heading', { name: '삽화 프리셋', exact: true })
      .scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true
    );
    await page.screenshot({ path: info.outputPath(`illustration-presets-${width}.png`) });
  }
  await section
    .locator('summary')
    .filter({ hasText: `${title} 프리셋 메뉴` })
    .click();
  await section.getByRole('button', { name: `${title} 삽화 프리셋 삭제`, exact: true }).click();
  const confirm = page.getByRole('alertdialog', { name: '삽화 프리셋 삭제', exact: true });
  await expect(confirm).toContainText('기존 삽화는 유지');
  await confirm.getByRole('button', { name: '프리셋 삭제', exact: true }).click();
  await expect(confirm).toBeHidden();
  expect((await catalog(request)).preferences.botPresets[chat.botId!]).toBeUndefined();
  await page.reload();
  await navigationAction(page, '설정');
  await selectSettingsSection(page, '삽화');
  await expect(
    section.getByRole('button', { name: `${title} 가져옴 삽화 프리셋 적용`, exact: true })
  ).toBeVisible();
  expect(await (await request.get('/api/illustration-settings')).json()).toEqual(runtime);
  expect(await (await request.get(`/api/chats/${chat.id}/illustrations`)).json()).toEqual([]);
});

test('IPUI02 stale edits are not overwritten and can be saved as a new copy', async ({
  page,
  request,
}, info) => {
  const { section, editor } = await open(page, request);
  const title = `충돌 검증 ${Date.now().toString(36).slice(-5)}`;
  const response = await request.post('/api/resources/save', {
    data: {
      kind: 'illustration-preset',
      model: { ...emptyIllustrationPreset(title), styleGuidance: 'original' },
    },
  });
  const preset = (await response.json()).saved as IllustrationPreset;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await section.getByRole('button', { name: `${title} 삽화 프리셋 편집`, exact: true }).click();
  await editor.getByLabel('삽화 그림 지침').fill('unsaved local direction');
  const remote = await request.post('/api/resources/save', {
    data: {
      kind: 'illustration-preset',
      id: preset.id,
      expectedRevision: preset.revision,
      model: { ...preset, styleGuidance: 'saved in another window' },
    },
  });
  expect(remote.ok()).toBe(true);
  await editor.getByRole('button', { name: '프리셋 저장', exact: true }).click();
  await expect(editor.getByRole('alert')).toContainText('다른 곳');
  await expect(editor.getByLabel('삽화 그림 지침')).toHaveValue('unsaved local direction');
  expect(
    (await catalog(request)).presets.find((item) => item.id === preset.id)?.styleGuidance
  ).toBe('saved in another window');
  await page.screenshot({ path: info.outputPath('illustration-preset-conflict-mobile.png') });
  await editor.getByRole('button', { name: '사본으로 저장', exact: true }).click();
  await expect(editor.getByRole('button', { name: '프리셋 저장', exact: true })).toBeDisabled();
  const copy = (await catalog(request)).presets.find((item) => item.title === `${title} 사본`)!;
  expect(copy.id).not.toBe(preset.id);
  expect(copy.styleGuidance).toBe('unsaved local direction');
});

test('IPUI03 invalid recipes never save and the close guard preserves failed drafts before saving both sections', async ({
  page,
  request,
}) => {
  const { section, editor } = await open(page, request);
  const count = (await catalog(request)).presets.length;
  await section.getByLabel('삽화 프리셋 파일').setInputFiles({
    name: 'invalid.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{"format":"uimori-theme","version":1}'),
  });
  await expect(section.getByRole('alert')).toContainText('삽화 프리셋 v1');
  expect((await catalog(request)).presets).toHaveLength(count);
  await section.getByRole('button', { name: '새 삽화 프리셋', exact: true }).click();
  const title = `저장 검증 ${Date.now().toString(36).slice(-5)}`;
  await editor.getByLabel('삽화 프리셋 이름').fill(title);
  await editor.getByLabel('ComfyUI 워크플로 JSON').fill('{"nodes":[]}');
  await editor.getByRole('button', { name: '프리셋 저장', exact: true }).click();
  await expect(section.getByRole('alert')).toBeVisible();
  expect((await catalog(request)).presets).toHaveLength(count);
  await editor.getByLabel('ComfyUI 워크플로 JSON').fill('');
  await editor.getByLabel('삽화 그림 지침').fill('preserved user direction');
  await editor.getByRole('button', { name: '편집 닫기', exact: true }).click();
  const discard = page.getByRole('alertdialog', { name: '프리셋 편집 닫기', exact: true });
  await expect(discard.getByRole('button', { name: '계속 편집', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(editor.getByLabel('삽화 그림 지침')).toHaveValue('preserved user direction');
  const runtime = await (await request.get('/api/illustration-settings')).json();
  const nextCount = runtime.maxPerSource === 8 ? 7 : runtime.maxPerSource + 1;
  const settings = page.getByRole('dialog', { name: '설정', exact: true });
  await settings.getByLabel('장면당 최대 삽화 개수').fill(String(nextCount));
  await page.route('**/api/resources/save', (route) =>
    route.fulfill({ status: 503, json: { error: 'Synthetic save failure' } })
  );
  await settings.getByRole('button', { name: '설정 닫기', exact: true }).click();
  const guard = page.getByRole('alertdialog', { name: '미저장 설정 확인', exact: true });
  await guard.getByRole('button', { name: '저장하고 닫기', exact: true }).click();
  await expect(guard.getByRole('alert')).toBeVisible();
  expect((await catalog(request)).presets).toHaveLength(count);
  expect(await (await request.get('/api/illustration-settings')).json()).toEqual(runtime);
  await page.unroute('**/api/resources/save');
  await guard.getByRole('button', { name: '계속 편집', exact: true }).click();
  await expect(editor.getByLabel('삽화 그림 지침')).toHaveValue('preserved user direction');
  await settings.getByRole('button', { name: '설정 닫기', exact: true }).click();
  await guard.getByRole('button', { name: '저장하고 닫기', exact: true }).click();
  await expect(settings).toBeHidden();
  expect((await catalog(request)).presets.find((item) => item.title === title)?.styleGuidance).toBe(
    'preserved user direction'
  );
  const updated = await (await request.get('/api/illustration-settings')).json();
  expect(updated.maxPerSource).toBe(nextCount);
  expect(updated.revision).toBe(runtime.revision + 1);
});
