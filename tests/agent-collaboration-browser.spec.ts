import {
  DESKTOP_HEIGHT,
  DESKTOP_WIDTH,
  MOBILE_HEIGHT,
  MOBILE_WIDTH,
} from './fixtures/browser-viewports.js';
import { setCurrentModels } from './ui-navigation.js';
import { visualReview } from './fixtures/visual-review.js';
import { preservePromptWorkspace } from './fixtures/prompt-workspace.js';
import { test, expect } from '@playwright/test';
import { createDefaultRisuPrompt } from '../core/prompt-defaults.js';
import type { PromptPreset } from '../core/product.js';
import { navigationAction } from './ui-navigation.js';
import { postFixtureChat } from './fixtures/chat.js';

test('AGENTUI02 saved collaboration options reach the real preview API and translation stays separate on desktop', async ({
  page,
  request,
}, info) => {
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: DESKTOP_HEIGHT });
  const program = createDefaultRisuPrompt('Synthetic main instructions.');
  program.nativeRisuPreset.preset.customPromptTemplateToggle =
    'scene=장면 설정=group\nperspective=합성 시점=text\n==그룹 끝=groupEnd';
  const created = await request.post('/api/prompt-presets', {
    data: { title: `협업 옵션 ${crypto.randomUUID()}`, role: 'main', program },
  });
  expect(created.ok()).toBe(true);
  const preset = (await created.json()) as PromptPreset;
  await page.goto('/');
  await navigationAction(page, '프롬프트');
  await page.getByRole('button', { name: `${preset.title} 프롬프트 편집`, exact: true }).click();
  const editor = page.getByTestId('prompt-editor');
  await editor.getByRole('tab', { name: '협업', exact: true }).click();
  const collaboration = editor.getByRole('region', { name: '에이전트 협업' });
  await collaboration.scrollIntoViewIfNeeded();
  await collaboration.getByRole('switch', { name: '협업 사용' }).check();
  await collaboration.getByRole('button', { name: '에이전트 추가', exact: true }).click();
  await collaboration
    .getByRole('button', { name: '설정과 기억 에이전트 추가', exact: true })
    .click();
  const agent = collaboration.locator('.ac-agent').first();
  await expect(agent).toHaveAttribute('open', '');
  await agent.locator('summary').click();
  await expect(agent).not.toHaveAttribute('open', '');
  await collaboration.getByRole('button', { name: '선택 변경', exact: true }).click();
  const options = page.getByRole('dialog', { name: '전달할 창작 옵션' });
  await expect(options.getByRole('button', { name: /장면 설정/ })).toBeVisible();
  await options.getByRole('button', { name: /모든 옵션/ }).click();
  await options.getByLabel('옵션 이름으로 찾기').fill('합성');
  await options.getByLabel('합성 시점', { exact: true }).check();
  await expect(options).toContainText('1 / 64개 선택');
  if (visualReview) {
    await page.screenshot({ path: info.outputPath('shared-options-2560x1440.png') });
    await page.setViewportSize({ width: MOBILE_WIDTH, height: MOBILE_HEIGHT });
    await page.screenshot({ path: info.outputPath('shared-options-412x915.png') });
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: DESKTOP_HEIGHT });
  }
  await options.getByRole('button', { name: '전달할 창작 옵션 닫기' }).click();
  await expect(
    collaboration.locator('.ac-shared-tags').getByText('합성 시점', { exact: true })
  ).toBeVisible();
  await collaboration.locator('.ac-limits > summary').click();
  await collaboration.getByLabel('전체 추가 호출 한도', { exact: true }).fill('4');
  const updated = page.waitForResponse(
    (item) => /\/api\/resources\/save$/.test(item.url()) && item.request().method() === 'POST'
  );
  await editor.getByRole('button', { name: '프리셋 저장', exact: true }).click();
  const saved = (await (await updated).json()).saved as PromptPreset;
  expect(saved.program.collaboration).toMatchObject({
    maxCalls: 4,
    sharedControls: ['perspective'],
  });
  const connectionResponse = await request.post('/api/connections', {
    data: {
      title: 'No-call preview fixture',
      protocol: 'fixture-sse-v1',
      endpoint: 'http://127.0.0.1:9/turn',
      enabled: true,
    },
  });
  expect(connectionResponse.ok()).toBe(true);
  const connection = await connectionResponse.json();
  const modelResponse = await request.post('/api/model-presets', {
    data: {
      title: 'Preview model',
      connectionId: connection.id,
      modelId: 'deterministic-fixture',
      maxOutputTokens: 1024,
      temperature: null,
    },
  });
  expect(modelResponse.ok()).toBe(true);
  const model = await modelResponse.json();
  const chat = await (
    await postFixtureChat(request, { data: { title: '협업 미리보기 합성 채팅' } })
  ).json();
  await setCurrentModels(request, { main: { id: model.id } });
  const workspace = await (await request.get('/api/prompt-workspace')).json();
  expect(
    (
      await request.put('/api/prompt-workspace', {
        data: {
          expectedRevision: workspace.revision,
          main: { title: saved.title, program: saved.program, values: { perspective: '먼 시점' } },
        },
      })
    ).ok()
  ).toBe(true);
  const preview = await request.post(`/api/chats/${chat.id}/prompt-preview`, {
    data: { request: '합성 장면을 이어 줘.' },
  });
  expect(preview.ok(), await preview.text()).toBe(true);
  const plan = JSON.stringify(await preview.json());
  expect(plan).toContain('agents.consult');
  expect(plan).toContain('먼 시점');
  const detail = await (await request.get(`/api/chats/${chat.id}`)).json();
  expect(detail.runs).toHaveLength(0);
  expect(detail.attempts).toHaveLength(0);
  await editor.getByRole('tab', { name: '협업', exact: true }).click();
  await collaboration.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true
  );
  if (visualReview)
    await page.screenshot({ path: info.outputPath('agent-collaboration-desktop.png') });
  await collaboration
    .getByRole('button', { name: '에이전트 협업', exact: true })
    .evaluate((element) => element.scrollIntoView({ block: 'start' }));
  if (visualReview)
    await page.screenshot({ path: info.outputPath('agent-collaboration-desktop-overview.png') });
  if (visualReview) {
    await page.setViewportSize({ width: MOBILE_WIDTH, height: MOBILE_HEIGHT });
    await page.screenshot({ path: info.outputPath('agent-collaboration-412x915.png') });
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: DESKTOP_HEIGHT });
  }
  // Saved presets keep their role. Check translation on a new draft through the normal UI.
  await editor.getByRole('tab', { name: '기본 옵션', exact: true }).click();
  await expect(editor.getByLabel('프롬프트 역할', { exact: true })).toBeDisabled();
  const library = page.getByTestId('prompt-library');
  await library.getByRole('button', { name: '프롬프트 목록', exact: true }).click();
  await library.getByRole('button', { name: '새 프롬프트', exact: true }).first().click();
  await editor.getByRole('tab', { name: '기본 옵션', exact: true }).click();
  await editor.getByLabel('프롬프트 역할', { exact: true }).selectOption('translation');
  await expect(editor.getByRole('tab', { name: '협업', exact: true })).toHaveCount(0);
});

preservePromptWorkspace();
