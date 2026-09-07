import { postFixtureChat } from './fixtures/chat.js';
import { test, expect, type APIRequestContext } from '@playwright/test';
import type { ChatDetail } from '../core/types.js';
import type { PromptProgram } from '../core/prompt-program.js';

async function detail(request: APIRequestContext, id: string): Promise<ChatDetail> {
  const response = await request.get(`/api/chats/${id}`);
  expect(response.ok()).toBe(true);
  return response.json();
}
async function fixture(request: APIRequestContext) {
  const program: PromptProgram = {
    version: 1,
    controls: [
      {
        id: 'language',
        label: '응답 언어',
        group: '기본 설정',
        type: 'select',
        default: 'ko',
        options: [
          { label: '한국어', value: 'ko' },
          { label: '직접 지정', value: 'custom' },
        ],
      },
      {
        id: 'customLanguage',
        label: '직접 지정 언어',
        group: '기본 설정',
        type: 'text',
        default: '',
        visibleWhen: { op: 'equal', args: [{ control: 'language' }, 'custom'] },
      },
      { id: 'inner', label: '내면 서술 강조', group: '시점·문체', type: 'boolean', default: false },
      {
        id: 'detail',
        label: '서술 상세도',
        group: '시점·문체',
        type: 'number',
        default: 1,
        min: 0,
        max: 3,
      },
    ],
    blocks: [
      {
        id: 'system',
        title: 'Synthetic instructions',
        kind: 'message',
        role: 'system',
        template: [{ kind: 'text', text: 'Synthetic creative options fixture.' }],
      },
      { id: 'history', title: 'History', kind: 'history', from: 0, to: 'end' },
    ],
  };
  const promptResponse = await request.post('/api/prompt-presets', {
    data: { title: '합성 창작 옵션', role: 'main', program },
  });
  expect(promptResponse.ok()).toBe(true);
  const prompt = await promptResponse.json();
  const chatResponse = await postFixtureChat(request, { data: { title: '합성 창작 옵션 채팅' } });
  expect(chatResponse.ok()).toBe(true);
  const chat = await chatResponse.json();
  const profile = (await detail(request, chat.id)).profile!;
  const response = await request.put(`/api/chats/${chat.id}/profile`, {
    data: {
      ...profile,
      chatId: undefined,
      revision: undefined,
      expectedRevision: profile.revision,
      prompts: { ...profile.prompts, main: { id: prompt.id, revision: prompt.revision } },
    },
  });
  expect(response.ok()).toBe(true);
  return {
    chat,
    key: `${prompt.id}@${prompt.revision}`,
    before: (await detail(request, chat.id)).profile!,
  };
}

