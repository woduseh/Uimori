import { visualReview } from './fixtures/visual-review.js';
import { preservePromptWorkspace } from './fixtures/prompt-workspace.js';
import { postFixtureChat } from './fixtures/chat.js';
import { test, expect, type APIRequestContext } from '@playwright/test';
import type { PromptWorkspace } from '../core/product.js';
import type { ChatDetail } from '../core/types.js';
import type { PromptProgram } from '../core/prompt-program.js';
import type { ChatOptionState } from '../core/chat-options.js';

async function detail(request: APIRequestContext, id: string): Promise<ChatDetail> {
  const response = await request.get(`/api/chats/${id}`);
  expect(response.ok()).toBe(true);
  return response.json();
}
async function fixture(request: APIRequestContext) {
  const program: PromptProgram = {
    version: 1,
    controls: [
      {
        id: 'language',
        label: '응답 언어',
        group: '기본 설정',
        type: 'select',
        default: 'ko',
        options: [
          { label: '한국어', value: 'ko' },
          { label: '직접 지정', value: 'custom' },
        ],
      },
      {
        id: 'customLanguage',
        label: '직접 지정 언어',
        group: '기본 설정',
        type: 'text',
        default: '',
        visibleWhen: { op: 'equal', args: [{ control: 'language' }, 'custom'] },
      },
      { id: 'inner', label: '내면 서술 강조', group: '시점·문체', type: 'boolean', default: false },
      {
        id: 'detail',
        label: '서술 상세도',
        group: '시점·문체',
        type: 'number',
        default: 1,
        min: 0,
        max: 3,
      },
    ],
    blocks: [
      {
        id: 'system',
        title: 'Synthetic instructions',
        kind: 'message',
        role: 'system',
        template: [{ kind: 'text', text: 'Synthetic creative options fixture.' }],
      },
      { id: 'history', title: 'History', kind: 'history', from: 0, to: 'end' },
    ],
  };
  const promptResponse = await request.post('/api/prompt-presets', {
    data: { title: '합성 창작 옵션', role: 'main', program },
  });
  expect(promptResponse.ok()).toBe(true);
  const prompt = await promptResponse.json();
  const workspace = (await (await request.get('/api/prompt-workspace')).json()) as PromptWorkspace;
  expect(
    (
      await request.post('/api/prompt-workspace/apply', {
        data: { expectedRevision: workspace.revision, role: 'main', presetId: prompt.id },
      })
    ).ok()
  ).toBe(true);
  const combination = await request.post('/api/prompt-combinations', {
    data: {
      title: '합성 기본 창작 프리셋',
      role: 'main',
      owner: { kind: 'preset', id: prompt.id },
      expectedRevision: prompt.revision,
      values: { language: 'ko', customLanguage: '', inner: false, detail: 1 },
    },
  });
  expect(combination.ok()).toBe(true);
  const chatResponse = await postFixtureChat(request, { data: { title: '합성 창작 옵션 채팅' } });
  expect(chatResponse.ok()).toBe(true);
  const chat = await chatResponse.json();
  return {
    chat,
    workspace: (await (await request.get('/api/prompt-workspace')).json()) as PromptWorkspace,
    before: (await detail(request, chat.id)).profile!,
  };
}

