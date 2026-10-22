import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { ChatOptionState } from '../core/chat-options.js';
import type { PromptWorkspace } from '../core/product.js';
import type { Chat } from '../core/types.js';
import { nativePrompt } from './fixtures/native-prompt.js';
import { postFixtureChat } from './fixtures/chat.js';
import { preservePromptWorkspace } from './fixtures/prompt-workspace.js';

preservePromptWorkspace();

async function fixture(request: APIRequestContext) {
  const before = (await (await request.get('/api/prompt-workspace')).json()) as PromptWorkspace;
  const changed = await request.put('/api/prompt-workspace', {
    data: {
      expectedRevision: before.revision,
      main: {
        title: '채팅 옵션 복구 검증',
        program: nativePrompt('', {
          customPromptTemplateToggle: 'tone=합성 문체=text\nnote=독립 메모=text',
        }),
        values: { tone: '기준 문체', note: '기준 메모' },
      },
    },
  });
  expect(changed.ok(), await changed.text()).toBe(true);
  const workspace = (await changed.json()) as PromptWorkspace;
  const created = await postFixtureChat(request, { data: { title: '채팅 옵션 충돌 복구' } });
  expect(created.ok(), await created.text()).toBe(true);
  return { chat: (await created.json()) as Chat, workspace };
}

async function openOptions(page: Page, chat: Chat, width = 412) {
  await page.setViewportSize({ width, height: 915 });
  await page.goto(`/?chat=${chat.id}`);
  await page.getByRole('button', { name: '입력창 더보기', exact: true }).click();
  await page.getByRole('button', { name: '창작 옵션', exact: true }).click();
  return page.locator('#chat-prompt-options');
}

async function readOptions(request: APIRequestContext, chat: Chat) {
  const response = await request.get(`/api/chats/${chat.id}/options`);
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as ChatOptionState;
}