test('chat creative options preserve drafts, apply explicitly and fit desktop/mobile', async ({
  page,
  request,
}, info) => {
  const { chat, key, before } = await fixture(request);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const otherResponse = await request.post('/api/chats', {
    data: { title: '옵션 초안과 분리된 다른 채팅', botId: chat.botId },
  });
  expect(otherResponse.ok()).toBe(true);
  const other = await otherResponse.json();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/?chat=${chat.id}`);
  const open = page.getByRole('button', { name: '창작 옵션', exact: true });
  await open.click();
  const panel = page.getByRole('region', { name: '창작 옵션 패널', exact: true });
  await expect(panel).toBeVisible();
  await expect(panel.getByText('합성 창작 옵션', { exact: true })).toBeVisible();
  await expect(panel.locator('summary').filter({ hasText: '기본 설정' })).toBeVisible();
  await expect(panel.locator('summary').filter({ hasText: '시점·문체' })).toBeVisible();
  const language = panel.getByLabel('응답 언어', { exact: true }),
    custom = panel.getByLabel('직접 지정 언어', { exact: true });
  await expect(custom).toBeHidden();
  await language.selectOption({ label: '직접 지정' });
  await custom.fill('프랑스어');
  const inner = panel.getByRole('checkbox', { name: '내면 서술 강조', exact: true });
  await expect(inner).not.toBeChecked();
  await inner.check();
  expect((await detail(request, chat.id)).profile).toEqual(before);
  // The panel is non-modal: the actual request draft remains editable while it is open.
  await page.getByRole('textbox', { name: '다음 장면 요청', exact: true }).fill('보존할 요청 초안');
  await panel.getByRole('button', { name: '창작 옵션 닫기', exact: true }).click();
  await expect(panel).toBeHidden();
  await open.click();
  await expect(custom).toHaveValue('프랑스어');
  const navigation = page.getByRole('navigation', { name: '봇의 채팅 목록', exact: true });
  await navigation.getByRole('button', { name: other.title, exact: true }).click();
  await expect(page.getByRole('heading', { name: other.title, exact: true })).toBeVisible();
  await expect(panel.getByLabel('직접 지정 언어', { exact: true })).toBeHidden();
  await navigation.getByRole('button', { name: chat.title, exact: true }).click();
  await expect(custom).toHaveValue('프랑스어');
  await expect(inner).toBeChecked();
  expect((await detail(request, chat.id)).profile).toEqual(before);
  await panel.getByRole('button', { name: '이 채팅에 적용', exact: true }).click();
  await expect
    .poll(
      async () =>
        (await detail(request, chat.id)).profile?.promptControls?.[key]?.values.customLanguage
    )
    .toBe('프랑스어');
  const saved = (await detail(request, chat.id)).profile!;
  expect(saved.promptControls?.[key]?.values.inner).toBe(true);
  expect(saved.routes).toEqual(before.routes);
  expect(saved.attachments).toEqual(before.attachments);
  expect(saved.prompts).toEqual(before.prompts);
  expect(saved.revision).toBe(before.revision + 1);
  await expect(page.getByRole('textbox', { name: '다음 장면 요청', exact: true })).toHaveValue(
    '보존할 요청 초안'
  );
  await page.screenshot({ path: info.outputPath('chat-options-desktop.png') });
  await custom.fill('독일어');
  await panel.getByRole('button', { name: '편집 전으로 되돌리기', exact: true }).click();
  await expect(custom).toHaveValue('프랑스어');
  await panel.getByRole('button', { name: '프롬프트 기본값으로', exact: true }).click();
  await expect(language).toHaveValue('"ko"');
  await expect(custom).toBeHidden();
  expect((await detail(request, chat.id)).profile).toEqual(saved);
  page.once('dialog', (dialog) => dialog.accept());
  await page.reload();
  await open.click();
  await expect(custom).toHaveValue('프랑스어');
  await expect(inner).toBeChecked();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(panel).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true
  );
  expect(await panel.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await expect(panel.getByRole('button', { name: '이 채팅에 적용', exact: true })).toBeInViewport();
  await page.screenshot({ path: info.outputPath('chat-options-mobile.png') });
  expect((await detail(request, chat.id)).runs).toHaveLength(0);
  expect(errors).toEqual([]);
});

test('creative option CAS conflict preserves draft and server profile', async ({
  page,
  request,
}) => {
  const { chat, key, before } = await fixture(request);
  await page.goto(`/?chat=${chat.id}`);
  await page.getByRole('button', { name: '창작 옵션', exact: true }).click();
  const panel = page.getByRole('region', { name: '창작 옵션 패널', exact: true });
  await panel.getByLabel('응답 언어', { exact: true }).selectOption({ label: '직접 지정' });
  await panel.getByLabel('직접 지정 언어', { exact: true }).fill('스페인어');
  let concurrent: ChatDetail['profile'];
  let interleaved = false;
  await page.route(`**/api/chats/${chat.id}/profile`, async (route) => {
    if (route.request().method() !== 'PUT' || interleaved) return route.continue();
    interleaved = true;
    // Interleave after the UI has sent its stale revision so SSE timing cannot
    // turn this server-conflict check into a disabled-button timeout.
    const response = await request.put(`/api/chats/${chat.id}/profile`, {
      data: {
        ...before,
        chatId: undefined,
        revision: undefined,
        expectedRevision: before.revision,
        image: !before.image,
      },
    });
    expect(response.ok()).toBe(true);
    concurrent = (await detail(request, chat.id)).profile!;
    await route.continue();
  });
  const conflict = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/chats/${chat.id}/profile`) &&
      response.request().method() === 'PUT'
  );
  await panel.getByRole('button', { name: '이 채팅에 적용', exact: true }).click();
  expect((await conflict).status()).toBe(409);
  await expect(panel.getByLabel('직접 지정 언어', { exact: true })).toHaveValue('스페인어');
  expect((await detail(request, chat.id)).profile).toEqual(concurrent);
  await panel.getByRole('button', { name: '최신 채팅 설정에 내 옵션 유지', exact: true }).click();
  await panel.getByRole('button', { name: '이 채팅에 적용', exact: true }).click();
  await expect
    .poll(
      async () =>
        (await detail(request, chat.id)).profile?.promptControls?.[key]?.values.customLanguage
    )
    .toBe('스페인어');
  const recovered = (await detail(request, chat.id)).profile!;
  expect(recovered.image).toBe(!before.image);
  expect(recovered.revision).toBe(before.revision + 2);
});
