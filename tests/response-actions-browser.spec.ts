import { expect, test, type APIRequestContext, type Page } from './fixtures/browser-test.js';
import type { Chat, ChatDetail, Run } from '../core/types.js';
import type { ResponseStreamPage } from '../core/response-stream.js';
import { postFixtureChat } from './fixtures/chat.js';
import { openSourceActions } from './ui-navigation.js';

async function detail(request: APIRequestContext, chatId: string): Promise<ChatDetail> {
  const response = await request.get(`/api/chats/${chatId}`);
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

async function seed(request: APIRequestContext, title: string, requests: string[]) {
  const created = await postFixtureChat(request, { data: { title } });
  expect(created.ok(), await created.text()).toBe(true);
  const chat = (await created.json()) as Chat;
  const configured = await request.patch(`/api/chats/${chat.id}/settings`, {
    data: {
      ...chat.settings,
      expectedSettingsRevision: chat.settingsRevision,
    },
  });
  expect(configured.ok(), await configured.text()).toBe(true);
  for (const [index, text] of requests.entries()) {
    const before = await detail(request, chat.id);
    const started = await request.post(`/api/chats/${chat.id}/runs`, {
      data: {
        request: text,
        expectedRevision: before.chat.headRevision,
        expectedSettingsRevision: before.chat.settingsRevision,
        expectedProfileRevision: before.profile!.revision,
        idempotencyKey: `response-actions-${chat.id}-${index}`,
      },
    });
    expect(started.ok(), await started.text()).toBe(true);
    const run = (await started.json()) as Run;
    await expect
      .poll(
        async () => (await detail(request, chat.id)).runs.find((item) => item.id === run.id)?.status
      )
      .toBe('completed');
  }
  return detail(request, chat.id);
}

test('RACOM04 last response retry chooses replacement or copy and preserves the response until success', async ({
  page,
  request,
}) => {
  test.setTimeout(60_000);
  const before = await seed(request, '재요청 방식 합성 채팅', ['첫 장면', '마지막 장면']);
  const old = before.sources.at(-1)!;
  const modes: string[] = [];
  page.on('request', (event) => {
    if (event.method() === 'POST' && event.url().endsWith('/retry'))
      modes.push(event.postDataJSON().mode);
  });
  const control = async (action: string, extra: Record<string, string>) => {
    const response = await request.post('/api/test/control', { data: { action, ...extra } });
    expect(response.ok(), await response.text()).toBe(true);
  };
  await page.goto(`/?chat=${before.chat.id}`);
  const oldScene = page.locator(`[data-testid="source"][data-source-id="${old.id}"]`);
  const reopen = async () => {
    await openSourceActions(oldScene);
    await oldScene.getByRole('button', { name: '다시 쓰기', exact: true }).last().click();
  };
  await reopen();
  const dialog = page.getByRole('dialog', { name: '다시 쓰기', exact: true });
  await expect(dialog.getByRole('textbox', { name: '다시 쓸 요청' })).toHaveValue('마지막 장면');
  await expect(
    dialog.getByRole('button', { name: '새 채팅에서 다시 요청', exact: true })
  ).toBeVisible();
  await page.setViewportSize({ width: 412, height: 900 });
  await dialog.getByRole('button', { name: '닫기', exact: true }).click();
  expect(modes).toHaveLength(0);
  await expect(oldScene).toBeVisible();

  await control('fail-next', { point: 'source-transaction' });
  await reopen();
  await dialog.getByRole('button', { name: '다시 쓰기', exact: true }).click();
  await expect
    .poll(async () =>
      (await detail(request, before.chat.id)).runs.some(
        (run) => run.snapshot.replacement?.sourceRevision === old.id && run.status === 'failed'
      )
    )
    .toBe(true);
  await expect(oldScene).toBeVisible();
  expect((await detail(request, before.chat.id)).chat.headRevision).toBe(old.id);

  await control('hold', { barrier: 'run' });
  try {
    await reopen();
    await dialog.getByRole('button', { name: '다시 쓰기', exact: true }).click();
    await expect(page.getByRole('button', { name: '원문 생성 취소', exact: true })).toBeVisible();
    await expect(oldScene).toBeVisible();
    await page.getByRole('button', { name: '원문 생성 취소', exact: true }).click();
    await expect
      .poll(async () =>
        (await detail(request, before.chat.id)).runs.some(
          (run) => run.snapshot.replacement?.sourceRevision === old.id && run.status === 'cancelled'
        )
      )
      .toBe(true);
    expect((await detail(request, before.chat.id)).chat.headRevision).toBe(old.id);
    await expect(oldScene).toBeVisible();
    await expect(
      page.getByText('다시 쓰기를 취소했어요. 기존 응답은 유지돼요.', { exact: true })
    ).toBeVisible();
    const cancelled = (await detail(request, before.chat.id)).runs.find(
      (run) => run.snapshot.replacement?.sourceRevision === old.id && run.status === 'cancelled'
    )!;
    await expect(
      page.locator(`[data-testid="pending-run"][data-run-id="${cancelled.id}"]`)
    ).toHaveCount(0);
    await page.reload();
    await expect(oldScene).toBeVisible();
    await expect(
      page.locator(`[data-testid="pending-run"][data-run-id="${cancelled.id}"]`)
    ).toHaveCount(0);
    await expect(
      page.getByText('다시 쓰기를 취소했어요. 기존 응답은 유지돼요.', { exact: true })
    ).toHaveCount(0);
  } finally {
    await control('release', { barrier: 'run' });
  }

  await control('hold', { barrier: 'run' });
  try {
    await reopen();
    await dialog.getByRole('button', { name: '다시 쓰기', exact: true }).click();
    await expect(page.getByRole('button', { name: '원문 생성 취소', exact: true })).toBeVisible();
    await expect(dialog).not.toBeVisible();
    await expect(oldScene).toBeVisible();
    expect((await detail(request, before.chat.id)).chat.headRevision).toBe(old.id);
  } finally {
    await control('release', { barrier: 'run' });
  }
  await expect
    .poll(async () => (await detail(request, before.chat.id)).chat.headRevision)
    .not.toBe(old.id);
  await expect(oldScene).toHaveCount(0);
  await expect(page.getByTestId('source')).toHaveCount(2);
  expect(new URL(page.url()).searchParams.get('chat')).toBe(before.chat.id);
  expect(modes).toEqual(['replace', 'replace', 'replace']);

  const replaced = (await detail(request, before.chat.id)).sources.at(-1)!;
  const replacedScene = page.locator(`[data-testid="source"][data-source-id="${replaced.id}"]`);
  await openSourceActions(replacedScene);
  await replacedScene.getByRole('button', { name: '다시 쓰기', exact: true }).last().click();
  await dialog.getByRole('button', { name: '새 채팅에서 다시 요청', exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('chat')).not.toBe(before.chat.id);
  const copiedChatId = new URL(page.url()).searchParams.get('chat')!;
  await expect.poll(async () => (await detail(request, copiedChatId)).sources.length).toBe(2);
  expect(modes.at(-1)).toBe('copy');
  expect((await detail(request, before.chat.id)).chat.headRevision).toBe(replaced.id);
  await page.goto(`/?chat=${before.chat.id}`);

  const first = page.locator(`[data-testid="source"][data-source-id="${before.sources[0].id}"]`);
  await openSourceActions(first);
  await first.getByRole('button', { name: '다시 쓰기', exact: true }).last().click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: '다시 쓰기', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: '새 채팅에서 다시 요청', exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('chat')).not.toBe(before.chat.id);
  const earlierCopyChatId = new URL(page.url()).searchParams.get('chat')!;
  await expect.poll(async () => (await detail(request, earlierCopyChatId)).sources.length).toBe(1);
});

async function cancelNewRequest(page: Page, request: APIRequestContext, chatId: string) {
  const held = await request.post('/api/test/control', {
    data: { action: 'hold', barrier: 'run' },
  });
  expect(held.ok(), await held.text()).toBe(true);
  try {
    await page.goto(`/?chat=${chatId}`);
    await page
      .getByRole('textbox', { name: '다음 장면 요청', exact: true })
      .fill('취소해도 남길 요청');
    await page.getByRole('button', { name: '원문 생성', exact: true }).click();
    await page.getByRole('button', { name: '원문 생성 취소', exact: true }).click();
    await expect
      .poll(async () => (await detail(request, chatId)).runs.at(-1)?.status)
      .toBe('cancelled');
    return (await detail(request, chatId)).runs.at(-1)!;
  } finally {
    const released = await request.post('/api/test/control', {
      data: { action: 'release', barrier: 'run' },
    });
    expect(released.ok(), await released.text()).toBe(true);
  }
}

test('RACOM07 cancelled request dismissal waits for acknowledgement, recovers transport failure and persists across pages without losing drafts or records', async ({
  page,
  request,
  context,
}) => {
  const before = await seed(request, '취소 요청 정리 합성 채팅', ['보존할 기존 장면']);
  const run = await cancelNewRequest(page, request, before.chat.id);
  const pending = page.locator(`[data-testid="pending-run"][data-run-id="${run.id}"]`);
  const actions = pending.getByRole('group', { name: '취소한 요청', exact: true });
  await expect(actions).toBeVisible();
  await expect(pending.getByTestId('source-request')).toHaveText(run.request);
  const composerDraft = '정리와 새로고침 후에도 남길 다음 요청 초안';
  const editDraft = '취소한 요청의 아직 보내지 않은 수정 초안';
  const composer = page.getByRole('textbox', { name: '다음 장면 요청', exact: true });
  await composer.fill(composerDraft);
  await pending.getByRole('button', { name: '요청 편집', exact: true }).click();
  await pending.getByRole('textbox', { name: '요청 수정 내용', exact: true }).fill(editDraft);
  await expect(actions.getByRole('button', { name: '화면에서 정리', exact: true })).toBeDisabled();
  await expect(actions.getByRole('button', { name: '다시 시도', exact: true })).toBeDisabled();
  await page.reload();
  await expect(actions).toBeVisible();
  const recordBefore = await detail(request, before.chat.id);

  let calls = 0;
  let release = () => {};
  const acknowledgement = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/api/runs/${run.id}/dismiss-reader`, async (route) => {
    calls++;
    if (calls === 1) {
      await route.abort('failed');
      return;
    }
    await acknowledgement;
    await route.fulfill({ response: await route.fetch() });
  });
  const otherPage = await context.newPage();
  try {
    await actions.getByRole('button', { name: '화면에서 정리', exact: true }).click();
    await expect.poll(() => calls).toBe(1);
    await expect(actions.getByRole('button', { name: '화면에서 정리', exact: true })).toBeEnabled();
    await expect(pending).toBeVisible();
    await expect(composer).toHaveValue(composerDraft);
    expect(await page.evaluate((id) => sessionStorage.getItem(`request-edit:${id}`), run.id)).toBe(
      editDraft
    );
    await page.reload();
    await expect(actions).toBeVisible();
    await expect(composer).toHaveValue(composerDraft);
    await pending.getByRole('button', { name: '요청 편집', exact: true }).click();
    await expect(pending.getByRole('textbox', { name: '요청 수정 내용', exact: true })).toHaveValue(
      editDraft
    );
    await pending.getByRole('button', { name: '요청 편집 취소', exact: true }).click();
    await page
      .getByRole('alertdialog', { name: '요청 편집 취소', exact: true })
      .getByRole('button', { name: '초안 버리고 닫기', exact: true })
      .click();

    await otherPage.goto(`/?chat=${before.chat.id}`);
    const otherPending = otherPage.locator(`[data-testid="pending-run"][data-run-id="${run.id}"]`);
    await expect(otherPending).toBeVisible();
    await actions.getByRole('button', { name: '화면에서 정리', exact: true }).click();
    await expect.poll(() => calls).toBe(2);
    await expect(pending).toBeVisible();
    await expect(otherPending).toBeVisible();
    await expect(composer).toHaveValue(composerDraft);
    release();
    await expect(pending).toHaveCount(0);
    await expect(otherPending).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId('source')).toHaveCount(before.sources.length);
    await expect(pending).toHaveCount(0);
    await expect(composer).toHaveValue(composerDraft);
    await otherPage.reload();
    await expect(otherPage.getByTestId('source')).toHaveCount(before.sources.length);
    await expect(otherPending).toHaveCount(0);
    const after = await detail(request, before.chat.id);
    expect(after.sources).toEqual(recordBefore.sources);
    expect(after.attempts).toEqual(recordBefore.attempts);
    const retained = after.runs.find((item) => item.id === run.id)!;
    expect(retained).toBeDefined();
    for (const key of [
      'request',
      'status',
      'partialText',
      'usage',
      'inputs',
      'toolEvents',
      'snapshot',
    ] as const)
      expect(retained[key]).toEqual(recordBefore.runs.find((item) => item.id === run.id)![key]);
  } finally {
    release();
    await page.unrouteAll({ behavior: 'wait' });
    await otherPage.close();
  }
});

test('RACOM08 cancelled request opens its specific task record and lazily recovers streamed partial output', async ({
  page,
  request,
}) => {
  const before = await seed(request, '취소 요청 일부 응답 합성 채팅', ['이전 작업과 구분할 장면']);
  const run = await cancelNewRequest(page, request, before.chat.id);
  const pending = page.locator(`[data-testid="pending-run"][data-run-id="${run.id}"]`);
  const partialText = '취소하기 전에 받은 공개 응답 조각이에요.';
  let streamReads = 0;
  await page.route(`**/api/response-streams/main/${run.id}?*`, async (route) => {
    streamReads++;
    await route.fulfill({
      json: {
        taskKind: 'main',
        taskId: run.id,
        status: 'cancelled',
        cursor: 1,
        hasMore: false,
        chunks: [
          {
            seq: 1,
            segment: 0,
            attemptId: 'cancelled-public',
            text: partialText,
            offset: partialText.length,
          },
        ],
      } satisfies ResponseStreamPage,
    });
  });
  await pending.getByRole('button', { name: '작업 기록', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '작업 현황', exact: true });
  await expect(dialog.getByTestId('run')).toHaveCount(1);
  const card = dialog.locator(`[data-testid="run"][data-run-id="${run.id}"]`);
  await expect(card.locator('.task-request')).toHaveText(run.request);
  await expect(card.locator('.task-history-notice .error')).toHaveCount(0);
  await expect(card.getByRole('button', { name: '접기', exact: true })).toHaveAttribute(
    'aria-expanded',
    'true'
  );
  const partial = card.locator('.partial-response');
  await expect(partial).not.toHaveAttribute('open');
  expect(streamReads).toBe(0);
  await partial.getByText('일부 응답 보기', { exact: true }).click();
  await expect(partial.locator('.streaming-text')).toHaveText(partialText);
  expect(streamReads).toBe(1);
});
