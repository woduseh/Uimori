import {
  MOBILE_WIDTH,
  MOBILE_HEIGHT,
  DESKTOP_WIDTH,
  DESKTOP_HEIGHT,
} from './fixtures/browser-viewports.js';
import { visualReview } from './fixtures/visual-review.js';
import { openSourceActions } from './ui-navigation.js';
import { test, expect, type APIRequestContext, type Locator } from '@playwright/test';
import type { Chat, ChatDetail, Run } from '../core/types.js';
import { postFixtureChat } from './fixtures/chat.js';
import { waitForNativeLayout } from './fixtures/native-message.js';

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

async function stableShell(control: Locator) {
  await expect
    .poll(() =>
      control.evaluate((element) => ({
        shellTop: element.closest('.app-shell')!.scrollTop,
        headerTop: document.querySelector('.workspace-header')!.getBoundingClientRect().top,
        documentTop: document.documentElement.scrollTop,
      }))
    )
    .toEqual({ shellTop: 0, headerTop: 0, documentTop: 0 });
}

async function insideReader(control: Locator) {
  await stableShell(control);
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
  ['mobile', { width: MOBILE_WIDTH, height: MOBILE_HEIGHT }],
  ['desktop', { width: DESKTOP_WIDTH, height: DESKTOP_HEIGHT }],
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
    const sourceBody = scene.getByTestId('source-text').locator('.risu-message-content');
    await expect(sourceBody).toContainText('Synthetic paragraph 40.');
    await sourceBody.evaluate((body) => {
      body.dataset.editFocusProbe = 'preserved';
    });
    await expect
      .poll(() =>
        scene.getByTestId('source-text').evaluate((element) => {
          const reader = element.closest('[data-reader-scrollport]')!;
          return element.getBoundingClientRect().height > reader.getBoundingClientRect().height * 2;
        })
      )
      .toBe(true);

    await trigger.scrollIntoViewIfNeeded();
    const offset = await readerOffset(trigger);
    await trigger.click();
    await expect(field).toBeFocused();
    await expect(scene.getByTestId('source-text')).toBeHidden();
    await insideReader(field);
    await field.fill('A cancelled synthetic edit.');
    await page.keyboard.press('Escape');
    await expect(field).toHaveCount(0);
    await expect(sourceBody).toHaveAttribute('data-edit-focus-probe', 'preserved');
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
    await expect(sourceBody).toContainText('returns to the lamp.');
    await waitForNativeLayout(scene.getByTestId('source-text'));
    await insideReader(trigger);
    const after = await detail(request, before.chat.id);
    expect(after.sources[0].text).toBe(edited);
    expect(after.runs).toEqual(before.runs);
    expect(after.attempts).toEqual(before.attempts);

    const opener = await openSourceActions(scene);
    await scene.getByRole('button', { name: '번역 수정', exact: true }).click();
    const translation = scene.getByRole('textbox', { name: '번역 수정 내용', exact: true });
    await expect(translation).toBeFocused();
    await expect(scene.getByTestId('source-text')).toBeHidden();
    await insideReader(translation);
    await translation.fill('저장 버튼 배치를 확인하는 합성 번역이에요.');
    const translationSave = scene.getByRole('button', { name: '번역 저장', exact: true });
    const translationCancel = scene.getByRole('button', { name: '수정 취소', exact: true });
    for (const button of [translationSave, translationCancel]) {
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
  await page.setViewportSize({ width: MOBILE_WIDTH, height: MOBILE_HEIGHT });
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

for (const [width, height, mode] of [
  [390, 844, 'light'],
  [320, 640, 'dark'],
] as const) {
  test(`C04E cinematic ${width}px long translation editing keeps the app shell still and restores its passage`, async ({
    page,
    request,
  }, info) => {
    const initial = await seed(request, `cinematic ${width}px`);
    const source = initial.sources[0];
    const translation = `${source.text}\n\n${source.text}\n\nTranslation end marker.`;
    const saved = await request.put(`/api/sources/${source.id}/translation`, {
      data: {
        text: translation,
        expectedRevision: source.translationRevision ?? 0,
        expectedSourceHash: source.hash,
      },
    });
    expect(saved.ok()).toBe(true);
    const catalog = await (await request.get('/api/themes')).json();
    const selected = await request.post('/api/themes/selection', {
      data: {
        scope: 'chat',
        targetId: initial.chat.id,
        themeId: 'builtin:cinematic',
        expectedRevision: catalog.preferences.revision,
      },
    });
    expect(selected.ok()).toBe(true);
    const before = await detail(request, initial.chat.id);
    await page.setViewportSize({ width, height });
    await page.addInitScript((mode) => {
      localStorage.setItem('uimori:theme', mode);
      localStorage.setItem('uimori:font', 'serif');
      localStorage.setItem('uimori:font-size', '24');
      localStorage.setItem('uimori:reading-language', 'translation');
    }, mode);
    await page.goto(`/?chat=${initial.chat.id}`);
    const scene = page.getByTestId('source');
    const body = scene.locator('[slot="body"][data-uimori-body-scroll]');
    const trigger = scene.getByRole('button', { name: '번역 수정', exact: true });
    const field = scene.getByRole('textbox', { name: '번역 수정 내용', exact: true });
    await expect(scene.getByTestId('translation-text')).toContainText('Translation end marker.');
    await waitForNativeLayout(scene.getByTestId('translation-text'));
    await body.evaluate((node) => {
      node.scrollTop = (node.scrollHeight - node.clientHeight) * 0.6;
    });
    // Start from a genuinely visible action, without asking Playwright to scroll app ancestors.
    await trigger.evaluate((button) => {
      const reader = button.closest<HTMLElement>('[data-reader-scrollport]')!;
      reader.scrollTop +=
        button.getBoundingClientRect().top -
        reader.getBoundingClientRect().top -
        reader.clientHeight / 2;
    });
    await insideReader(trigger);
    await expect
      .poll(() =>
        trigger.evaluate((button) => {
          const rect = button.getBoundingClientRect();
          return button.contains(
            document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
          );
        })
      )
      .toBe(true);
    const passageTop = await body.evaluate((node) => node.scrollTop);
    expect(passageTop).toBeGreaterThan(0);
    const offset = await readerOffset(trigger);
    for (const action of ['Escape', 'cancel', 'save'] as const) {
      await trigger.click();
      await expect(field).toBeFocused();
      await expect(field).toHaveValue(translation);
      await insideReader(field);
      await expect
        .poll(() =>
          field.evaluate((node) => {
            const body = node.closest('[data-uimori-body-scroll]')!.getBoundingClientRect();
            const field = node.getBoundingClientRect();
            return field.top >= body.top - 1 && field.top < body.bottom;
          })
        )
        .toBe(true);
      await field.fill(`${translation}\n\nA temporary revision.`);
      if (visualReview && action === 'Escape')
        await page.screenshot({ path: info.outputPath(`cinematic-editor-${width}.png`) });
      if (action === 'Escape') await page.keyboard.press('Escape');
      else
        await scene
          .getByRole('button', {
            name: action === 'cancel' ? '수정 취소' : '번역 저장',
            exact: true,
          })
          .click();
      await expect(field).toHaveCount(0);
      await expect(trigger).toBeFocused();
      await insideReader(trigger);
      await expect
        .poll(async () => Math.abs((await readerOffset(trigger)) - offset))
        .toBeLessThan(16);
      await expect
        .poll(async () => Math.abs((await body.evaluate((node) => node.scrollTop)) - passageTop))
        .toBeLessThan(2);
      const current = await detail(request, initial.chat.id);
      expect(current.sources.map(({ id, text, hash }) => ({ id, text, hash }))).toEqual(
        before.sources.map(({ id, text, hash }) => ({ id, text, hash }))
      );
      expect(current.runs).toEqual(before.runs);
      expect(current.attempts).toEqual(before.attempts);
      if (action !== 'save') {
        expect(current.sources).toEqual(before.sources);
        expect(current.jobs).toEqual(before.jobs);
      } else {
        const latest = current.jobs
          .filter((job) => job.kind === 'translation' && job.sourceRevision === source.id)
          .sort((a, b) => (b.revision ?? 0) - (a.revision ?? 0))[0];
        expect(latest.result?.text).toBe(`${translation}\n\nA temporary revision.`);
      }
    }
    await expect(page.getByLabel('다음 장면 요청', { exact: true })).toBeVisible();
    if (visualReview)
      await page.screenshot({ path: info.outputPath(`cinematic-editor-restored-${width}.png`) });
  });
}
