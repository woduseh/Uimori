import { test, expect } from '@playwright/test';
import { postFixtureChat } from './fixtures/chat.js';
import {
  navigationAction,
  selectSettingsSection,
  openChatMenu,
  openChatSettings,
  selectChatSettingsSection,
} from './ui-navigation.js';

test('INPUTUI01 native search clear restores reading controls and keeps focus without writes', async ({
  page,
  request,
}, info) => {
  const created = await postFixtureChat(request, {
    data: { title: '검색 지우기 합성 채팅' },
  });
  expect(created.ok()).toBe(true);
  const chat = await created.json();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => localStorage.setItem('uimori:theme', 'system'));
  await page.goto(`/?chat=${chat.id}`);
  await (await openChatMenu(page)).getByRole('button', { name: '읽기 설정', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '읽기 설정', exact: true });
  const search = dialog.getByRole('searchbox', { name: '설정 검색', exact: true });
  const results = dialog.locator('.settings-search-results');
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/') && !['GET', 'HEAD'].includes(request.method()))
      writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    await search.fill('글자 크기');
    await expect(results.getByRole('button', { name: '본문 크기', exact: true })).toBeVisible();
    await dialog.screenshot({ path: info.outputPath(`native-search-${colorScheme}.png`) });
    // The UA clear affordance is not a DOM node: hit its actual trailing input area.
    const point = await search.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return {
        x:
          rect.right -
          Number.parseFloat(style.borderRightWidth) -
          Number.parseFloat(style.paddingRight) -
          12,
        y: rect.top + rect.height / 2,
      };
    });
    await page.mouse.click(point.x, point.y);
    await expect(search).toHaveValue('');
    await expect(search).toBeFocused();
    await expect(results).toHaveCount(0);
    await expect(dialog.getByRole('slider', { name: '본문 크기', exact: true })).toBeVisible();
    await search.fill('없는 읽기 설정');
    await expect(results.getByRole('status')).toHaveText('검색 결과가 없어요.');
    await search.fill('문단 간격');
    await expect(results.getByRole('button', { name: '문단 간격', exact: true })).toBeVisible();
    await search.fill('');
  }
  expect(writes).toEqual([]);
});

