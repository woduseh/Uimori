import { expect, test } from '@playwright/test';
import { createDefaultPromptProgram } from '../core/prompt-defaults.js';
import type { RisuPresetImportApply } from '../core/risu-preset.js';
import { navigationAction, selectPromptSection } from './ui-navigation.js';

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
    promptTemplate: [
      {
        type: 'plain',
        role: 'system',
        type2: 'normal',
        text: '{{#when::mood::tis::1}}VIVID{{:else}}CALM{{/when}}',
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
  expect(await (await request.get('/api/model-workspace')).json()).toEqual(before);
});
