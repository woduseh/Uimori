import { test, expect, type Page, type APIRequestContext, type Route } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { ChatDetail, Chat, Run } from '../core/types.js';
import { postFixtureChat } from './fixtures/chat.js';

const original = '(OOC: 미라는 아직 진실을 몰라.)\n\n*{{char}}는 기다린다.*';
const translated = '(OOC: Mira does not know the truth yet.)\n\n*{{char}} waits.*';
const endpoint = '**/api/chats/*/input-translation';
const composer = (page: Page) => page.getByRole('textbox', { name: '다음 장면 요청', exact: true });
const translate = (page: Page) => page.getByRole('button', { name: '입력 번역', exact: true });
const send = (page: Page) => page.getByRole('button', { name: '원문 생성', exact: true });
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function createChat(request: APIRequestContext): Promise<Chat> {
  const response = await postFixtureChat(request, {
    data: { title: `Input translation ${randomUUID().slice(0, 8)}` },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
async function detail(request: APIRequestContext, id: string): Promise<ChatDetail> {
  return (await request.get(`/api/chats/${id}`)).json();
}
async function open(page: Page, chatId: string) {
  await page.goto(`/?chat=${chatId}`);
  await expect(composer(page)).toBeVisible();
}
async function answer(route: Route, text = translated) {
  await route.fulfill({
    json: { text, targetLanguage: route.request().postDataJSON().targetLanguage },
  });
}
async function spaNavigate(page: Page, url: string) {
  await page.evaluate((next) => {
    history.pushState(null, '', next);
    dispatchEvent(new PopStateEvent('popstate'));
  }, url);
}
async function seed(request: APIRequestContext, chat: Chat, text: string): Promise<Run> {
  const before = await detail(request, chat.id);
  const response = await request.post(`/api/chats/${chat.id}/runs`, {
    data: {
      request: text,
      expectedRevision: before.chat.headRevision,
      expectedSettingsRevision: before.chat.settingsRevision,
      idempotencyKey: randomUUID(),
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const run = (await response.json()) as Run;
  await expect
    .poll(
      async () => (await detail(request, chat.id)).runs.find((item) => item.id === run.id)?.status
    )
    .toBe('completed');
  return run;
}

test('ITRAN long requests survive composer translation, send, edit and reload', async ({
  page,
  request,
}) => {
  const chat = await createChat(request);
  const draft = '요'.repeat(3998) + '끝부분';
  const translated = 'R'.repeat(19998) + 'END';
  let translationCalls = 0;
  await page.route(endpoint, async (route) => {
    expect(route.request().postDataJSON().text).toBe(draft);
    translationCalls++;
    await answer(route, translated);
  });
  await open(page, chat.id);
  await composer(page).fill(draft);
  await expect(composer(page)).toHaveValue(draft);
  await translate(page).click();
  await expect(composer(page)).toHaveValue(translated);
  expect(translationCalls).toBe(1);
  expect((await detail(request, chat.id)).runs).toHaveLength(0);
  await send(page).click();
  await expect.poll(async () => (await detail(request, chat.id)).runs[0]?.status).toBe('completed');
  expect((await detail(request, chat.id)).runs[0].request).toBe(translated);
  await page.getByRole('button', { name: '요청 편집', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '요청 수정 내용', exact: true });
  await expect(editor).toHaveValue(translated);
  const edited = translated + '\n수정한 전개';
  await editor.fill(edited);
  await expect(editor).toHaveValue(edited);
  await page.getByRole('button', { name: '수정한 요청 보내기', exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('chat')).not.toBe(chat.id);
  const copyId = new URL(page.url()).searchParams.get('chat')!;
  await expect.poll(async () => (await detail(request, copyId)).runs[0]?.status).toBe('completed');
  await page.reload();
  expect((await detail(request, copyId)).runs[0].request).toBe(edited);
  expect((await detail(request, chat.id)).runs[0].request).toBe(translated);
  expect(translationCalls).toBe(1);
});

for (const width of [360, 412, 1440]) {
  test(`ITRAN ${width} translate, undo, reload, edit and explicitly send only the final text`, async ({
    page,
    request,
    context,
  }, info) => {
    const chat = await createChat(request);
    await page.setViewportSize({ width, height: 900 });
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const calls: Record<string, unknown>[] = [];
    await page.route(endpoint, async (route) => {
      calls.push(route.request().postDataJSON());
      await answer(route);
    });
    await open(page, chat.id);
    const language = page.getByRole('combobox', { name: '입력 번역 언어', exact: true });
    const mobileLanguage = page.locator('.input-translation-language-mobile');
    const mobileSummary = mobileLanguage.locator('summary');
    const setLanguage = async (code: 'en' | 'es' | 'ja', label: string) => {
      if (width <= 600) {
        await mobileSummary.click();
        await mobileLanguage.getByRole('button', { name: label, exact: true }).click();
        await expect(mobileSummary).toHaveText(code.toUpperCase());
      } else {
        await language.selectOption(code);
        await expect(language).toHaveValue(code);
      }
    };
    if (width <= 600) {
      await expect(language).toBeHidden();
      await expect(mobileSummary).toHaveText('EN');
    } else {
      await expect(language).toHaveValue('en');
      await expect(mobileLanguage).toBeHidden();
    }
    await composer(page).fill('짧은 요청');
    expect((await composer(page).boundingBox())!.width).toBeGreaterThan(width <= 600 ? 150 : 100);
    await setLanguage('es', '스페인어');
    if (width > 600) {
      // Long labels need room for both text and the native dropdown indicator.
      const labelFits = await language.evaluate((node) => {
        const select = node as HTMLSelectElement;
        const style = getComputedStyle(select);
        const drawing = document.createElement('canvas').getContext('2d')!;
        drawing.font = style.font;
        return (
          drawing.measureText(select.selectedOptions[0].text).width <=
          select.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - 16
        );
      });
      expect(labelFits).toBe(true);
    }
    await setLanguage('en', '영어');
    await composer(page).fill(original);
    await translate(page).click();
    await expect(composer(page)).toHaveValue(translated);
    expect((await detail(request, chat.id)).runs).toHaveLength(0);
    await page.getByText('번역 전 원문 보기', { exact: true }).click();
    await expect(page.locator('.input-translation-original pre')).toHaveText(original);
    await page.screenshot({ path: info.outputPath(`input-translation-${width}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true
    );
    expect((await composer(page).boundingBox())!.width).toBeGreaterThan(120);
    await page.getByRole('button', { name: '되돌리기', exact: true }).click();
    await expect(composer(page)).toHaveValue(original);
    await expect(page.getByText('번역 전 원문 보기', { exact: true })).toHaveCount(0);
    await translate(page).click();
    await expect(composer(page)).toHaveValue(translated);
    await setLanguage('ja', '일본어');
    await page.reload();
    await expect(composer(page)).toHaveValue(translated);
    if (width <= 600) await expect(mobileSummary).toHaveText('JA');
    else await expect(language).toHaveValue('ja');
    await expect(page.getByText('번역 전 원문 보기', { exact: true })).toBeVisible();
    const finalText = `${translated}\n  Keep the ending unresolved.  `;
    await composer(page).fill(finalText);
    await send(page).click();
    await expect(composer(page)).toHaveValue('');
    if (width < 600)
      expect(await composer(page).evaluate((node) => node.scrollHeight)).toBeLessThanOrEqual(56);
    await expect(page.getByText('번역 전 원문 보기', { exact: true })).toHaveCount(0);
    await expect
      .poll(async () => (await detail(request, chat.id)).runs[0]?.status)
      .toBe('completed');
    const saved = await detail(request, chat.id);
    expect(saved.runs).toHaveLength(1);
    expect(saved.runs[0].request).toBe(finalText);
    expect(JSON.stringify(saved)).not.toContain(original);
    expect(
      await page.evaluate((id) => sessionStorage.getItem(`input-translation:draft:${id}`), chat.id)
    ).toBeNull();
    const copy = page.getByRole('button', { name: '요청 복사', exact: true });
    await copy.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: '요청 복사됨', exact: true })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(finalText);
    await page.screenshot({ path: info.outputPath(`request-copy-${width}.png`) });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      text: original,
      targetLanguage: 'en',
      branchId: `main:${chat.id}`,
    });
    expect(errors).toEqual([]);
  });
}

test('ITRAN typing, including edit-then-revert, cannot be overwritten by a late translation', async ({
  page,
  request,
}) => {
  const chat = await createChat(request);
  const started = gate(),
    released = gate(),
    finished = gate();
  await page.route(endpoint, async (route) => {
    started.release();
    await released.promise;
    await answer(route);
    finished.release();
  });
  try {
    await open(page, chat.id);
    await composer(page).fill(original);
    await translate(page).click();
    await started.promise;
    await composer(page).fill('바꾼 초안');
    await composer(page).fill(original);
    released.release();
    await finished.promise;
    await expect(
      page.getByText('이전 초안의 번역 · 현재 입력은 유지했어요', { exact: true })
    ).toBeVisible();
    await expect(composer(page)).toHaveValue(original);
    await composer(page).fill('지금 보존해야 할 새 초안');
    await page.getByRole('button', { name: '이 번역으로 입력 바꾸기', exact: true }).click();
    await expect(composer(page)).toHaveValue(translated);
    await page.getByRole('button', { name: '되돌리기', exact: true }).click();
    await expect(composer(page)).toHaveValue('지금 보존해야 할 새 초안');
    expect((await detail(request, chat.id)).runs).toHaveLength(0);
  } finally {
    released.release();
  }
});

test('ITRAN explicit cancellation and a newer translation discard the older response', async ({
  page,
  request,
}) => {
  const chat = await createChat(request);
  const started = gate(),
    released = gate(),
    finished = gate();
  let calls = 0;
  await page.route(endpoint, async (route) => {
    calls++;
    if (calls === 1) {
      started.release();
      await released.promise;
      await answer(route, 'STALE_TRANSLATION');
      finished.release();
    } else await answer(route, 'NEW_TRANSLATION');
  });
  try {
    await open(page, chat.id);
    await composer(page).fill(original);
    await translate(page).click();
    await started.promise;
    await page.getByRole('button', { name: '입력 번역 취소', exact: true }).click();
    await translate(page).click();
    await expect(composer(page)).toHaveValue('NEW_TRANSLATION');
    released.release();
    await finished.promise;
    await expect(composer(page)).toHaveValue('NEW_TRANSLATION');
    await expect(page.locator('.input-translation-candidate')).toHaveCount(0);
    expect(calls).toBe(2);
  } finally {
    released.release();
  }
});

test('ITRAN leaving and returning to a chat never applies the translation from its earlier visit', async ({
  page,
  request,
}) => {
  const first = await createChat(request),
    second = await createChat(request);
  const started = gate(),
    released = gate(),
    finished = gate();
  await page.route(endpoint, async (route) => {
    started.release();
    await released.promise;
    await answer(route, 'OLD_VISIT_RESULT');
    finished.release();
  });
  try {
    await open(page, first.id);
    await composer(page).fill(original);
    await translate(page).click();
    await started.promise;
    await spaNavigate(page, `/?chat=${second.id}`);
    await expect(composer(page)).toHaveValue('');
    await composer(page).fill('다른 채팅의 초안');
    await spaNavigate(page, `/?chat=${first.id}`);
    await expect(composer(page)).toHaveValue(original);
    released.release();
    await finished.promise;
    await expect(composer(page)).toHaveValue(original);
    await expect(page.locator('.input-translation-candidate')).toHaveCount(0);
    expect(await page.evaluate((id) => sessionStorage.getItem(`draft:${id}`), second.id)).toBe(
      '다른 채팅의 초안'
    );
  } finally {
    released.release();
  }
});

test('ITRAN send intent invalidates a running translation without making translation mandatory', async ({
  page,
  request,
}) => {
  const chat = await createChat(request);
  const started = gate(),
    released = gate(),
    finished = gate();
  await page.route(endpoint, async (route) => {
    started.release();
    await released.promise;
    await answer(route, 'TOO_LATE');
    finished.release();
  });
  try {
    await open(page, chat.id);
    await composer(page).fill(original);
    await translate(page).click();
    await started.promise;
    await send(page).click();
    await expect(composer(page)).toHaveValue('');
    await composer(page).fill('다음 요청 초안');
    released.release();
    await finished.promise;
    await expect(composer(page)).toHaveValue('다음 요청 초안');
    await expect(page.locator('.input-translation-candidate')).toHaveCount(0);
    expect((await detail(request, chat.id)).runs[0].request).toBe(original);
  } finally {
    released.release();
  }
});

test('ITRAN refused translation and rejected submission preserve the editable draft and undo', async ({
  page,
  request,
}) => {
  const chat = await createChat(request);
  let rejectedTranslation = true;
  await page.route(endpoint, async (route) => {
    if (rejectedTranslation)
      await route.fulfill({ status: 422, json: { error: 'INPUT_TRANSLATION_REFUSED' } });
    else await answer(route);
  });
  await open(page, chat.id);
  await composer(page).fill(original);
  await translate(page).click();
  await expect(page.getByRole('alert').filter({ hasText: '번역을 거절했어요' })).toBeVisible();
  await expect(composer(page)).toHaveValue(original);
  rejectedTranslation = false;
  await translate(page).click();
  await expect(composer(page)).toHaveValue(translated);
  await page.route(`**/api/chats/${chat.id}/runs`, (route) =>
    route.fulfill({ status: 400, json: { error: 'Rejected fixture' } })
  );
  await send(page).click();
  await expect(composer(page)).toHaveValue(translated);
  await expect(page.getByRole('button', { name: '되돌리기', exact: true })).toBeEnabled();
  await page.reload();
  await expect(composer(page)).toHaveValue(translated);
  await page.getByRole('button', { name: '되돌리기', exact: true }).click();
  await expect(composer(page)).toHaveValue(original);
  expect((await detail(request, chat.id)).runs).toHaveLength(0);
});

test('ITRAN uncertain admission retains undo across reload and cleans it only after confirmation', async ({
  page,
  request,
}) => {
  const chat = await createChat(request);
  await page.route(endpoint, (route) => answer(route));
  const calls: Record<string, unknown>[] = [];
  await page.route(`**/api/chats/${chat.id}/runs`, async (route) => {
    calls.push(route.request().postDataJSON());
    const response = await route.fetch();
    expect(response.ok(), await response.text()).toBe(true);
    if (calls.length === 1) await route.abort('failed');
    else await route.fulfill({ response });
  });
  await open(page, chat.id);
  await composer(page).fill(original);
  await translate(page).click();
  await expect(composer(page)).toHaveValue(translated);
  await send(page).click();
  await expect(page.getByRole('button', { name: '이전 요청 확인', exact: true })).toBeVisible();
  await expect(page.getByText('번역 전 원문 보기', { exact: true })).toBeVisible();
  await page.reload();
  await expect(composer(page)).toHaveValue(translated);
  await expect(page.getByRole('button', { name: '되돌리기', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '이전 요청 확인', exact: true }).click();
  await expect(composer(page)).toHaveValue('');
  await expect(page.getByText('번역 전 원문 보기', { exact: true })).toHaveCount(0);
  expect(calls).toHaveLength(2);
  expect(calls[1]).toEqual(calls[0]);
  const saved = await detail(request, chat.id);
  expect(saved.runs).toHaveLength(1);
  expect(saved.runs[0].request).toBe(translated);
  expect(JSON.stringify(saved)).not.toContain(original);
});

test('ICOPY full stored input is copied, not transformed or collapsed text, even while generation disables editing', async ({
  page,
  request,
  context,
}, info) => {
  const chat = await createChat(request);
  const raw = `  (OOC: Preserve this request.)\n\n${'**A full stored line**  \n'.repeat(35)}\n  END  `;
  await seed(request, chat, raw);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.route('**/api/chats/*/sources/*/presentation*', async (route) => {
    const response = await route.fetch();
    const value = await response.json();
    value.request = { ...value.request, text: 'DISPLAY_ONLY_TEXT_NOT_FOR_COPY' };
    await route.fulfill({ response, json: value });
  });
  await request.post('/api/test/control', { data: { action: 'hold', barrier: 'run' } });
  try {
    const current = await detail(request, chat.id);
    const response = await request.post(`/api/chats/${chat.id}/runs`, {
      data: {
        request: 'Running request',
        expectedRevision: current.chat.headRevision,
        expectedSettingsRevision: current.chat.settingsRevision,
        idempotencyKey: randomUUID(),
      },
    });
    expect(response.ok(), await response.text()).toBe(true);
    await open(page, chat.id);
    const source = page.getByTestId('source').first();
    await expect(source.getByTestId('source-request')).toHaveText('DISPLAY_ONLY_TEXT_NOT_FOR_COPY');
    const edit = source.getByRole('button', { name: '요청 편집', exact: true });
    await expect(edit).toBeDisabled();
    const before = await detail(request, chat.id);
    const copy = source.getByRole('button', { name: '요청 복사', exact: true });
    await copy.focus();
    await expect(copy).toBeEnabled();
    await copy.click();
    await expect(source.getByRole('button', { name: '요청 복사됨', exact: true })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(raw);
    const after = await detail(request, chat.id);
    expect(
      after.runs.map((run) => ({ id: run.id, request: run.request, status: run.status }))
    ).toEqual(before.runs.map((run) => ({ id: run.id, request: run.request, status: run.status })));
    await page.screenshot({ path: info.outputPath('copy-while-edit-disabled.png') });
  } finally {
    await request.post('/api/test/control', { data: { action: 'release', barrier: 'run' } });
  }
});

test('ICOPY clipboard failures do not report success and a collapsed request still copies in full', async ({
  page,
  request,
  context,
}) => {
  const chat = await createChat(request);
  const raw = '긴 입력과 줄바꿈  \n'.repeat(40);
  await seed(request, chat, raw);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await open(page, chat.id);
  const source = page.getByTestId('source').first();
  await expect(source.locator('.request-preview')).toBeVisible();
  const copy = source.getByRole('button', { name: '요청 복사', exact: true });
  await copy.click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(raw);
  await expect(copy).toBeVisible();
  await page.evaluate(() =>
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.reject(new DOMException('Denied', 'NotAllowedError')) },
    })
  );
  await copy.click();
  await expect(
    page.getByRole('alert').filter({ hasText: '요청을 복사하지 못했어요' })
  ).toBeVisible();
  await expect(source.getByRole('button', { name: '요청 복사됨', exact: true })).toHaveCount(0);
});
