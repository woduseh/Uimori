import { expect, test, type Page, type Request } from '@playwright/test';
import { createReadingChat } from './fixtures/personal-workspace.js';
import { navigationAction } from './ui-navigation.js';

type ObservedWindow = Window & { readerVisibilityEvents: string[] };

async function observeStream(page: Page) {
  // Keep the real HTTP/SSE connection. The second case also delivers controlled
  // interaction notifications through the same EventSource message boundary.
  await page.addInitScript(() => {
    Object.assign(window, { readerVisibilityEvents: [] });
    const Original = window.EventSource;
    window.EventSource = class extends Original {
      private notify = (event: Event) => {
        this.dispatchEvent(
          new MessageEvent('message', { data: JSON.stringify((event as CustomEvent).detail) })
        );
      };
      constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options);
        this.addEventListener('message', (event) => {
          (window as unknown as ObservedWindow).readerVisibilityEvents.push(
            JSON.parse(event.data).kind
          );
        });
        window.addEventListener('test-reader-notification', this.notify);
      }
      close() {
        window.removeEventListener('test-reader-notification', this.notify);
        super.close();
      }
    };
  });
}

async function hidden(page: Page, value: boolean) {
  await page.evaluate((value) => {
    if (value) Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    else delete (document as unknown as { hidden?: boolean }).hidden;
    document.dispatchEvent(new Event('visibilitychange'));
  }, value);
}

async function notifyInteraction(page: Page, kind = 'native.interaction.requested') {
  await page.evaluate(
    (kind) =>
      window.dispatchEvent(
        new CustomEvent('test-reader-notification', {
          detail: { kind },
        })
      ),
    kind
  );
}

test('READVIS01 hidden and library readers defer SSE refreshes and restore current text with the draft', async ({
  page,
  request,
}) => {
  const { chat, detail } = await createReadingChat(request, 'Reader visibility', 1);
  const source = detail.sources[0];
  await observeStream(page);
  const pending = new Set<Request>();
  let reads = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === `/api/chats/${chat.id}/reader`) {
      reads++;
      pending.add(request);
    }
  });
  page.on('requestfinished', (request) => pending.delete(request));
  page.on('requestfailed', (request) => pending.delete(request));
  await page.goto(`/?chat=${chat.id}&source=${source.id}&mode=original`);
  const manuscript = page.locator('.risu-message-surface');
  await expect(manuscript).toContainText('Scene 1. Mira carried a purple umbrella.');
  await expect
    .poll(() => page.evaluate(() => (window as unknown as ObservedWindow).readerVisibilityEvents))
    .toContain('snapshot');
  // Allow the initial snapshot's batched refresh to settle before measuring reads.
  await page.waitForTimeout(250);
  await expect.poll(() => pending.size).toBe(0);
  const draft = page.getByRole('textbox', { name: '다음 장면 요청', exact: true });
  await draft.fill('화면을 떠나도 보존할 다음 장면 초안');

  let revision = source.editRevision ?? 0;
  let edits = 0;
  const editElsewhere = async (text: string) => {
    const response = await request.put(`/api/sources/${source.id}/text`, {
      data: { text, expectedRevision: revision },
    });
    expect(response.ok(), await response.text()).toBe(true);
    revision = (await response.json()).editRevision;
    edits++;
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as ObservedWindow).readerVisibilityEvents.filter(
              (kind) => kind === 'source.edited'
            ).length
        )
      )
      .toBe(edits);
  };

  await hidden(page, true);
  const hiddenReads = reads;
  await editElsewhere('원고 화면이 숨겨진 동안 다른 기기에서 저장한 본문.');
  await page.waitForTimeout(600);
  expect(reads).toBe(hiddenReads);
  await expect(manuscript).toContainText('Scene 1. Mira carried a purple umbrella.');
  await hidden(page, false);
  await expect(manuscript).toHaveText('원고 화면이 숨겨진 동안 다른 기기에서 저장한 본문.');
  await expect(draft).toHaveValue('화면을 떠나도 보존할 다음 장면 초안');
  await expect.poll(() => pending.size).toBe(0);

  await navigationAction(page, '서재');
  await expect(page.getByTestId('library-panel')).toBeVisible();
  const libraryReads = reads;
  await editElsewhere('서재를 보는 동안 다른 기기에서 다시 저장한 본문.');
  await page.waitForTimeout(600);
  expect(reads).toBe(libraryReads);
  await page.goBack();
  await expect(manuscript).toHaveText('서재를 보는 동안 다른 기기에서 다시 저장한 본문.');
  await expect(draft).toHaveValue('화면을 떠나도 보존할 다음 장면 초안');
  expect(reads).toBeGreaterThan(libraryReads);

  // A direct navigation read can also finish after hiding, without a newer SSE event.
  // It must leave work for resume even when the prior cursor was already caught up.
  await page.waitForTimeout(250);
  await expect.poll(() => pending.size).toBe(0);
  await navigationAction(page, '서재');
  let held = false;
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    `**/api/chats/${chat.id}/reader?*`,
    async (route) => {
      const response = await route.fetch();
      held = true;
      await gate;
      await route.fulfill({ response });
    },
    { times: 1 }
  );
  try {
    await page.goBack();
    await expect.poll(() => held).toBe(true);
    await hidden(page, true);
    release();
    await expect.poll(() => pending.size).toBe(0);
    const discardedReadCount = reads;
    await hidden(page, false);
    await expect.poll(() => reads).toBeGreaterThan(discardedReadCount);
    await expect(draft).toHaveValue('화면을 떠나도 보존할 다음 장면 초안');
  } finally {
    release();
  }
});

