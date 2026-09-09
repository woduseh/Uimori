import { visualReview } from './fixtures/visual-review.js';
import { openSourceActions } from './ui-navigation.js';
import { test, expect, type APIRequestContext, type Locator } from '@playwright/test';
import type { Chat, ChatDetail, Run } from '../core/types.js';
import { postFixtureChat } from './fixtures/chat.js';

async function detail(request: APIRequestContext, chatId: string): Promise<ChatDetail> {
  const response = await request.get(`/api/chats/${chatId}`);
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function seed(request: APIRequestContext, label: string) {
  const response = await postFixtureChat(request, {
    data: { title: `Synthetic source editor ${label}` },
  });
  expect(response.ok()).toBeTruthy();
  const chat = (await response.json()) as Chat;
  const settings = await request.patch(`/api/chats/${chat.id}/settings`, {
    data: {
      ...chat.settings,
      status: false,
      translation: false,
      expectedSettingsRevision: chat.settingsRevision,
    },
  });
  expect(settings.ok()).toBeTruthy();
  const current = (await settings.json()) as Chat;
  const started = await request.post(`/api/chats/${chat.id}/runs`, {
    data: {
      request: 'A synthetic scene for the source editor focus regression.',
      expectedRevision: null,
      expectedSettingsRevision: current.settingsRevision,
      idempotencyKey: `source-editor-${chat.id}`,
    },
  });
  expect(started.ok()).toBeTruthy();
  const run = (await started.json()) as Run;
  await expect
    .poll(
      async () => (await detail(request, chat.id)).runs.find((item) => item.id === run.id)?.status
    )
    .toBe('completed');
  const generated = await detail(request, chat.id);
  const source = generated.sources[0];
  const text = Array.from(
    { length: 40 },
    (_, index) =>
      `Synthetic paragraph ${index + 1}. The lighthouse keeper follows the quiet shoreline and records the changing light. This is public synthetic prose for a long reading viewport.`
  ).join('\n\n');
  const replaced = await request.put(`/api/sources/${source.id}/text`, {
    data: { text, expectedRevision: source.editRevision ?? 0 },
  });
  expect(replaced.ok()).toBeTruthy();
  return detail(request, chat.id);
}

async function insideReader(control: Locator) {
  await expect
    .poll(() =>
      control.evaluate((element) => {
        const reader = element.closest<HTMLElement>('[data-reader-scrollport]');
        if (!reader) return false;
        const bounds = element.getBoundingClientRect();
        const viewport = reader.getBoundingClientRect();
        const top = Math.max(viewport.top, window.visualViewport?.offsetTop ?? 0);
        const bottom = Math.min(
          viewport.bottom,
          (window.visualViewport?.offsetTop ?? 0) +
            (window.visualViewport?.height ?? window.innerHeight)
        );
        return bounds.height > 0 && bounds.top >= top - 1 && bounds.bottom <= bottom + 1;
      })
    )
    .toBe(true);
}

const readerOffset = (control: Locator) =>
  control.evaluate(
    (element) =>
      element.getBoundingClientRect().top -
      element.closest('[data-reader-scrollport]')!.getBoundingClientRect().top
  );

for (const [label, viewport] of [
  ['mobile', { width: 390, height: 844 }],
  ['desktop', { width: 1440, height: 900 }],
] as const) {
  test(`C04E ${label} long source editing focuses the visible editor and restores reading after Escape, cancel and save`, async ({
    page,
    request,
  }, info) => {
    const before = await seed(request, label);
    const source = before.sources[0];
    await page.setViewportSize(viewport);
    await page.goto(`/?chat=${before.chat.id}`);
    const scene = page.locator(`[data-source-id="${source.id}"][data-testid="source"]`);
    // Editing the current view starts from the footer button; the menu holds the other editor.
    const trigger = scene.getByRole('button', { name: '원문 수정', exact: true });
    const field = scene.getByRole('textbox', { name: '원문 수정 내용', exact: true });
    await expect(scene.getByTestId('source-text')).toContainText('Synthetic paragraph 40.');
    expect(
      await scene.getByTestId('source-text').evaluate((element) => {
        const reader = element.closest('[data-reader-scrollport]')!;
        return element.getBoundingClientRect().height > reader.getBoundingClientRect().height * 2;
      })
    ).toBe(true);

    await trigger.scrollIntoViewIfNeeded();
    const offset = await readerOffset(trigger);
    await trigger.click();
    await expect(field).toBeFocused();
    await insideReader(field);
    await field.fill('A cancelled synthetic edit.');
    await page.keyboard.press('Escape');
    await expect(field).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await insideReader(trigger);
    await expect
      .poll(async () => Math.abs((await readerOffset(trigger)) - offset))
      .toBeLessThan(16);

    await trigger.click();
    await expect(field).toBeFocused();
    await expect(field).toHaveValue(source.text);
    await insideReader(field);
    await field.fill('A second cancelled synthetic edit.');
    await scene.getByRole('button', { name: '수정 취소', exact: true }).click();
    await expect(field).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await insideReader(trigger);
    expect((await detail(request, before.chat.id)).sources[0].text).toBe(source.text);

    await trigger.click();
    await expect(field).toBeFocused();
    const edited = `${source.text}\n\nThe synthetic keeper returns to the lamp.`;
    await field.fill(edited);
    if (visualReview)
      await page.screenshot({ path: info.outputPath(`source-editor-${label}.png`) });
    await scene.getByRole('button', { name: '원문 저장', exact: true }).click();
    await expect(field).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await insideReader(trigger);
    await expect(scene.getByTestId('source-text')).toContainText('returns to the lamp.');
    const after = await detail(request, before.chat.id);
    expect(after.sources[0].text).toBe(edited);
    expect(after.runs).toEqual(before.runs);
    expect(after.attempts).toEqual(before.attempts);

    const opener = await openSourceActions(scene);
    await scene.getByRole('button', { name: '번역 수정', exact: true }).click();
    const translation = scene.getByRole('textbox', { name: '번역 수정 내용', exact: true });
    await expect(translation).toBeFocused();
    await insideReader(translation);
    await translation.fill('저장 버튼 배치를 확인하는 합성 번역이에요.');
    const translationSave = scene.getByRole('button', { name: '번역 저장', exact: true });
    const translationCancel = scene.getByRole('button', { name: '수정 취소', exact: true });
    for (const button of [translationSave, translationCancel]) {
      await expect(button.locator('svg')).toHaveCount(1);
      expect((await button.innerText()).trim()).toBe('');
      const bounds = await button.boundingBox();
      expect(bounds!.width).toBeGreaterThanOrEqual(44);
      expect(bounds!.height).toBeGreaterThanOrEqual(44);
    }
    if (visualReview)
      await page.screenshot({ path: info.outputPath(`translation-editor-${label}.png`) });
    await page.keyboard.press('Escape');
    await expect(translation).toHaveCount(0);
    await expect(opener).toBeFocused();
    await insideReader(opener);
    if (visualReview)
      await page.screenshot({ path: info.outputPath(`source-reading-restored-${label}.png`) });
  });
}

test('C04E failed source save keeps the draft available and a later save restores focus without generation', async ({
  page,
  request,
}) => {
  const before = await seed(request, 'failed save');
  const source = before.sources[0];
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/?chat=${before.chat.id}`);
  const scene = page.locator(`[data-source-id="${source.id}"][data-testid="source"]`);
  const trigger = scene.getByRole('button', { name: '원문 수정', exact: true });
  await trigger.click();
  const field = scene.getByRole('textbox', { name: '원문 수정 내용', exact: true });
  await expect(field).toBeFocused();
  await insideReader(field);
  const draft = `${source.text}\n\nPreserved after a synthetic save failure.`;
  await field.fill(draft);
  const path = `**/api/sources/${source.id}/text`;
  await page.route(path, (route) =>
    route.fulfill({ status: 503, json: { error: 'Synthetic source save unavailable.' } })
  );
  await scene.getByRole('button', { name: '원문 저장', exact: true }).click();
  await expect(scene.locator('.source-text-editor').getByRole('alert')).toContainText(
    '작성한 내용은 유지돼요.'
  );
  await expect(field).toHaveValue(draft);
  await expect(field).toBeEnabled();
  expect((await detail(request, before.chat.id)).sources[0].text).toBe(source.text);
  await page.unroute(path);
  await scene.getByRole('button', { name: '원문 저장', exact: true }).click();
  await expect(field).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await insideReader(trigger);
  const after = await detail(request, before.chat.id);
  expect(after.sources[0].text).toBe(draft);
  expect(after.runs).toEqual(before.runs);
  expect(after.attempts).toEqual(before.attempts);
});