test('chat creative options preserve drafts, apply explicitly and fit desktop/mobile', async ({
  page,
  request,
}, info) => {
  const { chat, before } = await fixture(request);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const otherResponse = await request.post('/api/chats', {
    data: { title: '옵션 초안과 분리된 다른 채팅', botId: chat.botId },
  });
  expect(otherResponse.ok()).toBe(true);
  const other = await otherResponse.json();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/?chat=${chat.id}`);
  const open = page.getByRole('button', { name: '창작 옵션', exact: true });
  await page.getByRole('button', { name: '입력창 더보기', exact: true }).click();
  await open.click();
  await page.getByRole('tab', { name: '모든 채팅', exact: true }).click();
  const panel = page.getByRole('tabpanel', { name: '모든 채팅 옵션', exact: true });
  await expect(panel).toBeVisible();
  await expect(panel.getByText('합성 창작 옵션', { exact: true })).toBeVisible();
  await expect(panel.locator('summary').filter({ hasText: '기본 설정' })).toBeVisible();
  await expect(panel.locator('summary').filter({ hasText: '시점·문체' })).toBeVisible();
  const language = panel.getByLabel('응답 언어', { exact: true }),
    custom = panel.getByLabel('직접 지정 언어', { exact: true });
  await expect(custom).toBeHidden();
  await language.selectOption({ label: '직접 지정' });
  await custom.fill('프랑스어');
  const inner = panel.getByRole('switch', { name: '내면 서술 강조', exact: true });
  await expect(inner).not.toBeChecked();
  await inner.check();
  expect((await detail(request, chat.id)).profile).toEqual(before);
  // The panel is non-modal: the actual request draft remains editable while it is open.
  await page.getByRole('textbox', { name: '다음 장면 요청', exact: true }).fill('보존할 요청 초안');
  await page.getByRole('button', { name: '창작 옵션 닫기', exact: true }).click();
  await expect(panel).toBeHidden();
  await page.getByRole('button', { name: '입력창 더보기', exact: true }).click();
  await expect(page.getByLabel('빠른 옵션 조합', { exact: true })).toBeDisabled();
  await expect(open).toBeFocused();
  await open.click();
  await expect(custom).toHaveValue('프랑스어');
  const navigation = page.getByTestId('bot-navigation').filter({ visible: true });
  await navigation.locator(`[data-chat-id="${other.id}"] .chat-link`).click();
  await expect(page.getByRole('heading', { name: other.title, exact: true })).toBeVisible();
  await expect(panel.getByLabel('직접 지정 언어', { exact: true })).toHaveValue('프랑스어');
  await navigation.locator(`[data-chat-id="${chat.id}"] .chat-link`).click();
  await expect(custom).toHaveValue('프랑스어');
  await expect(inner).toBeChecked();
  expect((await detail(request, chat.id)).profile).toEqual(before);
  await panel.getByRole('button', { name: '현재 옵션 적용', exact: true }).click();
  await expect
    .poll(
      async () =>
        (await (await request.get('/api/prompt-workspace')).json()).main.values.customLanguage
    )
    .toBe('프랑스어');
  const saved = (await detail(request, chat.id)).profile!;
  expect((await (await request.get('/api/prompt-workspace')).json()).main.values.inner).toBe(true);
  expect(saved.routes).toEqual(before.routes);
  expect(saved.attachments).toEqual(before.attachments);
  expect(saved).toEqual(before);
  await expect(page.getByRole('textbox', { name: '다음 장면 요청', exact: true })).toHaveValue(
    '보존할 요청 초안'
  );
  if (visualReview) await page.screenshot({ path: info.outputPath('chat-options-desktop.png') });
  await custom.fill('독일어');
  await panel.getByRole('button', { name: '최신 설정 다시 불러오기', exact: true }).click();
  await expect(custom).toHaveValue('프랑스어');
  await panel.getByRole('button', { name: '프롬프트 기본값으로', exact: true }).click();
  await expect(language).toHaveValue('"ko"');
  await expect(custom).toBeHidden();
  expect((await detail(request, chat.id)).profile).toEqual(saved);
  page.once('dialog', (dialog) => dialog.accept());
  await page.reload();
  await page.getByRole('button', { name: '입력창 더보기', exact: true }).click();
  await open.click();
  await page.getByRole('tab', { name: '모든 채팅', exact: true }).click();
  await expect(custom).toHaveValue('프랑스어');
  await expect(inner).toBeChecked();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(panel).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true
  );
  expect(await panel.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await expect(panel.getByRole('button', { name: '현재 옵션 적용', exact: true })).toBeInViewport();
  if (visualReview) await page.screenshot({ path: info.outputPath('chat-options-mobile.png') });
  expect((await detail(request, chat.id)).runs).toHaveLength(0);
  expect(errors).toEqual([]);
});

test('creative option CAS conflict preserves draft and server profile', async ({
  page,
  request,
}) => {
  const { chat, before, workspace } = await fixture(request);
  await page.goto(`/?chat=${chat.id}`);
  await page.getByRole('button', { name: '입력창 더보기', exact: true }).click();
  await page.getByRole('button', { name: '창작 옵션', exact: true }).click();
  await page.getByRole('tab', { name: '모든 채팅', exact: true }).click();
  const panel = page.getByRole('tabpanel', { name: '모든 채팅 옵션', exact: true });
  await panel.getByLabel('응답 언어', { exact: true }).selectOption({ label: '직접 지정' });
  await panel.getByLabel('직접 지정 언어', { exact: true }).fill('스페인어');
  let concurrent!: PromptWorkspace;
  let interleaved = false;
  await page.route('**/api/prompt-workspace', async (route) => {
    if (route.request().method() !== 'PUT' || interleaved) return route.continue();
    interleaved = true;
    // Interleave after the UI has sent its stale revision so SSE timing cannot
    // turn this server-conflict check into a disabled-button timeout.
    const response = await request.put('/api/prompt-workspace', {
      data: {
        expectedRevision: workspace.revision,
        main: { ...workspace.main, title: '동시 수정 이름' },
      },
    });
    expect(response.ok()).toBe(true);
    concurrent = await response.json();
    await route.continue();
  });
  const conflict = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/prompt-workspace') && response.request().method() === 'PUT'
  );
  await panel.getByRole('button', { name: '현재 옵션 적용', exact: true }).click();
  expect((await conflict).status()).toBe(409);
  await expect(panel.getByLabel('직접 지정 언어', { exact: true })).toHaveValue('스페인어');
  expect(await (await request.get('/api/prompt-workspace')).json()).toEqual(concurrent);
  await panel.getByRole('button', { name: '최신 설정에 내 옵션 유지', exact: true }).click();
  await panel.getByRole('button', { name: '현재 옵션 적용', exact: true }).click();
  await expect
    .poll(
      async () =>
        (await (await request.get('/api/prompt-workspace')).json()).main.values.customLanguage
    )
    .toBe('스페인어');
  const recovered = (await detail(request, chat.id)).profile!;
  expect(recovered).toEqual(before);
  expect((await (await request.get('/api/prompt-workspace')).json()).main.title).toBe(
    '동시 수정 이름'
  );
});

test('chat creative options scope fixed values, oneoff reservations and revocable delegation', async ({
  page,
  request,
}, info) => {
  const { chat, workspace } = await fixture(request);
  const state = async () =>
    (await (await request.get(`/api/chats/${chat.id}/options`)).json()) as ChatOptionState;
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/?chat=${chat.id}`);
  await page.getByRole('button', { name: '입력창 더보기', exact: true }).click();
  await page.getByRole('button', { name: '창작 옵션', exact: true }).click();
  await expect(page.getByRole('tab', { name: '이 채팅', exact: true })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  const panel = page.getByRole('tabpanel', { name: '이 채팅 옵션', exact: true });
  const fixed = panel.getByRole('region', { name: '이 채팅 고정 옵션', exact: true });
  await expect(fixed.getByLabel('서술 상세도', { exact: true })).toBeDisabled();
  await fixed.getByRole('checkbox', { name: '서술 상세도 이 채팅에 고정', exact: true }).check();
  await fixed.getByLabel('서술 상세도', { exact: true }).fill('9');
  await expect(fixed.getByLabel('서술 상세도', { exact: true })).toHaveValue('9');
  await fixed.getByLabel('서술 상세도', { exact: true }).fill('3');
  expect((await state()).fixedValues).toEqual({});
  await page.getByRole('tab', { name: '모든 채팅', exact: true }).click();
  await page.getByRole('tab', { name: '이 채팅', exact: true }).click();
  await expect(fixed.getByLabel('서술 상세도', { exact: true })).toHaveValue('3');
  await panel.getByRole('button', { name: '채팅 고정 옵션 저장', exact: true }).click();
  await expect.poll(async () => (await state()).fixedValues).toEqual({ detail: 3 });
  expect(await (await request.get('/api/prompt-workspace')).json()).toEqual(workspace);
  const oneoff = panel
    .locator('details')
    .filter({ has: page.locator(':scope > summary', { hasText: /^다음 생성에만 적용$/ }) });
  await oneoff.locator(':scope > summary').click();
  await oneoff
    .getByRole('checkbox', { name: '서술 상세도 다음 생성에만 적용', exact: true })
    .check();
  await oneoff.getByLabel('서술 상세도', { exact: true }).fill('2');
  await oneoff.getByRole('button', { name: '1회 옵션 예약', exact: true }).click();
  await expect
    .poll(async () => (await state()).pending.map((item) => item.values))
    .toEqual([{ detail: 2 }]);
  await panel
    .getByRole('region', { name: '다음 생성 옵션 예약', exact: true })
    .getByRole('button', { name: '예약 취소', exact: true })
    .click();
  await expect.poll(async () => (await state()).pending).toHaveLength(0);
  await oneoff.locator(':scope > summary').click();
  const delegation = panel
    .locator('details')
    .filter({ has: page.locator(':scope > summary', { hasText: /^도우미에게 옵션 조정 위임$/ }) });
  await delegation.locator(':scope > summary').click();
  await delegation.getByRole('checkbox', { name: '내면 서술 강조', exact: true }).check();
  await delegation.getByRole('button', { name: '선택한 옵션 지속 위임', exact: true }).click();
  await expect
    .poll(async () => (await state()).delegations.map((item) => item.fields))
    .toEqual([['inner']]);
  await expect(delegation.getByText('지속 위임 중', { exact: true })).toBeVisible();
  await delegation.getByRole('button', { name: '지속 위임 해제', exact: true }).click();
  await expect.poll(async () => (await state()).delegations[0]?.revokedAt).not.toBeNull();
  await delegation.getByText('해제한 위임 1개', { exact: true }).click();
  await expect(delegation.locator('.chat-options-revocations .chat-option-record')).toHaveCount(1);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true
    );
    expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
      true
    );
    await expect(
      panel.getByRole('button', { name: '채팅 고정 옵션 저장', exact: true })
    ).toBeInViewport();
    const targets = await panel
      .locator('button, summary, label:has(> input[type="checkbox"])')
      .evaluateAll((elements) =>
        elements
          .filter((element) => element.checkVisibility())
          .map((element) => element.getBoundingClientRect().height)
      );
    expect(targets.every((height) => height >= 44)).toBe(true);
    if (visualReview)
      await page.screenshot({ path: info.outputPath(`chat-scoped-options-${width}.png`) });
  }
  expect((await detail(request, chat.id)).runs).toHaveLength(0);
});

