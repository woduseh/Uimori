import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createDefaultRisuPrompt } from '../core/prompt-defaults.js';
import type { Content, Library, PromptPreset } from '../core/product.js';
import type { NativeTransferFile, NativeTransferReceipt } from '../core/native-transfer.js';
import type { RisuImportApply, RisuImportResult } from '../core/risu-import.js';
import { DEFAULT_WIDTHS } from './fixtures/browser-viewports.js';
import { navigationAction } from './ui-navigation.js';

async function post<T>(request: APIRequestContext, path: string, data: unknown): Promise<T> {
  const response = await request.post(path, { data });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
async function content(
  request: APIRequestContext,
  kind: Content['kind'],
  title: string,
  module?: Content
) {
  return post<Content>(request, '/api/content', {
    kind,
    title,
    description: '합성 이동 자료',
    text: 'Synthetic source retained verbatim.',
    loading: 'pinned',
    relatedIds: [],
    package: {
      version: 1,
      id: 'synthetic-transfer',
      revision: 1,
      title,
      description: 'Synthetic',
      body: 'Synthetic source retained verbatim.',
      lore: [],
      instructions: [],
      controls: [],
      transforms: [],
      ...(module ? { modules: [{ id: module.id, revision: module.revision }] } : {}),
    },
  });
}
async function openTransfer(page: Page, where = '서재') {
  await navigationAction(page, where);
  await page.getByRole('button', { name: '자료 파일 가져오기·내보내기', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '자료 파일 가져오기·내보내기', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

test('NATIVEUI01 exports a shared graph and prompt options, then reviews and imports new copies at both widths', async ({
  page,
  request,
}, info) => {
  const title = `NATIVEUI01 ${Date.now()}`;
  const module = await content(request, 'module', `${title} 모듈`);
  const bot = await content(request, 'bot', `${title} 봇`, module);
  const persona = await content(request, 'persona', `${title} 페르소나`, module);
  const program = createDefaultRisuPrompt('Synthetic instructions', 'main');
  program.nativeRisuPreset.preset.customPromptTemplateToggle = 'detailed=자세히=select=Off,On';
  const preset = await post<PromptPreset>(request, '/api/prompt-presets', {
    title: `${title} 프롬프트`,
    role: 'main',
    program,
    values: { detailed: '1' },
  });
  await post(request, '/api/prompt-combinations', {
    title: '합성 옵션',
    role: 'main',
    owner: { kind: 'preset', id: preset.id },
    expectedRevision: preset.revision,
    values: { detailed: '0' },
  });
  const workspace = await (await request.get('/api/prompt-workspace')).json();
  await page.goto('/');
  let dialog = await openTransfer(page);
  await dialog.getByRole('button', { name: '내보내기', exact: true }).click();
  for (const item of [bot, persona, preset])
    await dialog.getByRole('checkbox', { name: `${item.title} 내보내기`, exact: true }).check();
  const downloadEvent = page.waitForEvent('download');
  await dialog.getByRole('button', { name: '선택한 자료 내보내기', exact: true }).click();
  const download = await downloadEvent;
  const bytes = await readFile((await download.path())!);
  const file = JSON.parse(bytes.toString()) as NativeTransferFile;
  expect(file.format).toBe('uimori-native-transfer');
  expect(file.contents).toHaveLength(3);
  expect(file.prompts[0].combinations).toHaveLength(1);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  const newRoots: string[] = [];
  for (const width of DEFAULT_WIDTHS) {
    await page.setViewportSize({ width, height: 950 });
    dialog = await openTransfer(page);
    await dialog.getByRole('button', { name: '가져오기', exact: true }).click();
    const before = (await (await request.get('/api/library')).json()) as Library;
    await dialog.getByLabel('자료 파일 선택', { exact: true }).setInputFiles({
      name: 'unsupported.json',
      mimeType: 'application/json',
      buffer: Buffer.from('{"format":"unknown"}'),
    });
    await expect(dialog.getByRole('alert')).toContainText('지원하지 않는 자료 파일');
    await dialog.getByLabel('자료 파일 선택', { exact: true }).setInputFiles({
      name: 'synthetic.uimori-library.json',
      mimeType: 'application/json',
      buffer: bytes,
    });
    await expect(
      dialog.getByText('자료 3개 · 프롬프트 1개 · 옵션 조합 1개 · 이미지 0개', { exact: true })
    ).toBeVisible();
    expect(((await (await request.get('/api/library')).json()) as Library).contents).toEqual(
      before.contents
    );
    if (!(await dialog.getByText(module.title, { exact: true }).isVisible()))
      await dialog.getByText('가져올 항목 확인', { exact: true }).click();
    await expect(dialog.getByText(module.title, { exact: true })).toBeVisible();
    expect(
      await dialog.evaluate((node) => node.scrollWidth - node.clientWidth)
    ).toBeLessThanOrEqual(1);
    const submit = dialog.getByRole('button', { name: '새 사본으로 가져오기', exact: true });
    await submit.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`native-transfer-${width}.png`) });
    const responseEvent = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/native-transfers/apply') &&
        response.request().method() === 'POST'
    );
    await submit.click();
    const result = (await (await responseEvent).json()) as NativeTransferReceipt;
    await expect(
      dialog.getByRole('status').filter({ hasText: '새 사본으로 가져왔어요' })
    ).toBeVisible();
    const importedModule = result.items.find((item) => item.title === module.title)!;
    for (const original of [bot, persona]) {
      const imported = result.items.find((item) => item.title === original.title)!;
      expect(imported.id).not.toBe(original.id);
      const saved = (await (await request.get(`/api/content/${imported.id}`)).json()) as Content;
      expect(saved.package?.modules).toEqual([{ id: importedModule.id, revision: 1 }]);
      expect(saved.text).toBe(original.text);
      newRoots.push(imported.id);
    }
    const importedPrompt = result.items.find((item) => item.title === preset.title)!;
    const listing = (await (await request.get('/api/library')).json()) as Library;
    expect(
      listing.promptCombinations?.find(
        (item) => item.owner?.kind === 'preset' && item.owner.id === importedPrompt.id
      )?.values
    ).toEqual({ detailed: '0' });
    expect(await (await request.get('/api/prompt-workspace')).json()).toEqual(workspace);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  }
  expect(new Set(newRoots).size).toBe(4);
});

