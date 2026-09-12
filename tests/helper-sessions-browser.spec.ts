import { MOBILE_WIDTH, DESKTOP_WIDTH } from './fixtures/browser-viewports.js';
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Chat } from '../core/types.js';
import type { Branch } from '../core/product.js';
import type { HelperConversation } from '../core/helper.js';
import { postFixtureChat } from './fixtures/chat.js';
import { openHelper } from './ui-navigation.js';

test('HSESSION01 sessions retain their own drafts after switching and reload, rename and delete only the selected session', async ({
  page,
  request,
}, info) => {
  const chat = (await (
    await postFixtureChat(request, { data: { title: `세션 분리 ${randomUUID()}` } })
  ).json()) as Chat;
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
  await page.goto(`/?chat=${chat.id}`);
  await openHelper(page);
  const panel = page.locator('#helper-panel');
  const input = panel.getByLabel('도우미에게 요청');
  await expect(input).toBeEnabled();
  const picker = panel.getByLabel('도우미 세션 선택');
  const first = await picker.inputValue();
  await input.fill('첫 세션에 남겨 둘 초안');
  await panel.getByRole('button', { name: '새 도우미 세션', exact: true }).click();
  await expect(picker).not.toHaveValue(first);
  await expect(input).toBeEnabled();
  await expect(input).toHaveValue('');
  const second = await picker.inputValue();
  await input.fill('두 번째 세션 초안');
  await picker.selectOption(first);
  await expect(input).toHaveValue('첫 세션에 남겨 둘 초안');
  await picker.selectOption(second);
  await expect(input).toHaveValue('두 번째 세션 초안');
  await panel.getByLabel('도우미 세션 관리', { exact: true }).click();
  await panel.getByRole('button', { name: '세션 이름 변경', exact: true }).click();
  const rename = page.getByRole('dialog', { name: '도우미 세션 이름 변경' });
  await rename.getByLabel('세션 이름', { exact: true }).fill('다른 결말 검토');
  await rename.getByRole('button', { name: '이름 저장', exact: true }).click();
  await expect(rename).toBeHidden();
  await expect(picker.locator('option:checked')).toContainText('다른 결말 검토');
  await page.reload();
  await openHelper(page);
  await expect(picker).toHaveValue(second);
  await expect(input).toHaveValue('두 번째 세션 초안');
  for (const width of [DESKTOP_WIDTH, 1280, MOBILE_WIDTH]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(panel).toBeVisible();
    await expect
      .poll(async () => (await panel.boundingBox())?.width)
      .toBe(width === MOBILE_WIDTH ? MOBILE_WIDTH : 384);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
      .toBe(true);
    await page.screenshot({ path: info.outputPath(`helper-sessions-${width}.png`) });
  }
  await panel.getByLabel('도우미 세션 관리', { exact: true }).click();
  await panel.getByRole('button', { name: '세션 삭제', exact: true }).click();
  const deletion = page.getByRole('dialog', { name: '도우미 세션 삭제', exact: true });
  await expect(deletion).toContainText('이미 저장한 본편');
  await deletion.getByRole('button', { name: '계속 사용', exact: true }).click();
  await expect(input).toHaveValue('두 번째 세션 초안');
  await panel.getByLabel('도우미 세션 관리', { exact: true }).click();
  await panel.getByRole('button', { name: '세션 삭제', exact: true }).click();
  await deletion.getByRole('button', { name: '세션 영구 삭제', exact: true }).click();
  await expect(deletion).toBeHidden();
  await expect(picker).toHaveValue(first);
  await expect(input).toHaveValue('첫 세션에 남겨 둘 초안');
  expect((await request.get(`/api/helper/conversations/${second}`)).status()).toBe(404);
  expect((await request.get(`/api/helper/conversations/${first}`)).ok()).toBe(true);
});