test('INPUTUI02 native light dismiss distinguishes a drag and preserves dirty chat settings', async ({
  page,
  request,
}, info) => {
  const created = await postFixtureChat(request, {
    data: { title: '바깥 클릭 합성 채팅' },
  });
  expect(created.ok()).toBe(true);
  const chat = await created.json();
  const before = await (await request.get(`/api/chats/${chat.id}`)).json();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/?chat=${chat.id}`);
  const composer = page.getByLabel('다음 장면 요청', { exact: true });
  await composer.fill('설정 바깥을 눌러도 유지할 미전송 요청');
  await (await openChatMenu(page)).getByRole('button', { name: '읽기 설정', exact: true }).click();
  const reading = page.getByRole('dialog', { name: '읽기 설정', exact: true });
  await expect(reading).toBeVisible();
  const rect = (await reading.boundingBox())!;
  expect(rect.x).toBeGreaterThan(4);
  const title = (await reading
    .getByRole('heading', { name: '읽기 설정', exact: true })
    .boundingBox())!;
  await page.mouse.move(title.x + title.width / 2, title.y + title.height / 2);
  await page.mouse.down();
  await page.mouse.move(4, 4, { steps: 8 });
  await page.mouse.up();
  await expect(reading).toBeVisible();
  await page.mouse.click(4, 4);
  await expect(reading).toBeHidden();
  await expect(composer).toHaveValue('설정 바깥을 눌러도 유지할 미전송 요청');

  await openChatSettings(page);
  await selectChatSettingsSection(page, '생성 설정');
  const dialog = page.getByRole('dialog', { name: '채팅 설정', exact: true });
  await dialog.getByText('고급 실행 설정', { exact: true }).click();
  const calls = dialog.getByRole('spinbutton', { name: '작업당 모델 호출 한도', exact: true });
  const original = await calls.inputValue();
  const draft = original === '17' ? '18' : '17';
  await calls.fill(draft);
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/') && !['GET', 'HEAD'].includes(request.method()))
      writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });
  const settingsRect = (await dialog.boundingBox())!;
  expect(settingsRect.x).toBeGreaterThan(4);
  await page.mouse.click(4, 4);
  const confirm = page.getByRole('alertdialog', { name: '미저장 채팅 설정 확인', exact: true });
  await expect(confirm).toBeVisible();
  await page.screenshot({ path: info.outputPath('native-dismiss-dirty-confirmation.png') });
  await confirm.getByRole('button', { name: '계속 편집', exact: true }).click();
  await expect(confirm).toBeHidden();
  await expect(calls).toHaveValue(draft);
  await page.mouse.click(4, 4);
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: '초안 버리고 닫기', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(composer).toHaveValue('설정 바깥을 눌러도 유지할 미전송 요청');
  expect(writes).toEqual([]);
  const after = await (await request.get(`/api/chats/${chat.id}`)).json();
  expect(after.chat.settings).toEqual(before.chat.settings);
  expect(after.chat.settingsRevision).toBe(before.chat.settingsRevision);
  expect(after.profile).toEqual(before.profile);
});

test('INPUTUI03 reference notes grow within the viewport and retain their draft across settings', async ({
  page,
  request,
}, info) => {
  const created = await postFixtureChat(request, { data: { title: '참고 메모 자동 높이' } });
  expect(created.ok()).toBe(true);
  const chat = await created.json();
  for (const width of [1440, 412]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/?chat=' + chat.id);
    await openChatSettings(page);
    await selectChatSettingsSection(page, '원작 참고');
    const dialog = page.getByRole('dialog', { name: '채팅 설정', exact: true });
    const disclosure = dialog.locator('.story-guide-settings');
    if (!(await disclosure.evaluate((node) => (node as HTMLDetailsElement).open)))
      await disclosure.locator('summary').first().click();
    const notes = dialog.getByRole('textbox', { name: '기준 시점과 스포일러 범위', exact: true });
    await notes.fill('2권까지');
    await expect(dialog).toBeVisible({ timeout: 1000 });
    const short = (await notes.boundingBox())!.height;
    const text = Array.from(
      { length: 25 },
      (_, i) => '참고 범위 ' + i + ': 원고를 보존하며 긴 메모를 작성해요.'
    ).join('\n');
    await notes.fill(text);
    const tall = (await notes.boundingBox())!.height;
    expect(tall).toBeGreaterThan(short + 40);
    expect(tall).toBeLessThanOrEqual(451);
    expect(await notes.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
    await notes.screenshot({ path: info.outputPath('growing-notes-' + width + '.png') });
    await selectChatSettingsSection(page, '사용 자료');
    await selectChatSettingsSection(page, '원작 참고');
    await expect(notes).toHaveValue(text);
    await notes.fill('2권까지');
    expect((await notes.boundingBox())!.height).toBeLessThan(tall);
    const stored = await (await request.get('/api/chats/' + chat.id + '/story-guide')).json();
    expect(JSON.stringify(stored)).not.toContain('2권까지');
    await dialog.getByRole('button', { name: '채팅 설정 닫기', exact: true }).click();
    await page
      .getByRole('alertdialog', { name: '미저장 채팅 설정 확인', exact: true })
      .getByRole('button', { name: '초안 버리고 닫기', exact: true })
      .click();
    await expect(dialog).toBeHidden();
  }
});

test('INPUTUI04 invalid backup input stays editable, recovers and never writes before saving', async ({
  page,
  request,
}, info) => {
  await page.addInitScript(() => localStorage.setItem('uimori:theme', 'system'));
  await page.goto('/');
  await navigationAction(page, '설정');
  await selectSettingsSection(page, '데이터 관리');
  const panel = page.getByRole('region', { name: '서버 자동 백업', exact: true });
  const retain = panel.getByLabel('성공본 보관 개수', { exact: true });
  const initial = await retain.inputValue();
  const before = await (await request.get('/api/backups')).json();
  for (const mode of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: mode });
    const normalBorder = await retain.evaluate((node) => getComputedStyle(node).borderTopColor);
    await retain.fill('0');
    await expect(retain).toHaveAttribute('aria-invalid', 'true');
    await expect(retain).toBeEditable();
    await expect(panel.getByRole('alert')).toBeVisible();
    expect(await retain.evaluate((node) => getComputedStyle(node).borderTopColor)).not.toBe(
      normalBorder
    );
    await panel.screenshot({ path: info.outputPath('invalid-backup-' + mode + '.png') });
    await retain.fill(initial);
    await expect(retain).toHaveAttribute('aria-invalid', 'false');
    await expect(panel.getByRole('alert')).toHaveCount(0);
  }
  expect((await (await request.get('/api/backups')).json()).settings).toEqual(before.settings);
});