test('NATIVEUI02 explicit model binding and uncertain apply preserve the reviewed request without duplicate copies', async ({
  page,
  request,
}) => {
  const connection = await post<{ id: string }>(request, '/api/connections', {
    title: 'Native transfer synthetic connection',
    protocol: 'fixture-sse-v1',
    endpoint: 'http://127.0.0.1:9',
    enabled: true,
  });
  const model = await post<{ id: string }>(request, '/api/model-presets', {
    title: 'Native transfer synthetic model',
    connectionId: connection.id,
    modelId: 'synthetic',
    maxOutputTokens: 512,
    temperature: null,
  });
  const program = createDefaultRisuPrompt('Synthetic portable model binding', 'main');
  program.collaboration = {
    enabled: false,
    sharedInstructions: '',
    sharedControls: [],
    maxCalls: 2,
    agents: [
      {
        id: 'editor',
        title: '보조 편집',
        description: '',
        instructions: 'Synthetic instructions',
        model: { id: model.id },
        trigger: 'on-demand',
        tools: [],
        maxCalls: 1,
        maxOutputChars: 1000,
      },
    ],
  };
  const preset = await post<PromptPreset>(request, '/api/prompt-presets', {
    title: `NATIVEUI02 ${Date.now()}`,
    role: 'main',
    program,
  });
  const file = await post<NativeTransferFile>(request, '/api/native-transfers/export', {
    items: [{ kind: 'prompt-preset', id: preset.id }],
  });
  const requests: unknown[] = [];
  await page.route('**/api/native-transfers/apply', async (route) => {
    requests.push(route.request().postDataJSON());
    if (requests.length === 2) {
      await route.fulfill({ status: 429, json: { error: 'SYNTHETIC_RETRY_THROTTLED' } });
      return;
    }
    const response = await route.fetch();
    expect(response.ok(), await response.text()).toBe(true);
    if (requests.length === 1)
      await route.fulfill({ status: 503, json: { error: 'SYNTHETIC_RESPONSE_LOST' } });
    else await route.fulfill({ response });
  });
  await page.goto('/');
  const dialog = await openTransfer(page, '프롬프트');
  await dialog.getByLabel('자료 파일 선택', { exact: true }).setInputFiles({
    name: 'model.uimori-library.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(file)),
  });
  const submit = dialog.getByRole('button', { name: '새 사본으로 가져오기', exact: true });
  await expect(submit).toBeDisabled();
  const binding = dialog.getByRole('combobox');
  await expect(binding).toHaveValue('');
  await binding.selectOption('inherit-main');
  const before = (await (await request.get('/api/library')).json()) as Library;
  await submit.click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await expect(binding).toBeDisabled();
  await expect(dialog.getByLabel('자료 파일 선택', { exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await page.getByRole('button', { name: '자료 파일 가져오기·내보내기', exact: true }).click();
  await dialog.getByRole('button', { name: '같은 요청으로 다시 확인', exact: true }).click();
  await expect.poll(() => requests.length).toBe(2);
  await expect(
    dialog.getByRole('button', { name: '같은 요청으로 다시 확인', exact: true })
  ).toBeEnabled();
  await expect(binding).toBeDisabled();
  await expect(dialog.getByLabel('자료 파일 선택', { exact: true })).toBeDisabled();
  const retried = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/native-transfers/apply') && response.status() === 200
  );
  await dialog.getByRole('button', { name: '같은 요청으로 다시 확인', exact: true }).click();
  const result = (await (await retried).json()) as NativeTransferReceipt;
  expect(result.created).toBe(false);
  expect(requests).toHaveLength(3);
  expect(requests[1]).toEqual(requests[0]);
  expect(requests[2]).toEqual(requests[0]);
  await expect(
    dialog.getByRole('status').filter({ hasText: '새 사본으로 가져왔어요' })
  ).toBeVisible();
  const after = (await (await request.get('/api/library')).json()) as Library;
  expect(after.promptPresets!.length).toBe(before.promptPresets!.length + 1);
  expect(
    after.promptPresets!.find((item) => item.id === result.items[0].id)?.program.collaboration
      ?.agents[0].model
  ).toBeNull();
});

test('NATIVEUI03 Risu card JSON keeps ordinary lore by default and opens the new chat', async ({
  page,
  request,
}) => {
  const title = `NATIVEUI03 ${Date.now()}`;
  const card = {
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: {
      name: title,
      description: 'A synthetic pilot explores an imaginary planet.',
      first_mes: 'The pilot waits beside the ship.',
      character_book: {
        entries: [
          { name: 'World', content: 'The sky is green.', constant: true, enabled: true },
          { name: 'Culture', content: 'Pilots greet with a wave.', constant: true, enabled: true },
        ],
      },
    },
  };
  await page.goto('/');
  await navigationAction(page, '봇');
  await page.getByRole('button', { name: 'Risu 자료 가져오기', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Risu 자료 가져오기', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Risu 파일 선택', { exact: true }).setInputFiles({
    name: 'synthetic-risu-card.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(card)),
  });
  await expect(dialog.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await expect(
    dialog.getByText('로어 2개 · 시작문 1개 · 이미지 0개', { exact: true })
  ).toBeVisible();
  const memory = dialog.locator('details.risu-import-memory');
  await expect(memory).toHaveJSProperty('open', false);
  await expect(memory.locator('summary').first()).toHaveText(
    '로어북에서 과거 진행 기억 분리하기 (선택)'
  );
  for (const name of ['World', 'Culture'])
    await expect(
      memory.getByLabel(`${name} 과거 진행 기억으로 옮기기`, { exact: true })
    ).not.toBeChecked();
  const submit = dialog.getByRole('button', { name: '가져오고 새 채팅 열기', exact: true });
  await expect(submit).toBeEnabled();
  const applied = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/risu-imports/apply') && response.request().method() === 'POST'
  );
  await submit.click();
  const response = await applied;
  expect(response.ok(), await response.text()).toBe(true);
  const payload = response.request().postDataJSON() as RisuImportApply;
  expect(payload.memoryIds).toEqual([]);
  expect(payload.allowPartial).toBe(false);
  const imported = (await response.json()) as RisuImportResult;
  expect(imported.chat).not.toBeNull();
  await expect(dialog).toBeHidden();
  await expect.poll(() => new URL(page.url()).searchParams.get('chat')).toBe(imported.chat!.id);
  await expect(page.getByLabel('다음 장면 요청', { exact: true })).toBeVisible();
  const saved = (await (
    await request.get(`/api/content/${imported.receipt.items[0].id}`)
  ).json()) as Content;
  expect(saved.package?.lore).toHaveLength(2);
});

test('NATIVEUI04 Risu module JSON registers a library module without creating a chat or memory', async ({
  page,
  request,
}) => {
  const title = `NATIVEUI04 ${Date.now()}`;
  const beforeChats = await (await request.get('/api/chats')).json();
  const source = {
    type: 'risuModule',
    module: {
      id: 'synthetic-module',
      name: title,
      description: 'Synthetic module description for its reader.',
      lorebook: [
        {
          key: '',
          comment: 'Harbor setting',
          content: 'The harbor has blue lights.',
          mode: 'normal',
          alwaysActive: true,
          insertorder: 100,
        },
      ],
      regex: [],
      trigger: [],
    },
  };
  await page.goto('/');
  await navigationAction(page, '모듈');
  await page.getByRole('button', { name: 'Risu 자료 가져오기', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Risu 자료 가져오기', exact: true });
  await dialog.getByLabel('Risu 파일 선택', { exact: true }).setInputFiles({
    name: 'synthetic-risu-module.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(source)),
  });
  await expect(dialog.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await expect(dialog.locator('.risu-import-memory')).toHaveCount(0);
  await expect(
    dialog.getByText('.risum 파일 직접 가져오기는 지원하지 않아요.', { exact: true })
  ).toBeVisible();
  const applied = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/risu-imports/apply') && response.request().method() === 'POST'
  );
  await dialog.getByRole('button', { name: '모듈 가져오기', exact: true }).click();
  const response = await applied;
  expect(response.ok(), await response.text()).toBe(true);
  const imported = (await response.json()) as RisuImportResult;
  expect((response.request().postDataJSON() as RisuImportApply).memoryIds).toEqual([]);
  expect(imported.chat).toBeNull();
  const root = imported.receipt.items.find((item) => item.root)!;
  expect(root.category).toBe('module');
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole('status').filter({ hasText: '모듈을 서재에 등록했어요.' })
  ).toBeVisible();
  await expect(dialog.getByText(/연결된 채팅이 삭제/)).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: '새 채팅 열기', exact: true })).toHaveCount(0);
  const saved = (await (await request.get(`/api/content/${root.id}`)).json()) as Content;
  expect(saved.kind).toBe('module');
  expect(saved.package!.lore).toHaveLength(1);
  expect(saved.package!.lore[0].text).toBe('The harbor has blue lights.');
  expect(await (await request.get('/api/chats')).json()).toHaveLength(beforeChats.length);
});
