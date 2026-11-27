import { expect, test } from './fixtures/browser-test.js';
import { promptControls } from '../core/risu-prompt.js';
import { navigationAction, expectEditorSection, selectEditorSection } from './ui-navigation.js';
import { postFixtureChat } from './fixtures/chat.js';
import type { ChatDetail } from '../core/types.js';
import { expectCodeFieldValue } from './code-field.js';

test('RISUPRESETUI02 imports a real preset document into the existing prompt editor', async ({
  page,
  request,
}) => {
  const title = `RISUPRESETUI02 ${Date.now()}`;
  const source = {
    name: title,
    customPromptTemplateToggle:
      'mood=Imported Mood=select=Calm,Vivid\nmemo=Imported Memo=textarea\nlight=Imported Light',
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
  await page.getByRole('button', { name: '프롬프트 가져오기', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '프롬프트 가져오기', exact: true });
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
  await dialog.getByRole('button', { name: '창작 프롬프트로 저장', exact: true }).click();
  const saved = await savedResponse;
  expect(saved.ok(), await saved.text()).toBe(true);
  expect(promptControls((await saved.json()).preset.program)[0]).toMatchObject({
    id: 'mood',
    default: '0',
  });
  await dialog.getByRole('button', { name: '가져온 프롬프트 편집', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const composer = page.getByRole('region', { name: 'Risu 프롬프트 원본 편집', exact: true });
  await expect(composer).toBeVisible();
  await expectEditorSection(page, '구성');
  await selectEditorSection(page, '기본 옵션');
  const options = composer.locator('.prompt-option-group').first();
  await expect(options).not.toHaveAttribute('open');
  await options.locator('summary').click();
  await expect(
    page.getByTestId('prompt-editor').getByLabel('프롬프트 이름', { exact: true })
  ).toHaveValue(title);
  await expect(composer.getByLabel('Imported Mood', { exact: true })).toHaveValue('"0"');
  await expect(composer.getByRole('option', { name: '미설정', exact: true })).toHaveCount(0);
  await expect(composer.getByRole('button', { name: /미설정/ })).toHaveCount(0);
  await expect(composer.getByLabel('Imported Memo', { exact: true })).toHaveValue('');
  await expect(composer.getByRole('switch', { name: 'Imported Light' })).not.toBeChecked();
  await composer.getByLabel('Imported Memo', { exact: true }).fill('First line\nSecond line');
  await composer.getByLabel('Imported Mood', { exact: true }).selectOption('"1"');
  await selectEditorSection(page, '구성');
  await expectCodeFieldValue(
    composer.getByLabel('1번 프롬프트 본문', { exact: true }),
    source.promptTemplate[0]!.text!
  );
  await selectEditorSection(page, '정규식');
  await composer.getByText('고급 JSON 편집', { exact: true }).click();
  const regex = [{ in: '원래', out: '전송', type: 'editinput', ableFlag: true, flag: 'g' }];
  await composer.getByLabel('Risu 정규식 JSON', { exact: true }).fill(JSON.stringify(regex));
  const savePreset = page.getByRole('button', { name: '프롬프트 저장', exact: true });
  await expect(savePreset).toBeEnabled();
  await savePreset.click();
  await expect(page.getByText('프롬프트를 저장했어요.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '프롬프트 목록', exact: true }).click();
  await page.getByRole('button', { name: `${title} 프롬프트 편집`, exact: true }).click();
  await selectEditorSection(page, '기본 옵션');
  await expect(options).toHaveAttribute('open');
  await expect(composer.getByLabel('Imported Mood', { exact: true })).toHaveValue('"1"');
  await expect(composer.getByLabel('Imported Memo', { exact: true })).toHaveValue(
    'First line\nSecond line'
  );
  await expect(composer.getByRole('switch', { name: 'Imported Light' })).not.toBeChecked();
  await selectEditorSection(page, '정규식');
  await expect
    .poll(async () =>
      JSON.parse(await composer.getByLabel('Risu 정규식 JSON', { exact: true }).inputValue())
    )
    .toEqual(regex);
  expect(await (await request.get('/api/model-workspace')).json()).toEqual(before);
});

test('RISUPRESETUI03 display projection keeps the original edit value and cancelling preserves it', async ({
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
  await page.route(/\/api\/chats\/[^/]+\/sources\/[^/]+\/presentation(?:\?|$)/u, async (route) => {
    const result = await (await route.fetch()).json();
    await route.fulfill({
      json: {
        ...result,
        request: { text: '화면 요청', applied: ['display'], changed: true },
      },
    });
  });
  await page.goto(`/?chat=${chat.id}`);
  const source = page.getByTestId('source').first();
  await expect(source.getByTestId('source-request')).toHaveText('화면 요청');
  await source.getByLabel('요청 및 컨텍스트 메뉴', { exact: true }).click();
  await source.getByRole('button', { name: '요청 수정', exact: true }).click();
  await expect(source.getByLabel('요청 수정 내용', { exact: true })).toHaveValue('원래 요청');
  await source.getByRole('button', { name: '요청 편집 취소', exact: true }).click();
  await expect(source.getByTestId('source-request')).toHaveText('화면 요청');
});