test('READVIS02 native input wakes on events without idle polling and coalesces reads and answers', async ({
  page,
  request,
}) => {
  const { chat, detail } = await createReadingChat(request, 'Native input visibility', 1);
  await observeStream(page);
  let interaction: { id: string; kind: 'input'; prompt: string } | undefined;
  let reads = 0,
    active = 0,
    maxActive = 0;
  let readGate: Promise<void> | undefined;
  let releaseRead = () => {};
  const answers: unknown[] = [];
  let releaseAnswer = () => {};
  const answerGate = new Promise<void>((resolve) => {
    releaseAnswer = resolve;
  });
  await page.route(`**/api/chats/${chat.id}/risu-interactions`, async (route) => {
    reads++;
    active++;
    maxActive = Math.max(maxActive, active);
    // Capture before the delay: a notification arriving during this read must
    // trigger a later read, otherwise the newly pending input would be lost.
    const interactions = interaction ? [interaction] : [];
    try {
      await readGate;
      await route.fulfill({ json: { interactions } });
    } finally {
      active--;
    }
  });
  await page.route(`**/api/chats/${chat.id}/risu-interactions/*`, async (route) => {
    const answeredId = new URL(route.request().url()).pathname.split('/').at(-1);
    answers.push(route.request().postDataJSON());
    await answerGate;
    if (interaction?.id === answeredId) interaction = undefined;
    await route.fulfill({ json: { accepted: true } });
  });
  await page.goto(`/?chat=${chat.id}&source=${detail.sources[0].id}&mode=original`);
  await expect(page.locator('.risu-message-surface')).toBeVisible();
  await expect.poll(() => reads).toBeGreaterThan(0);
  await expect.poll(() => active).toBe(0);
  const idleReads = reads;
  // The old 1.5-second loop would perform an otherwise unnecessary request here.
  await page.waitForTimeout(1700);
  expect(reads).toBe(idleReads);

  readGate = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  try {
    await notifyInteraction(page);
    await expect.poll(() => active).toBe(1);
    interaction = {
      id: 'synthetic-input',
      kind: 'input',
      prompt: '다음 장면의 장소를 입력해 주세요.',
    };
    await notifyInteraction(page);
    await notifyInteraction(page);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForTimeout(200);
    expect(reads).toBe(idleReads + 1);
    readGate = undefined;
    releaseRead();
    const dialog = page.getByRole('dialog', { name: '카드 입력', exact: true });
    await expect(dialog).toContainText(interaction.prompt);
    const input = dialog.getByRole('textbox', { name: '입력 내용', exact: true });
    await input.fill('달빛 아래의 도서관');
    await expect.poll(() => active).toBe(0);

    await hidden(page, true);
    const hiddenReads = reads;
    await notifyInteraction(page);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForTimeout(1700);
    expect(reads).toBe(hiddenReads);
    await hidden(page, false);
    await expect.poll(() => reads).toBeGreaterThan(hiddenReads);
    await expect(input).toHaveValue('달빛 아래의 도서관');

    // Another device can answer while its script keeps running. The resolved event,
    // rather than a terminal run or idle poll, must remove this now-expired prompt.
    interaction = undefined;
    await notifyInteraction(page, 'native.interaction.resolved');
    await expect(dialog).toBeHidden();
    interaction = { id: 'next-input', kind: 'input', prompt: '다음 입력을 기다려요.' };
    await notifyInteraction(page);
    await expect(dialog).toBeVisible();
    await input.fill('달빛 아래의 도서관');

    const confirm = dialog.getByRole('button', { name: '확인', exact: true });
    await confirm.click();
    await expect.poll(() => answers.length).toBe(1);
    await expect(confirm).toBeDisabled();
    await dialog.locator('form').dispatchEvent('submit');
    await page.waitForTimeout(100);
    expect(answers).toEqual([{ answer: '달빛 아래의 도서관' }]);
    // The next prompt may arrive before the prior answer's HTTP acknowledgement.
    interaction = { id: 'following-input', kind: 'input', prompt: '이어지는 질문이에요.' };
    await notifyInteraction(page);
    await expect(dialog).toContainText(interaction.prompt);
    await input.fill('다음 질문에 쓰고 있던 초안');
    releaseAnswer();
    await expect(confirm).toBeEnabled();
    await expect(input).toHaveValue('다음 질문에 쓰고 있던 초안');
    interaction = undefined;
    await notifyInteraction(page, 'native.interaction.resolved');
    await expect(dialog).toBeHidden();
    expect(maxActive).toBe(1);
  } finally {
    releaseRead();
    releaseAnswer();
  }
});
