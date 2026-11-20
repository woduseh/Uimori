import { expect, test } from '@playwright/test';
import { postFixtureChat } from './fixtures/chat.js';
import {
  navigationAction,
  selectSettingsSection,
  openChatSettings,
  selectChatSettingsSection,
} from './ui-navigation.js';
import type { ChatGenerationDefaults } from '../core/chat-settings.js';

test('new chat defaults save immediately in general settings and do not update existing chats', async ({
  page,
  request,
}) => {
  const read = async () =>
    (await (await request.get('/api/chat-generation-defaults')).json()) as ChatGenerationDefaults;
  const baseline = await read();
  const existing = await (
    await postFixtureChat(request, { data: { title: 'Existing default scope' } })
  ).json();
  try {
    await page.goto('/');
    await navigationAction(page, '설정');
    await selectSettingsSection(page, '일반');
    const section = page.getByRole('region', { name: '새 채팅 기본값', exact: true });
    const limit = section.getByRole('spinbutton');
    await expect(limit).toHaveAttribute('max', '128');
    await expect(section.getByRole('button')).toHaveCount(0);
    await limit.fill('0');
    await limit.press('Enter');
    await expect(
      section.getByText('작업당 모델 호출 한도는 1~128 사이의 정수로 입력해 주세요.')
    ).toBeVisible();
    await expect(limit).toHaveValue(String(baseline.maxCalls));
    await limit.fill('128');
    await limit.press('Enter');
    await expect.poll(async () => (await read()).maxCalls).toBe(128);
    await section.getByRole('switch', { name: '이야기 UI', exact: true }).check();
    await expect.poll(async () => (await read()).storyUi).toBe(true);
    await section
      .getByRole('combobox', { name: '이야기 UI 스타일', exact: true })
      .selectOption('blue-archive');
    await expect.poll(async () => (await read()).storyUiStyle).toBe('blue-archive');
    const created = await (
      await postFixtureChat(request, { data: { title: 'New default scope' } })
    ).json();
    expect(created.settings).toMatchObject({
      maxCalls: 128,
      storyUi: true,
      storyUiStyle: 'blue-archive',
    });
    expect((await (await request.get(`/api/chats/${existing.id}`)).json()).chat.settings).toEqual(
      existing.settings
    );
    await page.reload();
    await navigationAction(page, '설정');
    await selectSettingsSection(page, '일반');
    await expect(limit).toHaveValue('128');
    await limit.fill('1');
    await section.getByRole('switch', { name: '이야기 UI', exact: true }).uncheck();
    await expect.poll(async () => (await read()).maxCalls).toBe(1);
    await expect.poll(async () => (await read()).storyUi).toBe(false);
    expect((await (await request.get(`/api/chats/${created.id}`)).json()).chat.settings).toEqual(
      created.settings
    );
    await page.screenshot({ path: 'output/chat-generation-defaults.png', fullPage: true });
    await page.goto(`/?chat=${created.id}`);
    await openChatSettings(page);
    await selectChatSettingsSection(page, '생성 설정');
    const runtime = page.getByRole('dialog', { name: '채팅 설정', exact: true });
    const advanced = runtime.getByText('고급 실행 설정', { exact: true });
    if (await advanced.isVisible()) await advanced.click();
    await expect(runtime.getByRole('spinbutton')).toHaveValue('128');
    await expect(runtime.getByRole('spinbutton')).toHaveAttribute('max', '128');
    await expect(runtime.getByRole('switch', { name: '이야기 UI', exact: true })).toBeChecked();
  } finally {
    const current = await read();
    const { revision: _revision, ...values } = baseline;
    const restored = await request.put('/api/chat-generation-defaults', {
      data: { ...values, expectedRevision: current.revision },
    });
    expect(restored.ok(), await restored.text()).toBe(true);
  }
});
