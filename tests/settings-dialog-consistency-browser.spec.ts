import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import sharp from 'sharp';
import type { ContextDetail } from '../core/context-plan.js';
import type { StoryDetail } from '../core/story.js';
import type { ThemeCatalog } from '../core/themes.js';
import { defaultThemeBackground } from '../core/theme-background.js';
import { postFixtureChat } from './fixtures/chat.js';
import { createReadingChat } from './fixtures/personal-workspace.js';
import { preservePromptWorkspace } from './fixtures/prompt-workspace.js';
import {
  createPromptChoice,
  navigationAction,
  openChatSettings,
  openSourceActions,
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

for (const width of [412, 1440]) {
  test(`SDC01 ${width} theme deletion is compact, safely focused and cancellable before confirmation`, async ({
    page,
    request,
  }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await navigationAction(page, '설정');
    await selectSettingsSection(page, '테마·색상');
    const settings = page.getByRole('dialog', { name: '설정', exact: true });
    await expectShell(page, settings, 1160);
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
      await expectShell(page, dialog, 480);
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

    // A failed request remains a reviewable confirmation, and a deliberate retry deletes once.
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

  test(`SDC02 ${width} generic nested prompt dialogs keep independent widths across three modal layers`, async ({
    page,
    request,
  }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const choice = await createPromptChoice(request, `Nested consistency ${width}`);
    await page.goto('/');
    await navigationAction(page, '설정');
    await selectSettingsSection(page, '현재 프롬프트');
    const settings = page.getByRole('dialog', { name: '설정', exact: true });
    const section = page.getByRole('region', { name: '현재 프롬프트 설정', exact: true });
    await section.locator('summary').filter({ hasText: '창작 옵션' }).click();
    const menu = section.getByLabel('옵션 조합 메뉴', { exact: true });
    await menu.click();
    await section
      .getByRole('button', { name: '현재 선택을 새 조합으로 저장', exact: true })
      .click();
    const save = page.getByRole('dialog', { name: '옵션 조합 저장', exact: true });
    await expectShell(page, save, 480);
    await save.getByLabel('조합 이름', { exact: true }).fill('Cancelled nested combination');
    await save.getByRole('button', { name: '취소', exact: true }).click();
    await expect(save).toBeHidden();
    await expectShell(page, settings, 1160);
    await menu.click();
    await section.getByRole('button', { name: '조합 관리', exact: true }).click();
    const manage = page.getByRole('dialog', { name: '옵션 조합 관리', exact: true });
    await expectShell(page, manage, 480);
    const trigger = manage.getByRole('button', {
      name: `${choice.combination.title} 삭제`,
      exact: true,
    });
    await trigger.click();
    const remove = page.getByRole('alertdialog', { name: '삭제 확인', exact: true });
    await expectShell(page, remove, 480);
    await page.screenshot({ path: info.outputPath(`nested-prompt-delete-${width}.png`) });
    await page.keyboard.press('Escape');
    await expect(remove).toBeHidden();
    await expect(manage).toBeVisible();
    await expect(trigger).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(manage).toBeHidden();
    await expect(settings).toBeVisible();
    await expectShell(page, settings, 1160);
  });

  test(`SDC03 ${width} chat picker and confirmation widths survive nesting while image metadata saves stay primary`, async ({
    page,
    request,
  }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const { chat, detail } = await createReadingChat(
      request,
      `Chat dialog consistency ${width}`,
      1
    );
    const image = await sharp({
      create: { width: 80, height: 80, channels: 3, background: '#6688aa' },
    })
      .png()
      .toBuffer();
    const uploaded = await request.post(`/api/chats/${chat.id}/assets`, {
      data: {
        title: 'Synthetic metadata image',
        description: 'Synthetic square',
        actor: '',
        outfit: '',
        location: '',
        allowedUse: 'both',
        mime: 'image/png',
        base64: image.toString('base64'),
      },
    });
    expect(uploaded.ok(), await uploaded.text()).toBe(true);
    const asset = await uploaded.json();
    await page.goto(`/?chat=${chat.id}`);
    await openChatSettings(page);
    const settings = page.getByRole('dialog', { name: '채팅 설정', exact: true });
    await expectShell(page, settings, 1160);
    await selectChatSettingsSection(page, '대화 구성');
    const pickerTrigger = page.getByRole('button', { name: '페르소나', exact: true });
    await pickerTrigger.click();
    const picker = page.getByRole('dialog', { name: '페르소나', exact: true });
    await expectShell(page, picker, 640);
    await page.screenshot({ path: info.outputPath(`nested-picker-${width}.png`) });
    await page.keyboard.press('Escape');
    await expect(picker).toBeHidden();
    await expect(pickerTrigger).toBeFocused();

    await selectChatSettingsSection(page, '이미지');
    await page.locator('.chat-settings-image-management > summary').click();
    await page.getByText('이름·설명 편집', { exact: true }).click();
    const metadataSave = page.getByRole('button', { name: '이미지 정보 저장', exact: true });
    await expectPrimary(metadataSave);
    await page.getByLabel('업로드 이미지 이름', { exact: true }).fill('Saved metadata image');
    const metadataResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/chats/${chat.id}/assets/${asset.id}`) &&
        response.request().method() === 'PATCH'
    );
    await metadataSave.click();
    const saved = await metadataResponse;
    expect(saved.ok(), await saved.text()).toBe(true);
    expect(await saved.json()).toMatchObject({ title: 'Saved metadata image' });
    const imageTrigger = page.getByRole('button', {
      name: 'Saved metadata image 이미지 삭제',
      exact: true,
    });
    await imageTrigger.click();
    const remove = page.getByRole('alertdialog', { name: '삭제 확인', exact: true });
    await expectShell(page, remove, 480);
    await page.screenshot({ path: info.outputPath(`nested-image-delete-${width}.png`) });
    await remove.getByRole('button', { name: '취소', exact: true }).click();
    await expect(remove).toBeHidden();
    await expect(imageTrigger).toBeFocused();

    await selectChatSettingsSection(page, '자동 작업');
    const limit = page.getByLabel('작업당 모델 호출 한도', { exact: true });
    const original = await limit.inputValue();
    await limit.fill(original === '21' ? '22' : '21');
    await settings.getByRole('button', { name: '채팅 설정 닫기', exact: true }).click();
    const confirmation = page.getByRole('alertdialog', {
      name: '미저장 채팅 설정 확인',
      exact: true,
    });
    await expectShell(page, confirmation, 620);
    await page.screenshot({ path: info.outputPath(`nested-confirmation-${width}.png`) });
    await confirmation.getByRole('button', { name: '계속 편집', exact: true }).click();
    await expect(confirmation).toBeHidden();
    await expect(limit).toHaveValue(original === '21' ? '22' : '21');
    await settings.getByRole('button', { name: '채팅 설정 닫기', exact: true }).click();
    await confirmation.getByRole('button', { name: '초안 버리고 닫기', exact: true }).click();
    await expect(settings).toBeHidden();
    await openChatSettings(page);
    await selectChatSettingsSection(page, '자동 작업');
    await expect(limit).toHaveValue(original);
    await selectChatSettingsSection(page, '이미지');
    await page.locator('.chat-settings-image-management > summary').click();
    await page.getByText('이름·설명 편집', { exact: true }).click();
    await expect(page.getByLabel('업로드 이미지 이름', { exact: true })).toHaveValue(
      'Saved metadata image'
    );
    await settings.getByRole('button', { name: '채팅 설정 닫기', exact: true }).click();
    await expect(settings).toBeHidden();
    const source = page.getByTestId('source').first();
    const sourceMenu = await openSourceActions(source);
    await source.getByRole('button', { name: /^(원문 연결 정보|작업 상세)$/ }).click();
    const sourceInfo = page.getByRole('dialog', { name: /^(원문 연결 정보|작업 상세)$/ });
    await expectShell(page, sourceInfo, 620);
    await sourceInfo.getByText('현재 원문', { exact: true }).click();
    await expect(sourceInfo.getByTestId('source-raw')).toHaveText(detail.sources[0].text);
    await page.screenshot({ path: info.outputPath(`source-info-${width}.png`) });
    await page.keyboard.press('Escape');
    await expect(sourceInfo).toBeHidden();
    await expect(sourceMenu).toBeFocused();
  });

  test(`SDC04 ${width} background, summary and note saves have primary emphasis and preserve cancelled edits`, async ({
    page,
    request,
  }, info) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width, height: 900 });
    const before = await read<ThemeCatalog>(request, '/themes');
    const originalBackground = before.preferences.defaultBackground ?? defaultThemeBackground;
    try {
      await page.goto('/');
      await navigationAction(page, '설정');
      await selectSettingsSection(page, '테마·색상');
      const background = page.getByRole('region', { name: '배경 이미지', exact: true });
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
      await selectSettingsSection(page, '테마·색상');
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

    // Summary budgeting uses a local fixture model; no generation or external request is made.
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
    await selectChatSettingsSection(page, '기억·로어');
    const panel = page.getByTestId('context-panel');
    await panel.getByRole('button', { name: '요약 작성', exact: true }).click();
    const summary = panel.getByLabel('편집할 컨텍스트 요약', { exact: true });
    await summary.fill('Cancelled summary draft');
    const summaryForm = panel.locator('.context-summary-editor');
    const summarySave = summaryForm.getByRole('button', { name: '요약 저장', exact: true });
    const summaryCancel = summaryForm.getByRole('button', { name: '편집 취소', exact: true });
    await expectPrimary(summarySave, summaryCancel);
    await summaryCancel.click();
    expect((await read<ContextDetail>(request, `/chats/${chat.id}/context`)).checkpoint).toBeNull();
    await panel.getByRole('button', { name: '요약 작성', exact: true }).click();
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
      .getByRole('textbox', { name: '메모·정정 내용', exact: true })
      .fill('Cancelled note draft');
    const noteCancel = notes.getByRole('button', { name: '편집 취소', exact: true });
    await expectPrimary(
      notes.getByRole('button', { name: '새 메모 저장', exact: true }),
      noteCancel
    );
    await noteCancel.click();
    expect((await read<StoryDetail>(request, `/chats/${chat.id}/story`)).notes).toEqual([]);
    await notes.getByRole('button', { name: '메모 추가', exact: true }).click();
    await expect(notes.getByRole('textbox', { name: '메모·정정 내용', exact: true })).toHaveValue(
      ''
    );
    await notes
      .getByRole('textbox', { name: '메모·정정 내용', exact: true })
      .fill('Saved synthetic note');
    await notes.getByRole('button', { name: '새 메모 저장', exact: true }).click();
    await expect(notes.getByText('Saved synthetic note', { exact: true })).toBeVisible();
    await notes
      .getByRole('button', { name: '메모 수정: Saved synthetic note', exact: true })
      .click();
    const noteSave = notes.getByRole('button', { name: '메모 수정 저장', exact: true });
    await expectPrimary(noteSave, noteCancel);
    await notes
      .getByRole('textbox', { name: '메모·정정 내용', exact: true })
      .fill('Cancelled note change');
    await noteCancel.click();
    expect(
      (await read<StoryDetail>(request, `/chats/${chat.id}/story`)).notes.map((note) => note.text)
    ).toEqual(['Saved synthetic note']);
    await notes
      .getByRole('button', { name: '메모 수정: Saved synthetic note', exact: true })
      .click();
    await notes
      .getByRole('textbox', { name: '메모·정정 내용', exact: true })
      .fill('Updated synthetic note');
    await noteSave.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`note-primary-save-${width}.png`) });
    await noteSave.click();
    await expect(notes.getByText('Updated synthetic note', { exact: true })).toBeVisible();
    await page.reload();
    await openChatSettings(page);
    await selectChatSettingsSection(page, '기억·로어');
    await expect(panel.getByTestId('context-summary-text')).toHaveText('Saved synthetic summary');
    await notes.locator(':scope > summary').click();
    await expect(notes.getByText('Updated synthetic note', { exact: true })).toBeVisible();
  });
}

preservePromptWorkspace();
