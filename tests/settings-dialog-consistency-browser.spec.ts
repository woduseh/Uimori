import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { ContextDetail } from '../core/context-plan.js';
import type { StoryDetail } from '../core/story.js';
import type { ThemeCatalog } from '../core/themes.js';
import { defaultThemeBackground } from '../core/theme-background.js';
import { postFixtureChat } from './fixtures/chat.js';
import { preservePromptWorkspace } from './fixtures/prompt-workspace.js';
import { setGlobalBackgroundImage } from './fixtures/theme-background.js';
import {
  createPromptChoice,
  navigationAction,
  openChatSettings,
  selectChatSettingsSection,
  selectSettingsSection,
  setCurrentModels,
} from './ui-navigation.js';

async function read<T>(request: APIRequestContext, path: string): Promise<T> {
  const response = await request.get(`/api${path}`);
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

async function expectShell(page: Page, dialog: Locator, preferredWidth: number) {
  await expect(dialog).toBeVisible();
  const viewport = page.viewportSize()!;
  const gap = viewport.width <= 760 ? 16 : 24;
  await expect
    .poll(async () => {
      const box = await dialog.boundingBox();
      return box ? Math.round(box.width) : null;
    })
    .toBe(Math.min(preferredWidth, viewport.width - 2 * gap));
  const box = (await dialog.boundingBox())!;
  expect(Math.abs(box.x + box.width / 2 - viewport.width / 2)).toBeLessThanOrEqual(1);
  expect(Math.abs(box.y + box.height / 2 - viewport.height / 2)).toBeLessThanOrEqual(1);
  expect(box.y).toBeGreaterThanOrEqual(gap - 1);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height - gap + 1);
  expect(await dialog.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(
    1
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true
  );
}

async function expectPrimary(button: Locator, cancel?: Locator) {
  await button.page().mouse.move(0, 0);
  const colors = await button.evaluate((node) => {
    const actual = getComputedStyle(node);
    const expected = document.createElement('span').style;
    expected.backgroundColor = actual.getPropertyValue('--accent');
    expected.color = actual.getPropertyValue('--accent-ink');
    return {
      actual: [actual.backgroundColor, actual.color],
      expected: [expected.backgroundColor, expected.color],
    };
  });
  expect(colors.actual).toEqual(colors.expected);
  if (cancel) {
    const backgrounds = await Promise.all(
      [button, cancel].map((locator) =>
        locator.evaluate((node) => getComputedStyle(node).backgroundColor)
      )
    );
    expect(backgrounds[0]).not.toBe(backgrounds[1]);
  }
}

for (const [width, height] of [
  [1440, 900],
  [2560, 1440],
] as const) {
  test(`SDC02 ${width} settings dialogs take the large desktop shell and a nested confirmation keeps its own`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width, height });
    const expected = {
      width: Math.round(Math.min(1180, width * 0.92)),
      height: Math.round(Math.min(820, height * 0.88)),
    };
    const expectLarge = async (dialog: Locator) => {
      await expect(dialog).toBeVisible();
      const box = (await dialog.boundingBox())!;
      expect(Math.abs(box.width - expected.width)).toBeLessThanOrEqual(1);
      expect(Math.abs(box.height - expected.height)).toBeLessThanOrEqual(1);
      expect(Math.abs(box.x + box.width / 2 - width / 2)).toBeLessThanOrEqual(1);
    };
    await page.goto('/');
    await navigationAction(page, '설정');
    const settings = page.getByRole('dialog', { name: '설정', exact: true });
    await expectLarge(settings);
    await selectSettingsSection(page, '테마와 색상');
    const preview = settings.getByRole('region', { name: '현재 테마로 예문 보기', exact: true });
    const controls = settings.locator('.theme-settings-controls');
    await expect(preview.locator('[data-uimori-part="scene-frame"]')).toBeVisible();
    expect((await preview.boundingBox())!.x).toBeGreaterThan(
      (await controls.boundingBox())!.x + (await controls.boundingBox())!.width
    );
    {
      const advanced = page.locator('.theme-advanced:not([open]) > summary');
      if (await advanced.isVisible()) await advanced.click();
    }
    await settings.getByRole('button', { name: '새 커스텀 테마', exact: true }).click();
    await settings.getByLabel('테마 이름', { exact: true }).fill(`Large shell ${width}`);
    await settings.locator('.theme-colors').scrollIntoViewIfNeeded();
    const scroller = (await settings.locator('.settings-page:not([hidden])').boundingBox())!;
    const pinned = (await preview.boundingBox())!;
    expect(pinned.y).toBeGreaterThanOrEqual(scroller.y - 1);
    expect(pinned.y + pinned.height).toBeLessThanOrEqual(scroller.y + scroller.height + 1);
    await settings.getByRole('button', { name: '설정 닫기', exact: true }).click();
    const guard = page.getByRole('alertdialog', { name: '미저장 설정 확인', exact: true });
    await expectShell(page, guard, 620);
    expect((await guard.boundingBox())!.height).toBeLessThan(expected.height);
    await guard.getByRole('button', { name: '초안 버리고 닫기', exact: true }).click();
    await expect(settings).toBeHidden();

    const created = await postFixtureChat(request, { data: { title: `Large shell ${width}` } });
    expect(created.ok(), await created.text()).toBe(true);
    await page.goto(`/?chat=${(await created.json()).id}`);
    await openChatSettings(page);
    await expectLarge(page.getByRole('dialog', { name: '채팅 설정', exact: true }));
  });
}

