import { expect, test } from '@playwright/test';
import { createDefaultPromptProgram } from '../core/prompt-defaults.js';
import type { RisuPresetImportApply } from '../core/risu-preset.js';
import { navigationAction, selectPromptSection } from './ui-navigation.js';
import { postFixtureChat } from './fixtures/chat.js';
import type { ChatDetail } from '../core/types.js';

test('RISUPRESETUI01 preserves a reviewed file and exact uncertain submission through dialog close', async ({
  page,
  request,
}) => {
  // The response fault is synthetic; conversion semantics are covered separately.
  const title = `RISUPRESETUI01 ${Date.now()}`;
  const response = await request.post('/api/prompt-presets', {
    data: {
      title,
      role: 'main',
      program: createDefaultPromptProgram('Synthetic preset', 'main'),
      values: {},
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const preset = await response.json();
  let prepares = 0;
  const submissions: RisuPresetImportApply[] = [];
  await page.route('**/api/risu-preset-imports/prepare', async (route) => {
    prepares++;
    await route.fulfill({
      json: {
        title,
        digest: 'synthetic-preview-digest',
        format: 'risu-preset-json',
        summary: { blocks: 1, controls: 1, regex: 0 },
        findings: [
          { code: 'synthetic-unsupported', level: 'unsupported', message: '합성 미지원 항목' },
        ],
      },
    });
  });
  await page.route('**/api/risu-preset-imports/apply', async (route) => {
    submissions.push(route.request().postDataJSON() as RisuPresetImportApply);
    if (submissions.length === 1) {
      await route.fulfill({ status: 503, json: { error: '합성 응답 유실' } });
      return;
    }
    await route.fulfill({ json: { receipt: {}, preset } });
  });
  await page.goto('/');
  await navigationAction(page, '프롬프트');
  const trigger = page.getByRole('button', { name: 'Risu 프리셋 가져오기', exact: true });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Risu 프리셋 가져오기', exact: true });
  await dialog.getByLabel('Risu 프리셋 파일 선택', { exact: true }).setInputFiles({
    name: 'synthetic.risupreset',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ name: title })),
  });
  await expect(dialog.getByRole('heading', { name: title })).toBeVisible();
  const save = dialog.getByRole('button', { name: '작문 프롬프트로 저장', exact: true });
  await expect(save).toBeDisabled();
  expect(submissions).toHaveLength(0);
  await dialog.getByRole('button', { name: 'Risu 프리셋 가져오기 닫기', exact: true }).click();
  await trigger.click();
  await expect(dialog.getByRole('heading', { name: title })).toBeVisible();
  expect(prepares).toBe(1);
  await dialog.getByRole('checkbox').check();
  await save.click();
  await expect(dialog.getByRole('button', { name: '같은 요청으로 다시 확인' })).toBeVisible();
  await expect(dialog.getByLabel('Risu 프리셋 파일 선택', { exact: true })).toBeDisabled();
  await expect(dialog.getByRole('checkbox')).toBeDisabled();
  await dialog.getByRole('button', { name: 'Risu 프리셋 가져오기 닫기', exact: true }).click();
  await trigger.click();
  await dialog.getByRole('button', { name: '같은 요청으로 다시 확인' }).click();
  await expect(dialog.getByText('새 작문 프롬프트로 저장했어요.', { exact: true })).toBeVisible();
  expect(submissions).toHaveLength(2);
  expect(submissions[1]).toEqual(submissions[0]);
  expect(submissions[0]?.allowPartial).toBe(true);
  expect(submissions[0]?.idempotencyKey).toBeTruthy();
  await dialog.getByRole('button', { name: '가져온 프롬프트 편집', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByTestId('prompt-library').getByRole('heading', { name: title })
  ).toBeVisible();
  await expect(trigger).toHaveCount(0);
});

test('RISUPRESETUI02 imports a real preset document into the existing prompt editor', async ({
  page,
  request,
}) => {
  const title = `RISUPRESETUI02 ${Date.now()}`;
  const source = {
    name: title,
    customPromptTemplateToggle: 'mood=Imported Mood=select=Calm,Vivid',
    templateDefaultVariables: 'location=DECLARED_LOCATION',
    promptTemplate: [
      {
        type: 'plain',
        role: 'system',
        type2: 'normal',
        text: '{{#when::mood::tis::1}}VIVID{{:else}}CALM{{/when}} {{getvar::location}}',
      },
      { type: 'chat', rangeStart: 0, rangeEnd: 'end' },
    ],
    aiModel: 'not-imported',
    temperature: 7,
    modelTools: { externalTool: true },
  };
  const before = await (await request.get('/api/model-workspace')).json();
  await page.goto('/');
  await navigationAction(page, '프롬프트');
  await page.getByRole('button', { name: 'Risu 프리셋 가져오기', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Risu 프리셋 가져오기', exact: true });
  await dialog.getByLabel('Risu 프리셋 파일 선택', { exact: true }).setInputFiles({
    name: 'synthetic.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(source)),
  });
  await expect(dialog.getByRole('heading', { name: title })).toBeVisible();
  await expect(dialog.getByRole('checkbox')).toHaveCount(0);
  const savedResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/risu-preset-imports/apply') &&
      response.request().method() === 'POST'
  );
  await dialog.getByRole('button', { name: '작문 프롬프트로 저장', exact: true }).click();
  const saved = await savedResponse;
  expect(saved.ok(), await saved.text()).toBe(true);
  expect((await saved.json()).preset.program.controls[0]).toMatchObject({
    id: 'mood',
    default: null,
  });
  await dialog.getByRole('button', { name: '가져온 프롬프트 편집', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByLabel('프롬프트 이름', { exact: true })).toHaveValue(title);
  await selectPromptSection(
    page.getByRole('region', { name: '프롬프트 구성', exact: true }),
    '기본 옵션'
  );
  await expect(page.getByLabel('Imported Mood', { exact: true })).toHaveValue('null');
  await page.getByLabel('Imported Mood', { exact: true }).selectOption('"1"');
  await expect(page.getByLabel('Imported Mood', { exact: true })).toHaveValue('"1"');
  const composer = page.getByRole('region', { name: '프롬프트 구성', exact: true });
  await selectPromptSection(composer, '미리보기');
  await composer.getByRole('button', { name: '미리보기 갱신', exact: true }).click();
  await expect(composer.locator('.pc-message-list')).toContainText('VIVID DECLARED_LOCATION');
  await selectPromptSection(
    page.getByRole('region', { name: '프롬프트 구성', exact: true }),
    '텍스트 변환'
  );
  await page.getByRole('button', { name: '변환 추가', exact: true }).click();
  const rule = page.getByRole('group', { name: '텍스트 변환 1', exact: true });
  await rule.getByLabel('변환 이름', { exact: true }).fill('요청 치환');
  await rule.getByLabel('변환 적용 단계', { exact: true }).selectOption('input');
  await rule.getByLabel('변환 대상', { exact: true }).selectOption('user');
  await rule.getByLabel('변환 정규식 패턴', { exact: true }).fill('원래');
  await rule.getByLabel('변환 치환문', { exact: true }).fill('전송');
  await rule.getByRole('checkbox', { name: '사용', exact: true }).check();
  await page.getByRole('button', { name: '프리셋 저장', exact: true }).click();
  await expect(page.getByText('프롬프트를 저장했어요.', { exact: true })).toBeVisible();
  await navigationAction(page, '프롬프트');
  await page.getByRole('button', { name: `${title} 프롬프트 편집`, exact: true }).click();
  await selectPromptSection(
    page.getByRole('region', { name: '프롬프트 구성', exact: true }),
    '텍스트 변환'
  );
  await expect(rule.getByLabel('변환 정규식 패턴', { exact: true })).toHaveValue('원래');
  await expect(rule.getByLabel('변환 치환문', { exact: true })).toHaveValue('전송');
  await expect(rule.getByLabel('변환 적용 단계', { exact: true })).toHaveValue('input');
  await expect(rule.getByRole('checkbox', { name: '사용', exact: true })).toBeChecked();
  expect(await (await request.get('/api/model-workspace')).json()).toEqual(before);
});

test('RISUPRESETUI03 request projection keeps the original edit value and exposes transmission text', async ({
  page,
  request,
}) => {
  const response = await postFixtureChat(request, {
    data: { title: `RISUPRESETUI03 ${Date.now()}` },
  });
  expect(response.ok()).toBe(true);
  const chat = await response.json();
  const runResponse = await request.post(`/api/chats/${chat.id}/runs`, {
    data: {
      request: '원래 요청',
      expectedRevision: null,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: crypto.randomUUID(),
    },
  });
  expect(runResponse.ok()).toBe(true);
  const run = await runResponse.json();
  await expect
    .poll(async () => {
      const detail = (await (await request.get(`/api/chats/${chat.id}`)).json()) as ChatDetail;
      return detail.runs.find((item) => item.id === run.id)?.status;
    })
    .toBe('completed');
  // Synthetic presentation isolates the UI contract; server transformation has separate coverage.
  await page.route('**/api/chats/*/sources/*/presentation', async (route) => {
    const result = await (await route.fetch()).json();
    await route.fulfill({
      json: {
        ...result,
        request: { text: '화면 요청', applied: ['display'], changed: true },
        inputTransform: { text: '전송 요청', applied: ['input'], changed: true },
      },
    });
  });
  await page.goto(`/?chat=${chat.id}`);
  const source = page.getByTestId('source').first();
  await expect(source.getByTestId('source-request')).toHaveText('화면 요청');
  await source.getByText('전송 시 변환됨 · 원문과 전송문 보기', { exact: true }).click();
  await expect(source.locator('.request-transform-details')).toContainText('원래 요청');
  await expect(source.locator('.request-transform-details')).toContainText('전송 요청');
  await source.getByRole('button', { name: '요청 편집', exact: true }).click();
  await expect(source.getByLabel('요청 수정 내용', { exact: true })).toHaveValue('원래 요청');
  await source.getByRole('button', { name: '요청 수정 취소', exact: true }).click();
  await expect(source.getByTestId('source-request')).toHaveText('화면 요청');
});
