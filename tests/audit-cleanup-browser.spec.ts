import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { fixtureBotInput } from './fixtures/chat.js';
import { nativePrompt } from './fixtures/native-prompt.js';

for (const width of [412, 1440]) {
  test(`CLEANUP presentation ignores title events; source edits and one-off options work ${width}`, async ({
    page,
    request,
  }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    const current = await (await request.get('/api/prompt-workspace')).json();
    const configured = await request.put('/api/prompt-workspace', {
      data: {
        expectedRevision: current.revision,
        main: {
          ...current.main,
          program: nativePrompt('', { customPromptTemplateToggle: 'tone=검사 문체=text' }),
          values: { tone: '차분하게' },
        },
      },
    });
    expect(configured.ok(), await configured.text()).toBe(true);
    const botResponse = await request.post('/api/content', {
      data: fixtureBotInput('Cleanup ' + randomUUID()),
    });
    expect(botResponse.ok()).toBe(true);
    const bot = await botResponse.json();
    const imported = await request.post('/api/chats/import-transcript', {
      data: {
        idempotencyKey: randomUUID(),
        transcript: {
          format: 'uimori-chat-transcript',
          version: 2,
          exportedAt: new Date().toISOString(),
          title: 'Cleanup source',
          packageAttachments: [{ id: bot.id, revision: bot.revision, role: 'bot' }],
          notes: [],
          entries: [
            { request: 'First scene', text: 'Original cleanup manuscript.', translation: null },
          ],
        },
      },
    });
    expect(imported.ok(), await imported.text()).toBe(true);
    const chat = (await imported.json()).chat;
    let presentations = 0;
    const errors: string[] = [];
    page.on('request', (event) => {
      if (
        event.url().includes(`/chats/${chat.id}/sources/`) &&
        event.url().includes('/presentation')
      )
        presentations++;
    });
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`/?chat=${chat.id}`);
    await expect(
      page
        .locator('.risu-message-surface')
        .getByText('Original cleanup manuscript.', { exact: true })
    ).toBeVisible();
    const baseline = presentations;
    expect(baseline).toBeGreaterThan(0);
    const refreshed = page.waitForResponse(
      (response) => response.url().includes(`/chats/${chat.id}/reader?`) && response.ok()
    );
    const renamed = await request.patch(`/api/chats/${chat.id}/title`, {
      data: { title: 'Cleanup renamed', expectedTitleRevision: chat.titleRevision },
    });
    expect(renamed.ok(), await renamed.text()).toBe(true);
    await refreshed;
    // Cross two painted frames so React effects from the new reader payload have run.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
    );
    expect(presentations).toBe(baseline);
    const detail = await (await request.get(`/api/chats/${chat.id}/reader`)).json();
    const source = detail.sources[0];
    const changed = await request.put(`/api/sources/${source.id}/text`, {
      data: { text: 'Updated cleanup manuscript.', expectedRevision: source.editRevision ?? 0 },
    });
    expect(changed.ok(), await changed.text()).toBe(true);
    await expect(
      page
        .locator('.risu-message-surface')
        .getByText('Updated cleanup manuscript.', { exact: true })
    ).toBeVisible();
    expect(presentations).toBeGreaterThan(baseline);
    await page.getByRole('button', { name: '입력창 더보기', exact: true }).click();
    await page.getByRole('button', { name: '창작 옵션', exact: true }).click();
    await page.getByRole('tab', { name: '이 채팅', exact: true }).click();
    await expect(page.getByText('도우미에게 옵션 조정 위임', { exact: true })).toHaveCount(0);
    await page
      .locator('summary')
      .filter({ hasText: /^다음 생성에만 적용$/ })
      .click();
    await page
      .getByRole('button', { name: /검사 문체.*다음 생성만 지정|다음 생성만 지정.*검사 문체/ })
      .click();
    await page.getByRole('button', { name: '1회 옵션 예약', exact: true }).click();
    await expect(
      page.getByRole('region', { name: '다음 생성 옵션 예약', exact: true })
    ).toBeVisible();
    await page.getByRole('button', { name: '예약 취소', exact: true }).click();
    await expect(
      page.getByRole('region', { name: '다음 생성 옵션 예약', exact: true })
    ).toHaveCount(0);
    expect(errors).toEqual([]);
    await page.screenshot({
      path: info.outputPath(`cleanup-options-${width}.png`),
      fullPage: true,
    });
  });
}
