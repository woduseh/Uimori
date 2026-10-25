import { test, expect } from '@playwright/test';
import { postFixtureChat } from './fixtures/chat.js';
import { nativePrompt } from './fixtures/native-prompt.js';
import {
  navigationAction,
  openChatMenu,
  openChatSettings,
  selectChatSettingsSection,
  selectSettingsSection,
} from './ui-navigation.js';

for (const width of [1440, 412]) {
  test(`SCUISEARCHCHAT search navigates real chat settings and preserves drafts at ${width}px`, async ({
    page,
    request,
  }, info) => {
    const created = await postFixtureChat(request, {
      data: { title: `설정 검색 합성 채팅 ${width}` },
    });
    expect(created.ok()).toBe(true);
    const chat = await created.json();
    // The shipped main preset declares variables; pin an authored empty preset for this case.
    const presetResponse = await request.post('/api/prompt-presets', {
      data: { title: `검색 합성 빈 변수 프롬프트 ${width}`, role: 'main', program: nativePrompt() },
    });
    expect(presetResponse.ok()).toBe(true);
    const preset = await presetResponse.json();
    const profile = (await (await request.get(`/api/chats/${chat.id}`)).json()).profile;
    const pinned = await request.put(`/api/chats/${chat.id}/profile`, {
      data: {
        expectedRevision: profile.revision,
        image: profile.image,
        packageAttachments: profile.packageAttachments,
        pinned: { ...profile.pinned, mainPromptPresetId: preset.id },
      },
    });
    expect(pinned.ok()).toBe(true);
    const variables = await (await request.get(`/api/chats/${chat.id}/variables`)).json();
    expect(variables.values).toEqual({});
    expect(variables.defaults).toEqual({});
    expect(variables.variableDefaultsError).toBeUndefined();
    const before = await (await request.get(`/api/chats/${chat.id}`)).json();
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/?chat=${chat.id}`);
    await openChatSettings(page);
    const dialog = page.getByRole('dialog', { name: '채팅 설정', exact: true });
    const back = dialog.getByRole('button', { name: '채팅 설정 목록으로', exact: true });
    if (width <= 760) await back.click();
    await selectChatSettingsSection(page, '생성 설정');
    await dialog.getByText('고급 실행 설정', { exact: true }).click();
    const draft = dialog.getByRole('spinbutton', { name: '작업당 모델 호출 한도', exact: true });
    await draft.fill('17');
    if (width <= 760) await back.click();

    const writes: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/api/') && !['GET', 'HEAD'].includes(request.method()))
        writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
    });
    const search = dialog.getByRole('searchbox', { name: '설정 검색', exact: true });
    const results = dialog.locator('.settings-search-results');
    await search.fill('페르소나');
    const materials = results.getByRole('button', { name: '사용 자료', exact: true });
    await expect(materials).toBeVisible();
    await page.screenshot({ path: info.outputPath(`chat-settings-search-${width}.png`) });
    await search.press('Tab');
    await expect(materials).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(dialog.getByRole('tabpanel').filter({ visible: true })).toBeFocused();
    if (width <= 760) await back.click();
    await expect(search).toHaveValue('');
    await search.fill('없는 설정 이름');
    await expect(results.getByRole('status')).toHaveText('검색 결과가 없어요.');
    await search.fill('카드 변수');
    await expect(results.getByRole('button')).toHaveCount(0);
    await search.fill('번역');
    await results.getByRole('button', { name: '생성 설정', exact: true }).click();
    await expect(draft).toBeVisible();
    await expect(draft).toHaveValue('17');
    expect(writes).toEqual([]);
    const after = await (await request.get(`/api/chats/${chat.id}`)).json();
    expect(after.chat.settings).toEqual(before.chat.settings);
    expect(after.chat.settingsRevision).toBe(before.chat.settingsRevision);
    expect(after.profile).toEqual(before.profile);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true
    );
    await dialog.getByRole('button', { name: '채팅 설정 닫기', exact: true }).click();
    await page
      .getByRole('alertdialog', { name: '미저장 채팅 설정 확인', exact: true })
      .getByRole('button', { name: '초안 버리고 닫기', exact: true })
      .click();
    await expect(dialog).toBeHidden();
  });

  test(`SCUISEARCHREADING search focuses reading controls and retains changes at ${width}px`, async ({
    page,
    request,
  }, info) => {
    const created = await postFixtureChat(request, {
      data: { title: `읽기 검색 합성 채팅 ${width}` },
    });
    expect(created.ok()).toBe(true);
    const chat = await created.json();
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/?chat=${chat.id}`);
    await (await openChatMenu(page))
      .getByRole('button', { name: '읽기 설정', exact: true })
      .click();
    const dialog = page.getByRole('dialog', { name: '읽기 설정', exact: true });
    const search = dialog.getByRole('searchbox', { name: '설정 검색', exact: true });
    const results = dialog.locator('.settings-search-results');
    const inputBefore = (await search.boundingBox())!;
    const dialogBefore = (await dialog.boundingBox())!;
    await search.fill('글자 크기');
    const sizeResult = results.getByRole('button', { name: '본문 크기', exact: true });
    await expect(sizeResult).toBeVisible();
    expect(Math.abs((await search.boundingBox())!.y - inputBefore.y)).toBeLessThanOrEqual(1);
    expect(
      Math.abs((await dialog.boundingBox())!.height - dialogBefore.height)
    ).toBeLessThanOrEqual(1);
    await page.screenshot({ path: info.outputPath(`reading-settings-search-${width}.png`) });
    await search.press('Tab');
    await expect(sizeResult).toBeFocused();
    await page.keyboard.press('Enter');
    const size = dialog.getByRole('slider', { name: '본문 크기', exact: true });
    await expect(size).toBeFocused();
    const oldSize = Number(await size.inputValue());
    const nextSize = oldSize === 28 ? oldSize - 1 : oldSize + 1;
    await size.press(oldSize === 28 ? 'ArrowLeft' : 'ArrowRight');
    await expect(size).toHaveValue(String(nextSize));
    await search.fill('문단 간격');
    await results.getByRole('button', { name: '문단 간격', exact: true }).click();
    const spacing = dialog.getByRole('combobox', { name: '문단 간격', exact: true });
    await expect(spacing).toBeFocused();
    await spacing.selectOption('1.5');
    await search.fill('없는 읽기 설정');
    await expect(results.getByRole('status')).toHaveText('검색 결과가 없어요.');
    await search.fill(' / · - ');
    await expect(results).toHaveCount(0);
    await expect(size).toBeVisible();
    await expect(spacing).toHaveValue('1.5');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true
    );
    await dialog.getByRole('button', { name: '읽기 설정 닫기', exact: true }).click();
    await page.reload();
    await (await openChatMenu(page))
      .getByRole('button', { name: '읽기 설정', exact: true })
      .click();
    await expect(size).toHaveValue(String(nextSize));
    await expect(spacing).toHaveValue('1.5');
    await dialog.getByRole('button', { name: '읽기 설정 닫기', exact: true }).click();
    await navigationAction(page, '설정');
    await selectSettingsSection(page, '일반');
    const global = page.getByRole('dialog', { name: '설정', exact: true });
    await expect(
      global.getByRole('searchbox', { name: '설정 검색', exact: true, includeHidden: true })
    ).toHaveCount(1);
    await expect(global.getByRole('slider', { name: '본문 크기', exact: true })).toHaveValue(
      String(nextSize)
    );
    if (width <= 760)
      await global.getByRole('button', { name: '설정 목록으로', exact: true }).click();
    await expect(global.getByRole('searchbox', { name: '설정 검색', exact: true })).toBeVisible();
  });
}
