import { test, expect, type Page, type APIRequestContext, type Route } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { ChatDetail, Chat, Run } from '../core/types.js';
import { postFixtureChat } from './fixtures/chat.js';

const original = '(OOC: 미라는 아직 진실을 몰라.)\n\n*{{char}}는 기다린다.*';
const translated = '(OOC: Mira does not know the truth yet.)\n\n*{{char}} waits.*';
const endpoint = '**/api/chats/*/input-translation';
async function clipboardText(page: Page) {
  // https://learn.microsoft.com/en-us/windows/win32/dataxchg/standard-clipboard-formats (2026-11-20):
  // in the Windows CF_TEXT and CF_UNICODETEXT formats, each line ends with CR-LF.
  return (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n');
}
const composer = (page: Page) => page.getByRole('textbox', { name: '다음 장면 요청', exact: true });
async function translate(page: Page) {
  const button = page.getByRole('button', { name: '입력 번역', exact: true });
  if (!(await button.isVisible()))
    await page.getByRole('button', { name: '입력창 더보기', exact: true }).click();
  return button;
}
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

{
  const width = 412;
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
    await expect(page.locator('.input-translation-language-mobile')).toHaveCount(0);
    const languageSelect = page.getByRole('combobox', { name: '입력 번역 언어 선택', exact: true });
    const setLanguage = async (code: 'en' | 'es' | 'ja') => {
      if (!(await languageSelect.isVisible()))
        await page.getByRole('button', { name: '입력창 더보기', exact: true }).click();
      await languageSelect.selectOption(code);
      await expect(languageSelect).toHaveValue(code);
    };
    await setLanguage('es');
    await setLanguage('en');
    await composer(page).fill(original);
    await (await translate(page)).click();
    await expect(composer(page)).toHaveValue(translated);
    expect((await detail(request, chat.id)).runs).toHaveLength(0);
    await page.getByText('번역 전 원문 보기', { exact: true }).click();
    await expect(page.locator('.input-translation-original pre')).toHaveText(original);
    await page.screenshot({ path: info.outputPath(`input-translation-${width}.png`) });
    await page.getByRole('button', { name: '되돌리기', exact: true }).click();
    await expect(composer(page)).toHaveValue(original);
    await expect(page.getByText('번역 전 원문 보기', { exact: true })).toHaveCount(0);
    await (await translate(page)).click();
    await expect(composer(page)).toHaveValue(translated);
    await setLanguage('ja');
    await page.reload();
    await expect(composer(page)).toHaveValue(translated);
    if (!(await languageSelect.isVisible()))
      await page.getByRole('button', { name: '입력창 더보기', exact: true }).click();
    await expect(languageSelect).toHaveValue('ja');
    await expect(page.getByText('번역 전 원문 보기', { exact: true })).toBeVisible();
    const finalText = `${translated}\n  Keep the ending unresolved.  `;
    await composer(page).fill(finalText);
    await send(page).click();
    await expect(composer(page)).toHaveValue('');
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
    await expect(page.locator('#source-' + saved.runs[0].sourceRevision)).toBeVisible();
    const copy = page.getByRole('button', { name: '요청 복사', exact: true });
    await copy.click();
    await expect(page.getByRole('button', { name: '요청 복사됨', exact: true })).toBeVisible();
    expect(await clipboardText(page)).toBe(finalText);
    await page.screenshot({ path: info.outputPath(`request-copy-${width}.png`) });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      text: original,
      targetLanguage: 'en',
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
    await (await translate(page)).click();
    await started.promise;
    await composer(page).fill('바꾼 초안');
    await composer(page).fill(original);
    released.release();
    await finished.promise;
    await expect(
      page.getByText('이전 초안의 번역 (현재 입력 유지)', { exact: true })
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
    await (await translate(page)).click();
    await started.promise;
    await page.getByRole('button', { name: '입력 번역 취소', exact: true }).click();
    await (await translate(page)).click();
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
    await (await translate(page)).click();
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
    await (await translate(page)).click();
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

test('ITRAN send invalidates translation even while its preflight is pending', async ({
  page,
  request,
}) => {
  const chat = await createChat(request);
  const started = gate(),
    released = gate(),
    finished = gate();
  let translationCalls = 0;
  await page.route(`**/api/chats/${chat.id}/codex-content-preflight`, async (route) => {
    if (route.request().postDataJSON().role !== 'translation') return route.continue();
    started.release();
    await released.promise;
    await route.fulfill({ status: 200, json: { warning: false } }).catch(() => {});
    finished.release();
  });
  await page.route(endpoint, async (route) => {
    translationCalls++;
    await answer(route, 'TOO_LATE');
  });
  await page.route(`**/api/chats/${chat.id}/runs`, (route) =>
    route.fulfill({ status: 422, json: { error: 'Synthetic rejection' } })
  );
  try {
    await open(page, chat.id);
    await composer(page).fill(original);
    await (await translate(page)).click();
    await started.promise;
    await send(page).click();
    await expect(page.getByRole('alert')).toContainText('요청을 처리할 수 없어요. (422)');
    released.release();
    await finished.promise;
    await expect(composer(page)).toHaveValue(original);
    expect(translationCalls).toBe(0);
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
  await (await translate(page)).click();
  await expect(page.getByRole('alert').filter({ hasText: '번역을 거절했어요' })).toBeVisible();
  await expect(composer(page)).toHaveValue(original);
  rejectedTranslation = false;
  await (await translate(page)).click();
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
    if (calls.length === 2)
      return route.fulfill({ status: 409, json: { error: 'Temporary confirmation failure' } });
    const response = await route.fetch();
    expect(response.ok(), await response.text()).toBe(true);
    if (calls.length === 1) await route.abort('failed');
    else await route.fulfill({ response });
  });
  await open(page, chat.id);
  await composer(page).fill(original);
  await (await translate(page)).click();
  await expect(composer(page)).toHaveValue(translated);
  await send(page).click();
  await expect(page.getByRole('button', { name: '이전 요청 확인', exact: true })).toBeEnabled();
  await expect(page.getByText('번역 전 원문 보기', { exact: true })).toBeVisible();
  await page.reload();
  await expect(composer(page)).toHaveValue(translated);
  await expect(page.getByRole('button', { name: '되돌리기', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '이전 요청 확인', exact: true }).click();
  await page
    .getByRole('dialog', { name: '이전 요청 접수 확인', exact: true })
    .getByRole('button', { name: '접수 확인', exact: true })
    .click();
  await expect.poll(() => calls.length).toBe(2);
  await expect(page.getByRole('button', { name: '이전 요청 확인', exact: true })).toBeEnabled();
  await expect(composer(page)).toHaveValue(translated);
  await page.getByRole('button', { name: '이전 요청 확인', exact: true }).click();
  const decision = page.getByRole('dialog', { name: '이전 요청 접수 확인', exact: true });
  await expect(decision).toContainText('비용이 중복될 수 있어요');
  await decision.getByRole('button', { name: '접수 확인', exact: true }).click();
  await expect(composer(page)).toHaveValue('');
  await expect(page.getByText('번역 전 원문 보기', { exact: true })).toHaveCount(0);
  expect(calls).toHaveLength(3);
  expect(calls[1]).toEqual(calls[0]);
  expect(calls[2]).toEqual(calls[0]);
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
    await source.getByLabel('요청 및 컨텍스트 메뉴', { exact: true }).click();
    const edit = source.getByRole('button', { name: '요청 수정', exact: true });
    await expect(edit).toBeDisabled();
    const before = await detail(request, chat.id);
    const copy = source.getByRole('button', { name: '요청 복사', exact: true });
    await copy.focus();
    await expect(copy).toBeEnabled();
    await copy.click();
    await expect(source.getByRole('button', { name: '요청 복사됨', exact: true })).toBeVisible();
    expect(await clipboardText(page)).toBe(raw);
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
  expect(await clipboardText(page)).toBe(raw);
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
