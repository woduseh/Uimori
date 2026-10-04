import { test, expect, type APIRequestContext, type Locator } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { ChatDetail, Run } from '../core/types.js';
import { postFixtureChat } from './fixtures/chat.js';

const original = '문은 열려 있었다.\n미라는 슬픔을 느꼈다.\n바람이 지나갔다.';
const selected = '미라는 슬픔을 느꼈다.';
const proposal = '미라는 문턱에서 멈췄다.';
const endpoint = '**/api/sources/*/selection-revision';
async function detail(request: APIRequestContext, chatId: string): Promise<ChatDetail> {
  const response = await request.get(`/api/chats/${chatId}`);
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
async function seed(request: APIRequestContext) {
  const created = await postFixtureChat(request, {
    data: { title: `Selected revision ${randomUUID()}` },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const chat = await created.json();
  const started = await request.post(`/api/chats/${chat.id}/runs`, {
    data: {
      request: 'One synthetic scene.',
      expectedRevision: null,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: randomUUID(),
    },
  });
  expect(started.ok(), await started.text()).toBe(true);
  const run = (await started.json()) as Run;
  await expect
    .poll(
      async () => (await detail(request, chat.id)).runs.find((item) => item.id === run.id)?.status
    )
    .toBe('completed');
  const generated = await detail(request, chat.id);
  const source = generated.sources[0];
  const saved = await request.put(`/api/sources/${source.id}/text`, {
    data: { text: original, expectedRevision: source.editRevision ?? 0 },
  });
  expect(saved.ok(), await saved.text()).toBe(true);
  return detail(request, chat.id);
}
async function choose(field: Locator) {
  await field.focus();
  await field.press('Control+Home');
  await field.press('ArrowDown');
  await field.press('Home');
  await field.press('Shift+End');
  await expect
    .poll(() =>
      field.evaluate((element: HTMLTextAreaElement) =>
        element.value.slice(element.selectionStart, element.selectionEnd)
      )
    )
    .toBe(selected);
}
async function expectReachable(button: Locator) {
  await button.scrollIntoViewIfNeeded();
  await expect
    .poll(() =>
      button.evaluate((element) => {
        const { left, right, top, bottom, width, height } = element.getBoundingClientRect();
        const x = left + width / 2;
        const y = top + height / 2;
        return (
          width > 0 &&
          height > 0 &&
          left >= 0 &&
          right <= innerWidth &&
          top >= 0 &&
          bottom <= innerHeight &&
          [
            [x, y],
            [left + 3, y],
            [right - 3, y],
            [x, top + 3],
            [x, bottom - 3],
          ].every(([pointX, pointY]) => element.contains(document.elementFromPoint(pointX, pointY)))
        );
      })
    )
    .toBe(true);
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

for (const width of [360, 1440]) {
  test(`SREV ${width} compares a proposal, changes only the selected draft and saves explicitly`, async ({
    page,
    request,
  }, info) => {
    const before = await seed(request);
    const source = before.sources[0];
    await page.setViewportSize({ width, height: 900 });
    let calls = 0;
    await page.route(endpoint, async (route) => {
      calls++;
      const body = route.request().postDataJSON();
      expect(body.draft.slice(body.start, body.end)).toBe(selected);
      expect(body).toMatchObject({
        draft: original,
        instruction: '뜻은 유지하고 감정을 행동으로 보여줘.',
        expectedSourceHash: source.hash,
        expectedRevision: source.editRevision,
      });
      await route.fulfill({ json: { text: proposal } });
    });
    await page.goto(`/?chat=${before.chat.id}`);
    const navigation = page.getByRole('navigation', { name: '장면 탐색', exact: true });
    await expect(navigation).toBeVisible();
    const scene = page.locator(`[data-source-id="${source.id}"][data-testid="source"]`);
    await scene.getByRole('button', { name: '원문 수정', exact: true }).click();
    const field = scene.getByRole('textbox', { name: '원문 수정 내용', exact: true });
    const save = scene.getByRole('button', { name: '원문 저장', exact: true });
    const cancel = scene.getByRole('button', { name: '수정 취소', exact: true });
    const open = scene.getByRole('button', { name: '선택 구절 퇴고', exact: true });
    await expect(open).toBeDisabled();
    await choose(field);
    await open.click();
    await scene
      .getByLabel('퇴고 요청', { exact: true })
      .fill('뜻은 유지하고 감정을 행동으로 보여줘.');
    await scene.getByRole('button', { name: '퇴고 제안 받기', exact: true }).click();
    await expect(scene.getByTestId('selection-revision-proposal')).toHaveText(proposal);
    await expect(field).toHaveValue(original);
    expect((await detail(request, before.chat.id)).sources[0].text).toBe(original);
    await expectReachable(cancel);
    await expectReachable(save);
    await expect(navigation).toBeVisible({ visible: width > 760 });
    await page.screenshot({ path: info.outputPath(`selected-revision-${width}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true
    );
    await scene.getByRole('button', { name: '선택 구간에 반영', exact: true }).click();
    const revised = `문은 열려 있었다.\n${proposal}\n바람이 지나갔다.`;
    await expect(field).toHaveValue(revised);
    expect((await detail(request, before.chat.id)).sources[0].text).toBe(original);
    expect(
      await page.evaluate(
        (id) =>
          JSON.parse(sessionStorage.getItem(`uimori:text-draft:${id}:original`) ?? 'null')?.text,
        source.id
      )
    ).toBe(revised);
    await expectReachable(save);
    await save.click();
    await expect(field).toHaveCount(0);
    await expect(navigation).toBeVisible();
    await page.reload();
    const after = await detail(request, before.chat.id);
    expect(after.sources[0].text).toBe(revised);
    expect(after.runs).toEqual(before.runs);
    await scene.getByRole('button', { name: '원문 수정', exact: true }).click();
    await field.fill('저장하지 않을 수정');
    await expect(navigation).toBeVisible({ visible: width > 760 });
    await expectReachable(cancel);
    await cancel.click();
    await expect(field).toHaveCount(0);
    await expect(navigation).toBeVisible();
    expect((await detail(request, before.chat.id)).sources[0].text).toBe(revised);
    expect(calls).toBe(1);
  });
}

test('SREV a late proposal cannot overwrite edits or an edit reverted to its original text', async ({
  page,
  request,
}) => {
  const before = await seed(request);
  const started = gate(),
    released = gate(),
    finished = gate();
  await page.route(endpoint, async (route) => {
    started.release();
    await released.promise;
    await route.fulfill({ json: { text: proposal } });
    finished.release();
  });
  try {
    await page.goto(`/?chat=${before.chat.id}`);
    await page.getByRole('button', { name: '원문 수정', exact: true }).click();
    const field = page.getByRole('textbox', { name: '원문 수정 내용', exact: true });
    await choose(field);
    await page.getByRole('button', { name: '선택 구절 퇴고', exact: true }).click();
    await page.getByLabel('퇴고 요청', { exact: true }).fill('감정을 행동으로 보여줘.');
    await page.getByRole('button', { name: '퇴고 제안 받기', exact: true }).click();
    await started.promise;
    await field.fill('새로 작성한 초안');
    await field.fill(original);
    await choose(field);
    released.release();
    await finished.promise;
    await expect(page.getByTestId('selection-revision-proposal')).toHaveText(proposal);
    await expect(
      page.getByRole('button', { name: '선택 구간에 반영', exact: true })
    ).toBeDisabled();
    await expect(field).toHaveValue(original);
    expect((await detail(request, before.chat.id)).sources[0].text).toBe(original);
  } finally {
    released.release();
  }
});

test('SREV cancelling a pending preflight allows immediate retry and ignores the older response', async ({
  page,
  request,
}) => {
  const before = await seed(request);
  const started = gate(),
    released = gate(),
    finished = gate();
  let calls = 0;
  let preflights = 0;
  await page.route(endpoint, (route) => {
    calls++;
    expect(route.request().postDataJSON().instruction).toBe(
      '두 번째 요청: 감정을 행동으로 보여줘.'
    );
    return route.fulfill({ json: { text: proposal } });
  });
  await page.route('**/api/chats/*/codex-content-preflight', async (route) => {
    expect(route.request().postDataJSON()).toMatchObject({
      role: 'selection-revision',
      selection: selected,
    });
    preflights++;
    if (preflights === 1) {
      started.release();
      await released.promise;
      await route.fulfill({ json: { warning: false } });
      finished.release();
    } else await route.fulfill({ json: { warning: true } });
  });
  try {
    await page.goto(`/?chat=${before.chat.id}`);
    await page.getByRole('button', { name: '원문 수정', exact: true }).click();
    const field = page.getByRole('textbox', { name: '원문 수정 내용', exact: true });
    await choose(field);
    await page.getByRole('button', { name: '선택 구절 퇴고', exact: true }).click();
    await page.getByLabel('퇴고 요청', { exact: true }).fill('감정을 행동으로 보여줘.');
    await page.getByRole('button', { name: '퇴고 제안 받기', exact: true }).click();
    await started.promise;
    await page.getByRole('button', { name: '퇴고 요청 취소', exact: true }).click();
    await page
      .getByRole('textbox', { name: '퇴고 요청', exact: true })
      .fill('두 번째 요청: 감정을 행동으로 보여줘.');
    await page.getByRole('button', { name: '퇴고 제안 받기', exact: true }).click();
    const warning = page.getByRole('alertdialog', { name: 'Codex에서 거절될 수 있어요' });
    await expect(warning).toBeVisible();
    expect(preflights).toBe(2);
    released.release();
    await finished.promise;
    await expect(warning).toBeVisible();
    expect(calls).toBe(0);
    await warning.getByRole('button', { name: '그래도 Codex로 전송', exact: true }).click();
    await expect(page.getByTestId('selection-revision-proposal')).toHaveText(proposal);
    await expect(field).toHaveValue(original);
    expect(calls).toBe(1);
  } finally {
    released.release();
  }
});