test('HSESSION02 another branch session is readable and requires navigation before a new request', async ({
  page,
  request,
}, info) => {
  const chat = (await (
    await postFixtureChat(request, { data: { title: `전개 격리 ${randomUUID()}` } })
  ).json()) as Chat;
  const branch = (await (
    await request.post(`/api/chats/${chat.id}/branches`, {
      data: { title: '다른 결말', fromRevision: null },
    })
  ).json()) as Branch;
  const foreign = (await (
    await request.post('/api/helper/conversations/new', {
      data: {
        scope: { kind: 'chat', chatId: chat.id, branchId: branch.id },
        requestKey: randomUUID(),
        title: '다른 결말 전용 도우미',
      },
    })
  ).json()) as HelperConversation;
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
  await page.goto(`/?chat=${chat.id}`);
  await openHelper(page);
  const panel = page.locator('#helper-panel');
  await expect(panel.getByLabel('도우미에게 요청')).toBeEnabled();
  await panel.getByLabel('도우미 세션 선택').selectOption(foreign.id);
  await expect(panel.getByRole('button', { name: '해당 분기로 이동', exact: true })).toBeVisible();
  await panel.getByLabel('도우미에게 요청').fill('전개를 이동한 뒤 보낼 초안');
  await expect(
    panel.getByRole('button', { name: '도우미 요청 보내기', exact: true })
  ).toBeDisabled();
  await panel.getByRole('button', { name: '도우미 말투 설정', exact: true }).click();
  await panel.getByLabel('도우미 말투', { exact: true }).fill('이 전개에서 사용할 말투 초안');
  await expect(panel.getByRole('button', { name: '도우미 설정 저장', exact: true })).toBeDisabled();
  await page.screenshot({ path: info.outputPath('helper-other-branch.png') });
  await panel.getByRole('button', { name: '해당 분기로 이동', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`branch=${branch.id}`));
  await expect(panel.getByRole('button', { name: '해당 분기로 이동', exact: true })).toBeHidden();
  await expect(panel.getByLabel('도우미 세션 선택')).toHaveValue(foreign.id);
  await expect(panel.getByLabel('도우미에게 요청')).toHaveValue('전개를 이동한 뒤 보낼 초안');
  await expect(
    panel.getByRole('button', { name: '도우미 요청 보내기', exact: true })
  ).toBeEnabled();
  await expect(panel.getByRole('button', { name: '도우미 설정 저장', exact: true })).toBeEnabled();
});

test('HSESSION03 a delayed session creation does not replace a later user selection or draft', async ({
  page,
  request,
}) => {
  const chat = (await (
    await postFixtureChat(request, { data: { title: `늦은 세션 응답 ${randomUUID()}` } })
  ).json()) as Chat;
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
  await page.goto(`/?chat=${chat.id}`);
  await openHelper(page);
  const panel = page.locator('#helper-panel'),
    input = panel.getByLabel('도우미에게 요청');
  const picker = panel.getByLabel('도우미 세션 선택');
  await expect(input).toBeEnabled();
  const first = await picker.inputValue();
  await panel.getByRole('button', { name: '새 도우미 세션', exact: true }).click();
  await expect(picker).not.toHaveValue(first);
  await expect(input).toBeEnabled();
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let received = false;
  let fulfilled = false;
  await page.route('**/api/helper/conversations/new', async (route) => {
    const response = await route.fetch();
    received = true;
    await held;
    await route.fulfill({ response });
    fulfilled = true;
  });
  try {
    await panel.getByRole('button', { name: '새 도우미 세션', exact: true }).click();
    await expect.poll(() => received).toBe(true);
    await picker.selectOption(first);
    await input.fill('응답을 기다리는 동안 내가 선택한 초안');
    release();
    await expect.poll(() => fulfilled).toBe(true);
    await expect(panel.getByRole('button', { name: '새 도우미 세션', exact: true })).toBeEnabled();
    await expect(picker).toHaveValue(first);
    await expect(input).toHaveValue('응답을 기다리는 동안 내가 선택한 초안');
  } finally {
    release();
    await page.unrouteAll({ behavior: 'wait' });
  }
});