test('chat creative options retry an uncertain save with the same operation and preserve a CAS draft', async ({
  page,
  request,
}) => {
  const { chat } = await fixture(request);
  const state = async () =>
    (await (await request.get(`/api/chats/${chat.id}/options`)).json()) as ChatOptionState;
  await page.goto(`/?chat=${chat.id}`);
  await page.getByRole('button', { name: '입력창 더보기', exact: true }).click();
  await page.getByRole('button', { name: '창작 옵션', exact: true }).click();
  const panel = page.getByRole('tabpanel', { name: '이 채팅 옵션', exact: true });
  const fixed = panel.getByRole('region', { name: '이 채팅 고정 옵션', exact: true });
  await fixed.getByRole('checkbox', { name: '서술 상세도 이 채팅에 고정', exact: true }).check();
  await fixed.getByLabel('서술 상세도', { exact: true }).fill('3');
  const operations: string[] = [];
  await page.route(`**/api/chats/${chat.id}/options/fixed`, async (route) => {
    operations.push(route.request().postDataJSON().operationId);
    if (operations.length !== 1) return route.continue();
    const applied = await route.fetch();
    expect(applied.ok()).toBe(true);
    await route.abort('failed');
  });
  await panel.getByRole('button', { name: '채팅 고정 옵션 저장', exact: true }).click();
  await expect(
    panel.getByRole('button', { name: '같은 요청 다시 확인', exact: true })
  ).toBeVisible();
  const firstSaved = await state();
  expect(firstSaved.fixedValues).toEqual({ detail: 3 });
  await panel.getByRole('button', { name: '같은 요청 다시 확인', exact: true }).click();
  await expect(panel.getByRole('button', { name: '같은 요청 다시 확인', exact: true })).toHaveCount(
    0
  );
  expect(operations).toHaveLength(2);
  expect(operations[0]).toBe(operations[1]);
  expect((await state()).revision).toBe(firstSaved.revision);
  await page.unroute(`**/api/chats/${chat.id}/options/fixed`);
  await fixed.getByLabel('서술 상세도', { exact: true }).fill('1');
  let interleaved = false;
  await page.route(`**/api/chats/${chat.id}/options/fixed`, async (route) => {
    if (interleaved) return route.continue();
    interleaved = true;
    const currentState = await state();
    const concurrent = await request.post(`/api/chats/${chat.id}/options/fixed`, {
      data: {
        branchId: currentState.branchId,
        expectedRevision: currentState.revision,
        binding: currentState.binding,
        values: { detail: 2 },
        operationId: crypto.randomUUID(),
      },
    });
    expect(concurrent.ok()).toBe(true);
    await route.continue();
  });
  await panel.getByRole('button', { name: '채팅 고정 옵션 저장', exact: true }).click();
  await expect(
    panel.getByRole('button', { name: '최신 정의에 초안 유지', exact: true })
  ).toBeVisible();
  await expect(fixed.getByLabel('서술 상세도', { exact: true })).toHaveValue('1');
  expect((await state()).fixedValues).toEqual({ detail: 2 });
  await panel.getByRole('button', { name: '최신 정의에 초안 유지', exact: true }).click();
  await panel.getByRole('button', { name: '채팅 고정 옵션 저장', exact: true }).click();
  await expect.poll(async () => (await state()).fixedValues).toEqual({ detail: 1 });
  expect((await detail(request, chat.id)).runs).toHaveLength(0);
});

preservePromptWorkspace();