async function externalFixed(request: APIRequestContext, chat: Chat, note: string) {
  const current = await readOptions(request, chat);
  const response = await request.post(`/api/chats/${chat.id}/options/fixed`, {
    data: {
      expectedRevision: current.revision,
      operationId: crypto.randomUUID(),
      binding: current.binding,
      values: { note },
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as ChatOptionState;
}

for (const width of [412, 1440]) {
  test(`OPTIONSCOPE1 one list preserves edits across scope changes and saves only the chosen scope at ${width}`, async ({
    page,
    request,
  }, info) => {
    const { chat } = await fixture(request);
    await externalFixed(request, chat, '저장된 고정 메모');
    const panel = await openOptions(page, chat, width);
    const scope = panel.getByRole('switch', { name: '다음 생성에만 적용', exact: true });
    const save = panel.getByRole('button', { name: '채팅 고정 옵션 저장', exact: true });
    const reserve = panel.getByRole('button', { name: '1회 옵션 예약', exact: true });
    await expect(scope).not.toBeChecked();
    await expect(save).toBeDisabled();
    await scope.check();
    await expect(reserve).toBeDisabled();
    await scope.uncheck();
    await expect(save).toBeDisabled();
    await panel.locator('.chat-option-group > summary').first().click();
    await expect(panel.locator('.chat-option-group')).toHaveCount(1);
    await expect(panel.getByLabel('독립 메모', { exact: true })).toHaveValue('저장된 고정 메모');
    await panel.getByRole('button', { name: '합성 문체 개별 지정', exact: true }).click();
    const tone = panel.getByLabel('합성 문체', { exact: true });
    await tone.fill('한 목록에서 편집한 문체');
    await scope.check();
    await expect(tone).toHaveValue('한 목록에서 편집한 문체');
    await expect(panel.getByLabel('독립 메모', { exact: true })).toHaveCount(0);
    await tone.fill('범위를 바꾼 뒤의 문체');
    await scope.uncheck();
    await expect(tone).toHaveValue('범위를 바꾼 뒤의 문체');
    await save.click();
    await expect(save).toHaveAttribute('aria-busy', 'false');
    await expect(save).toBeDisabled();
    expect((await readOptions(request, chat)).fixedValues).toEqual({
      tone: '범위를 바꾼 뒤의 문체',
      note: '저장된 고정 메모',
    });
    await scope.check();
    await expect(reserve).toBeDisabled();
    await panel.getByRole('button', { name: '합성 문체 다음 생성만 지정', exact: true }).click();
    await expect(tone).toHaveValue('범위를 바꾼 뒤의 문체');
    await expect(reserve).toBeEnabled();
    await scope.uncheck();
    await expect(save).toBeDisabled();
    const refreshed = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/chats/${chat.id}/options`) &&
        response.request().method() === 'GET'
    );
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await (await refreshed).finished();
    await expect(
      panel.getByText('저장하지 않은 옵션 초안이 있어요.', { exact: true })
    ).toBeVisible();
    await scope.check();
    await expect(reserve).toBeEnabled();
    await expect(tone).toHaveValue('범위를 바꾼 뒤의 문체');
    await tone.fill('한 번만 쓸 문체');
    await expect(reserve).toBeInViewport({ ratio: 1 });
    expect(await panel.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(
      1
    );
    await page.screenshot({ path: info.outputPath(`chat-option-scope-oneoff-${width}.png`) });
    await reserve.click();
    await expect(reserve).toHaveAttribute('aria-busy', 'false');
    await expect(reserve).toBeDisabled();
    const accepted = await readOptions(request, chat);
    expect(accepted.fixedValues).toEqual({
      tone: '범위를 바꾼 뒤의 문체',
      note: '저장된 고정 메모',
    });
    expect(accepted.pending).toHaveLength(1);
    expect(accepted.pending[0].values).toEqual({ tone: '한 번만 쓸 문체' });
    await scope.uncheck();
    await expect(tone).toHaveValue('범위를 바꾼 뒤의 문체');
    await expect(save).toBeDisabled();
    const pending = panel.getByRole('region', { name: '다음 생성 옵션 예약', exact: true });
    await expect(pending).toContainText('한 번만 쓸 문체');
    expect((await readOptions(request, chat)).pending).toHaveLength(1);
    await page.screenshot({ path: info.outputPath(`chat-option-scope-fixed-${width}.png`) });
  });
}

test('OPTIONREVIEW1 failed reads expose retry; one shared draft survives scope changes and removed inputs require explicit saved-version adoption', async ({
  page,
  request,
}, info) => {
  const { chat, workspace } = await fixture(request);
  let failRead = true;
  let failedReads = 0;
  await page.route(`**/api/chats/${chat.id}/options`, async (route) => {
    if (route.request().method() === 'GET' && failRead) {
      failedReads++;
      return route.fulfill({ status: 503, json: { error: 'Synthetic option read failure' } });
    }
    await route.continue();
  });
  const panel = await openOptions(page, chat);
  await expect(panel.getByRole('alert')).toBeVisible();
  expect(failedReads).toBeGreaterThan(0);
  const retry = panel.getByRole('button', { name: /다시 불러오기$/ });
  await expect(retry).toBeVisible();
  await expect(panel.getByRole('button', { name: '최신 상태 확인', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: '최신 옵션 불러오기', exact: true })).toHaveCount(
    0
  );
  failRead = false;
  await retry.click();
  await expect(retry).toHaveCount(0);
  await panel
    .locator('section[aria-label="창작 옵션 값"] .chat-option-group > summary')
    .first()
    .click();
  await expect(
    panel.getByRole('button', { name: '합성 문체 개별 지정', exact: true })
  ).toBeVisible();
  await expect(panel.getByRole('button', { name: '최신 상태 확인', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: '최신 옵션 불러오기', exact: true })).toHaveCount(
    0
  );
  await page.screenshot({ path: info.outputPath('chat-options-ready-without-reload-412.png') });
  await panel.getByRole('button', { name: '합성 문체 개별 지정', exact: true }).click();
  await panel.getByLabel('합성 문체', { exact: true }).fill('사라질 고정 입력');
  await panel.getByRole('button', { name: '독립 메모 개별 지정', exact: true }).click();
  await panel.getByLabel('독립 메모', { exact: true }).fill('버릴 내 메모');
  const scope = panel.getByRole('switch', { name: '다음 생성에만 적용', exact: true });
  await scope.check();
  await expect(panel.getByLabel('합성 문체', { exact: true })).toHaveValue('사라질 고정 입력');
  await panel.getByLabel('합성 문체', { exact: true }).fill('사라질 1회 입력');
  await scope.uncheck();
  await expect(panel.getByLabel('합성 문체', { exact: true })).toHaveValue('사라질 1회 입력');
  const changed = await request.put('/api/prompt-workspace', {
    data: {
      expectedRevision: workspace.revision,
      main: {
        ...workspace.main,
        program: nativePrompt('', { customPromptTemplateToggle: 'note=독립 메모=text' }),
        values: { note: '최신 기본 메모' },
      },
    },
  });
  expect(changed.ok(), await changed.text()).toBe(true);
  const writes: unknown[] = [];
  page.on('request', (entry) => {
    if (entry.method() === 'POST' && entry.url().includes(`/chats/${chat.id}/options/`))
      writes.push(entry.postDataJSON());
  });
  await panel.getByRole('button', { name: '채팅 고정 옵션 저장', exact: true }).click();
  const dialog = page.getByRole('alertdialog', { name: '채팅 옵션 저장 내용 확인', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '저장본 확인', exact: true }).click();
  const discarded = dialog.getByRole('region', { name: '유지할 수 없는 입력', exact: true });
  await expect(discarded).toContainText('합성 문체');
  await expect(discarded).toContainText('사라질 1회 입력');
  await expect(dialog.getByRole('region', { name: '현재 저장본', exact: true })).toContainText(
    '최신 기본 메모'
  );
  await expect(
    dialog.getByRole('button', { name: '입력 유지하고 계속 편집', exact: true })
  ).toBeVisible();
  await expect(
    dialog.getByRole('button', { name: '입력 버리고 저장본 불러오기', exact: true })
  ).toBeVisible();
  expect(await dialog.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(
    1
  );
  for (const name of ['입력 유지하고 계속 편집', '입력 버리고 저장본 불러오기'])
    await expect(dialog.getByRole('button', { name, exact: true })).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: info.outputPath('chat-option-discarded-input-review-412.png') });
  const persisted = await readOptions(request, chat);
  const writesBeforeChoice = writes.length;
  await dialog.getByRole('button', { name: '입력 버리고 저장본 불러오기', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(panel.getByLabel('합성 문체', { exact: true })).toHaveCount(0);
  await expect(
    panel.getByRole('button', { name: '독립 메모 개별 지정', exact: true })
  ).toBeVisible();
  await expect(panel).toContainText('최신 기본 메모');
  await expect(
    panel.getByRole('button', { name: '채팅 고정 옵션 저장', exact: true })
  ).toBeDisabled();
  await scope.check();
  await expect(panel.getByRole('button', { name: '1회 옵션 예약', exact: true })).toBeDisabled();
  expect(writes).toHaveLength(writesBeforeChoice);
  expect(await readOptions(request, chat)).toEqual(persisted);
});

test('OPTIONREVIEW3 saved-version adoption keeps dormant oneoff intent while editing fixed options', async ({
  page,
  request,
}) => {
  const { chat } = await fixture(request);
  await externalFixed(request, chat, '원래 고정 메모');
  const panel = await openOptions(page, chat);
  const scope = panel.getByRole('switch', { name: '다음 생성에만 적용', exact: true });
  await panel.locator('.chat-option-group > summary').first().click();
  await scope.check();
  await panel.getByRole('button', { name: '독립 메모 다음 생성만 지정', exact: true }).click();
  await expect(panel.getByLabel('독립 메모', { exact: true })).toHaveValue('원래 고정 메모');
  await scope.uncheck();
  await panel.getByRole('button', { name: '합성 문체 개별 지정', exact: true }).click();
  await panel.getByLabel('합성 문체', { exact: true }).fill('내가 편집한 문체');
  const remote = await externalFixed(request, chat, '외부에서 저장한 메모');
  await panel.getByRole('button', { name: '채팅 고정 옵션 저장', exact: true }).click();
  const dialog = page.getByRole('alertdialog', { name: '채팅 옵션 저장 내용 확인', exact: true });
  await dialog.getByRole('button', { name: '저장본 확인', exact: true }).click();
  await dialog.getByRole('button', { name: '입력 유지하고 계속 편집', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(panel.getByLabel('독립 메모', { exact: true })).toHaveValue('원래 고정 메모');
  await expect(panel.getByLabel('합성 문체', { exact: true })).toHaveValue('내가 편집한 문체');
  expect((await readOptions(request, chat)).fixedValues).toEqual(remote.fixedValues);
  await scope.check();
  await expect(panel.getByLabel('독립 메모', { exact: true })).toHaveValue('원래 고정 메모');
  const reserve = panel.getByRole('button', { name: '1회 옵션 예약', exact: true });
  await reserve.click();
  await expect(reserve).toHaveAttribute('aria-busy', 'false');
  const accepted = await readOptions(request, chat);
  expect(accepted.fixedValues).toEqual(remote.fixedValues);
  expect(accepted.pending).toHaveLength(1);
  expect(accepted.pending[0].values).toEqual({ tone: '내가 편집한 문체', note: '원래 고정 메모' });
});

test('OPTIONREVIEW2 conflicted oneoff and cancel actions stay available; a lost acknowledgement reuses its operation ID once', async ({
  page,
  request,
}, info) => {
  const { chat } = await fixture(request);
  const panel = await openOptions(page, chat, 1440);
  await panel
    .locator('section[aria-label="창작 옵션 값"] .chat-option-group > summary')
    .first()
    .click();
  const scope = panel.getByRole('switch', { name: '다음 생성에만 적용', exact: true });
  await scope.check();
  await panel.getByRole('button', { name: '합성 문체 다음 생성만 지정', exact: true }).click();
  const oneoffTone = panel.getByLabel('합성 문체', { exact: true }).last();
  await oneoffTone.fill('다음 생성 문체');
  const remote = await externalFixed(request, chat, '외부 고정 메모');
  // Focus is an existing automatic refresh trigger, including when another window wrote options.
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(panel.getByRole('alert')).toContainText(/바뀌|변경/);
  const stage = panel.getByRole('button', { name: '1회 옵션 예약', exact: true });
  await expect(stage).toBeEnabled();
  await stage.click();
  const dialog = page.getByRole('alertdialog', { name: '채팅 옵션 저장 내용 확인', exact: true });
  await dialog.getByRole('button', { name: '저장본 확인', exact: true }).click();
  await expect(
    dialog.getByRole('button', { name: '입력 유지하고 계속 편집', exact: true })
  ).toBeVisible();
  await expect(
    dialog.getByRole('button', { name: '입력 버리고 저장본 불러오기', exact: true })
  ).toBeVisible();
  await page.screenshot({ path: info.outputPath('chat-option-explicit-recovery-review-1440.png') });
  await dialog.getByRole('button', { name: '입력 유지하고 계속 편집', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(oneoffTone).toHaveValue('다음 생성 문체');
  expect((await readOptions(request, chat)).pending).toEqual([]);
  const submissions: Record<string, unknown>[] = [];
  let accepted: ChatOptionState | undefined;
  await page.route(`**/api/chats/${chat.id}/options/oneoff`, async (route) => {
    submissions.push(route.request().postDataJSON());
    const response = await route.fetch();
    expect(response.ok(), await response.text()).toBe(true);
    if (submissions.length === 1) {
      accepted = (await response.json()) as ChatOptionState;
      return route.fulfill({ status: 503, json: { error: 'Synthetic lost acknowledgement' } });
    }
    await route.fulfill({ response });
  });
  await stage.click();
  // SSE can also report the accepted revision before this uncertain response is confirmed.
  await expect(
    panel.getByRole('alert').filter({ hasText: '반영 여부를 확인하지 못했어요' })
  ).toBeVisible();
  await expect(scope).toBeDisabled();
  await expect(oneoffTone).toBeDisabled();
  expect(submissions).toHaveLength(1);
  const confirmSame = panel.getByRole('button', { name: '같은 요청 다시 확인', exact: true });
  await confirmSame.click();
  await expect.poll(() => submissions.length).toBe(2);
  await expect(confirmSame).toHaveCount(0);
  const pending = panel.getByRole('region', { name: '다음 생성 옵션 예약', exact: true });
  await expect(pending).toContainText('다음 생성 문체');
  expect(submissions).toHaveLength(2);
  expect(submissions[1]).toEqual(submissions[0]);
  expect(submissions[0].operationId).toEqual(expect.any(String));
  expect(submissions[0].expectedRevision).toBe(remote.revision);
  const recovered = await readOptions(request, chat);
  expect(recovered.revision).toBe(accepted!.revision);
  expect(recovered.pending).toHaveLength(1);
  expect(recovered.pending[0].id).toBe(accepted!.pending[0].id);
  await scope.uncheck();
  await expect(pending).toBeVisible();
  await panel.getByLabel('독립 메모', { exact: true }).fill('저장하지 않은 내 메모');
  const latest = await externalFixed(request, chat, '두 번째 외부 메모');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(panel.getByRole('alert')).toContainText(/바뀌|변경/);
  const cancel = pending.getByRole('button', { name: '예약 취소', exact: true });
  await expect(cancel).toBeEnabled();
  await cancel.click();
  await dialog.getByRole('button', { name: '저장본 확인', exact: true }).click();
  await dialog.getByRole('button', { name: '입력 유지하고 계속 편집', exact: true }).click();
  await expect(dialog).toBeHidden();
  expect((await readOptions(request, chat)).pending).toHaveLength(1);
  await cancel.click();
  await expect(pending).toHaveCount(0);
  await expect(panel.getByLabel('독립 메모', { exact: true }).first()).toHaveValue(
    '저장하지 않은 내 메모'
  );
  const afterCancel = await readOptions(request, chat);
  expect(afterCancel.pending).toEqual([]);
  expect(afterCancel.fixedValues).toEqual(latest.fixedValues);
  expect(afterCancel.revision).toBe(latest.revision + 1);
});
