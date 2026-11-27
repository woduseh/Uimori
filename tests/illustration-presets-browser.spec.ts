import { readFile } from 'node:fs/promises';
import { test, expect, type APIRequestContext, type Page } from './fixtures/browser-test.js';
import type { Chat } from '../core/types.js';
import {
  DEFAULT_ILLUSTRATION_PRESET_ID,
  type IllustrationPresetCatalog,
} from '../core/illustration-presets.js';
import { postFixtureChat } from './fixtures/chat.js';
import { FIXTURE_WORKFLOW } from './fixtures/comfyui-server.js';
import { navigationAction, selectSettingsSection } from './ui-navigation.js';
import { DESKTOP_WIDTH } from './fixtures/browser-viewports.js';

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
}) => {
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
  await editor.getByLabel('프리셋 삽화 생성기', { exact: true }).selectOption('comfyui');
  await expect(editor.getByLabel('ComfyUI 워크플로 JSON', { exact: true })).toBeVisible();
  await editor
    .getByLabel('ComfyUI 네거티브 프롬프트 지침', { exact: true })
    .fill('text, watermark');
  await editor.getByLabel('ComfyUI 워크플로 JSON', { exact: true }).fill(FIXTURE_WORKFLOW);
  await editor.getByRole('button', { name: '프리셋 저장', exact: true }).click();
  await expect(editor.getByRole('button', { name: '프리셋 저장', exact: true })).toBeDisabled();
  const original = (await catalog(request)).presets.find((item) => item.title === title)!;
  expect(original).toBeTruthy();
  expect((await catalog(request)).preferences).toEqual(previous);
  await editor.getByRole('button', { name: '편집기 닫기', exact: true }).click();
  await section.getByLabel('삽화 프리셋 적용 범위').selectOption('bot');
  await section.getByRole('button', { name: `${title} 삽화 프리셋 적용`, exact: true }).click();
  await expect(
    section.getByRole('button', { name: `${title} 삽화 프리셋 적용`, exact: true })
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('ComfyUI 주소', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Codex 삽화 모델', { exact: true })).toBeHidden();
  expect((await catalog(request)).preferences.botPresets[chat.botId!]).toBe(original.id);
  await section.getByLabel('삽화 프리셋 적용 범위').selectOption('chat');
  await section.getByRole('button', { name: '기본 삽화 프리셋 적용', exact: true }).click();
  expect((await catalog(request)).preferences.chatPresets[chat.id]).toBe(
    DEFAULT_ILLUSTRATION_PRESET_ID
  );
  await section.getByRole('button', { name: '상위 설정 따르기', exact: true }).click();
  await expect(section.locator('.illustration-preset-effective')).toContainText(title);
  expect((await catalog(request)).preferences.chatPresets[chat.id]).toBeUndefined();

  await section
    .locator('summary')
    .filter({ hasText: `${title} 프리셋 메뉴` })
    .click();
  await section.getByRole('button', { name: `${title} 삽화 프리셋 복제`, exact: true }).click();
  await expect(editor.getByLabel('삽화 그림 지침')).toHaveValue(original.styleGuidance);
  await editor.getByRole('button', { name: '프리셋 저장', exact: true }).click();
  await expect(editor.getByRole('button', { name: '프리셋 저장', exact: true })).toBeDisabled();
  await editor.getByRole('button', { name: '편집기 닫기', exact: true }).click();
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
  expect(file.version).toBe(2);
  expect(file.preset.generator).toBe('comfyui');
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
  await editor.getByRole('button', { name: '편집기 닫기', exact: true }).click();
  await section
    .locator('summary')
    .filter({ hasText: `${title} 프리셋 메뉴` })
    .click();
  await section.getByRole('button', { name: `${title} 삽화 프리셋 삭제`, exact: true }).click();
  const confirm = page.getByRole('alertdialog', { name: '삽화 프리셋 삭제', exact: true });
  await expect(confirm).toContainText(`‘${title}’ 프리셋을 삭제해요.`);
  await expect(confirm).toContainText('상위 설정을 따르고');
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
