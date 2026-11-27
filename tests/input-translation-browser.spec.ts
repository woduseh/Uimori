import { test, expect, type Page, type APIRequestContext, type Route } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { ChatDetail, Chat } from '../core/types.js';
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
{
  const width = 412;
  test(`ITRAN ${width} translate, undo, reload, edit and explicitly send only the final text`, async ({
    page,
    request,
    context,
  }) => {
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