for (const width of [412]) {
  test(`SDC01 ${width} theme deletion is compact, safely focused and cancellable before confirmation`, async ({
    page,
    request,
  }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await navigationAction(page, '설정');
    await selectSettingsSection(page, '테마와 색상');
    {
      const advanced = page.locator('.theme-advanced:not([open]) > summary');
      if (await advanced.isVisible()) await advanced.click();
    }
    const settings = page.getByRole('dialog', { name: '설정', exact: true });
    await expectShell(page, settings, 1160);
    await expect(settings.locator('details.theme-sample')).toHaveCount(1);
    const title = `Dialog consistency theme ${width}`;
    await page.getByRole('button', { name: '새 커스텀 테마', exact: true }).click();
    await page.getByLabel('테마 이름', { exact: true }).fill(title);
    await page.getByRole('button', { name: '테마 저장', exact: true }).click();
    await expect(page.getByRole('button', { name: '테마 저장', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '편집 취소', exact: true }).click();
    const menu = page.getByLabel(`${title} 관리`, { exact: true });
    const trigger = page.getByRole('button', { name: `${title} 삭제`, exact: true });
    const dialog = page.getByRole('alertdialog', { name: '테마 삭제', exact: true });
    const cancel = dialog.getByRole('button', { name: '취소', exact: true });
    const remove = dialog.getByRole('button', { name: '삭제', exact: true });
    const catalog = await read<ThemeCatalog>(request, '/themes');
    const theme = catalog.themes.find((item) => item.title === title)!;
    expect(theme).toBeDefined();
    const deleted: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'DELETE' && request.url().endsWith(`/api/themes/${theme.id}`))
        deleted.push(request.url());
    });

    for (const dismissal of ['cancel', 'Escape', 'backdrop'] as const) {
      await menu.click();
      await trigger.click();
      await expectShell(page, dialog, 620);
      await expect(cancel).toBeFocused();
      await expect(cancel).toHaveClass(/\bsecondary\b/);
      await expect(remove).toHaveClass(/\bdelete-button\b/);
      await expect(remove).not.toHaveClass(/\bsecondary\b/);
      await expect(dialog.locator('.form-actions > button')).toHaveText(['취소', '삭제']);
      if (dismissal === 'cancel') {
        await page.keyboard.press('Tab');
        await expect(remove).toBeFocused();
        await page.keyboard.press('Tab');
        await expect(
          dialog.getByRole('button', { name: '테마 삭제 닫기', exact: true })
        ).toBeFocused();
        await page.keyboard.press('Shift+Tab');
        await expect(remove).toBeFocused();
        await cancel.focus();
        await page.screenshot({ path: info.outputPath(`theme-delete-${width}.png`) });
        await page.keyboard.press('Enter');
      } else if (dismissal === 'Escape') await page.keyboard.press('Escape');
      else await page.mouse.click(4, 4);
      await expect(dialog).toBeHidden();
      await expect(settings).toBeVisible();
      await expect(menu).toBeFocused();
      expect(deleted).toEqual([]);
      expect(
        (await read<ThemeCatalog>(request, '/themes')).themes.some((item) => item.id === theme.id)
      ).toBe(true);
    }

    await page.route(`**/api/themes/${theme.id}`, (route) =>
      route.fulfill({ status: 503, json: { error: 'Synthetic theme delete failure' } })
    );
    await menu.click();
    await trigger.click();
    await remove.click();
    await expect(dialog.getByRole('alert')).toContainText('(503)');
    await expect(cancel).toBeEnabled();
    expect(
      (await read<ThemeCatalog>(request, '/themes')).themes.some((item) => item.id === theme.id)
    ).toBe(true);
    await page.unroute(`**/api/themes/${theme.id}`);
    await remove.click();
    await expect(dialog).toBeHidden();
    await expect(trigger).toHaveCount(0);
    await expect(settings).toBeVisible();
    expect(
      (await read<ThemeCatalog>(request, '/themes')).themes.some((item) => item.id === theme.id)
    ).toBe(false);
    expect(deleted).toHaveLength(2);
    await selectSettingsSection(page, '일반');
    await expect(settings.getByLabel('앱 화면 테마')).toBeVisible();
  });

  test(`SDC04 ${width} background, summary and note saves have primary emphasis and preserve cancelled edits`, async ({
    page,
    request,
  }, info) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width, height: 900 });
    const originalBackground =
      (await read<ThemeCatalog>(request, '/themes')).preferences.defaultBackground ??
      defaultThemeBackground;
    try {
      await setGlobalBackgroundImage(request);
      const before = await read<ThemeCatalog>(request, '/themes');
      await page.goto('/');
      await navigationAction(page, '설정');
      await selectSettingsSection(page, '테마와 색상');
      {
        const advanced = page.locator('.theme-advanced:not([open]) > summary');
        if (await advanced.isVisible()) await advanced.click();
      }
      const background = page.getByRole('region', { name: '본문 바깥 배경', exact: true });
      const effects = background.getByRole('group', { name: '배경 효과', exact: true });
      await expect(effects.getByRole('slider')).toHaveCount(3);
      const fileBox = (await background.getByLabel('배경 이미지 선택').boundingBox())!;
      const effectsBox = (await effects.boundingBox())!;
      expect(effectsBox.y).toBeGreaterThan(fileBox.y + fileBox.height);
      const sliderBoxes = await Promise.all(
        (await effects.getByRole('slider').all()).map((slider) => slider.boundingBox())
      );
      if (width > 760) {
        for (const box of sliderBoxes.slice(1))
          expect(Math.abs(box!.y - sliderBoxes[0]!.y)).toBeLessThanOrEqual(1);
      } else {
        expect(sliderBoxes[1]!.y).toBeGreaterThan(sliderBoxes[0]!.y + sliderBoxes[0]!.height);
        expect(sliderBoxes[2]!.y).toBeGreaterThan(sliderBoxes[1]!.y + sliderBoxes[1]!.height);
      }
      await background.scrollIntoViewIfNeeded();
      await page.screenshot({ path: info.outputPath(`background-grouped-${width}.png`) });
      const blur = page.getByLabel('배경 흐림', { exact: true });
      const original = await blur.inputValue();
      const changed = original === '7' ? '8' : '7';
      await blur.fill(changed);
      const backgroundSave = page.getByRole('button', { name: '배경 저장', exact: true });
      const backgroundCancel = page.getByRole('button', { name: '배경 변경 취소', exact: true });
      await expectPrimary(backgroundSave, backgroundCancel);
      await expect(backgroundSave).toBeEnabled();
      await backgroundCancel.click();
      await expect(blur).toHaveValue(original);
      await expect(backgroundSave).toBeDisabled();
      expect((await read<ThemeCatalog>(request, '/themes')).preferences).toEqual(
        before.preferences
      );
      await blur.fill(changed);
      await backgroundSave.click();
      await expect(backgroundSave).toBeDisabled();
      await expect(page.getByText('배경 설정을 저장했어요.', { exact: true })).toBeVisible();
      expect(
        (await read<ThemeCatalog>(request, '/themes')).preferences.defaultBackground?.blur
      ).toBe(Number(changed));
      await page.reload();
      await navigationAction(page, '설정');
      await selectSettingsSection(page, '테마와 색상');
      {
        const advanced = page.locator('.theme-advanced:not([open]) > summary');
        if (await advanced.isVisible()) await advanced.click();
      }
      await expect(blur).toHaveValue(changed);
    } finally {
      const current = await read<ThemeCatalog>(request, '/themes');
      const restored = await request.post('/api/themes/background', {
        data: {
          scope: 'global',
          background: originalBackground,
          expectedRevision: current.preferences.revision,
        },
      });
      expect(restored.ok(), await restored.text()).toBe(true);
    }

    await createPromptChoice(request, `Save emphasis ${width}`);
    const connectionResponse = await request.post('/api/connections', {
      data: {
        title: `Save emphasis ${width}`,
        protocol: 'fixture-sse-v1',
        endpoint: 'http://127.0.0.1:9/not-called',
        enabled: true,
      },
    });
    expect(connectionResponse.ok(), await connectionResponse.text()).toBe(true);
    const connection = await connectionResponse.json();
    const modelResponse = await request.post('/api/model-presets', {
      data: {
        title: `Save emphasis ${width}`,
        connectionId: connection.id,
        modelId: 'synthetic-settings-main',
        inputTokenLimit: 8192,
        maxOutputTokens: 1000,
        temperature: null,
      },
    });
    expect(modelResponse.ok(), await modelResponse.text()).toBe(true);
    const model = await modelResponse.json();
    await setCurrentModels(request, { main: { id: model.id } });
    const created = await postFixtureChat(request, { data: { title: `Save emphasis ${width}` } });
    expect(created.ok(), await created.text()).toBe(true);
    const chat = await created.json();
    await page.goto(`/?chat=${chat.id}`);
    await openChatSettings(page);
    await selectChatSettingsSection(page, '기억과 메모');
    const panel = page.getByTestId('context-panel');
    await panel.getByRole('button', { name: '직접 요약 작성', exact: true }).click();
    const summary = panel.getByLabel('편집할 컨텍스트 요약', { exact: true });
    await summary.fill('Cancelled summary draft');
    const summaryForm = panel.locator('.context-summary-editor');
    const summarySave = summaryForm.getByRole('button', { name: '요약 저장', exact: true });
    const summaryCancel = summaryForm.getByRole('button', { name: '편집 취소', exact: true });
    await expectPrimary(summarySave, summaryCancel);
    await summaryCancel.click();
    expect((await read<ContextDetail>(request, `/chats/${chat.id}/context`)).checkpoint).toBeNull();
    await panel.getByRole('button', { name: '직접 요약 작성', exact: true }).click();
    await expect(summary).toHaveValue('');
    await summary.fill('Saved synthetic summary');
    await summarySave.click();
    await expect(panel.getByTestId('context-summary-text')).toHaveText('Saved synthetic summary');
    expect(
      (await read<ContextDetail>(request, `/chats/${chat.id}/context`)).checkpoint?.plan.summary
    ).toBe('Saved synthetic summary');

    const notes = panel.getByTestId('context-notes');
    await notes.locator(':scope > summary').click();
    await notes.getByRole('button', { name: '메모 추가', exact: true }).click();
    await notes
      .getByRole('textbox', { name: '메모와 정정 내용', exact: true })
      .fill('Cancelled note draft');
    const noteCancel = notes.getByRole('button', { name: '편집 취소', exact: true });
    await expectPrimary(
      notes.getByRole('button', { name: '새 메모 저장', exact: true }),
      noteCancel
    );
    await noteCancel.click();
    expect((await read<StoryDetail>(request, `/chats/${chat.id}/story`)).notes).toEqual([]);
    await notes.getByRole('button', { name: '메모 추가', exact: true }).click();
    await expect(notes.getByRole('textbox', { name: '메모와 정정 내용', exact: true })).toHaveValue(
      ''
    );
    await notes
      .getByRole('textbox', { name: '메모와 정정 내용', exact: true })
      .fill('Saved synthetic note');
    await notes.getByRole('button', { name: '새 메모 저장', exact: true }).click();
    await expect(notes.getByText('Saved synthetic note', { exact: true })).toBeVisible();
    await notes
      .getByRole('button', { name: '메모 수정: Saved synthetic note', exact: true })
      .click();
    const noteSave = notes.getByRole('button', { name: '메모 수정 저장', exact: true });
    await expectPrimary(noteSave, noteCancel);
    await notes
      .getByRole('textbox', { name: '메모와 정정 내용', exact: true })
      .fill('Cancelled note change');
    await noteCancel.click();
    expect(
      (await read<StoryDetail>(request, `/chats/${chat.id}/story`)).notes.map((note) => note.text)
    ).toEqual(['Saved synthetic note']);
    await notes
      .getByRole('button', { name: '메모 수정: Saved synthetic note', exact: true })
      .click();
    await notes
      .getByRole('textbox', { name: '메모와 정정 내용', exact: true })
      .fill('Updated synthetic note');
    await noteSave.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`note-primary-save-${width}.png`) });
    await noteSave.click();
    await expect(notes.getByText('Updated synthetic note', { exact: true })).toBeVisible();
    await page.reload();
    await openChatSettings(page);
    await selectChatSettingsSection(page, '기억과 메모');
    await expect(panel.getByTestId('context-summary-text')).toHaveText('Saved synthetic summary');
    await notes.locator(':scope > summary').click();
    await expect(notes.getByText('Updated synthetic note', { exact: true })).toBeVisible();
  });
}

preservePromptWorkspace();
