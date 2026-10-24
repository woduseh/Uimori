import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { test, expect } from '@playwright/test';
import type { AuthorNote } from '../core/notes.js';
import type { OrphanMemoryDetail } from '../core/orphan-memory.js';
import { postFixtureChat } from './fixtures/chat.js';
import { DEFAULT_WIDTHS } from './fixtures/browser-viewports.js';
import { openChatSettings, selectChatSettingsSection } from './ui-navigation.js';

test('ORPHAN manual memory review preserves source records and AI review only prepares a request', async ({
  page,
  request,
}, info) => {
  const created = await postFixtureChat(request, { data: { title: 'ORPHAN 합성 기억 정리' } });
  expect(created.ok()).toBe(true);
  const chat = await created.json();
  expect(
    process.env.UIMORI_DB,
    'Requires the verifier-owned disposable SQLite database'
  ).toBeTruthy();
  const note: AuthorNote = {
    id: randomUUID(),
    chatId: chat.id,
    atRevision: 'deleted-synthetic-source',
    atHash: 'a'.repeat(64),
    text: '은빛 항구의 종은 세 번 울렸다. 삭제한 장면에서 가져온 기억이다.',
    declaration: {
      author: '합성 작성자',
      text: '은빛 항구의 종은 세 번 울렸다. 삭제한 장면에서 가져온 기억이다.',
    },
    kind: 'author-note',
  };
  const second = {
    ...note,
    id: randomUUID(),
    text: '삭제한 장면의 다른 기억',
    declaration: { ...note.declaration, text: '삭제한 장면의 다른 기억' },
  };
  const db = new DatabaseSync(process.env.UIMORI_DB!);
  try {
    for (const entry of [note, second])
      db.prepare('INSERT INTO author_notes VALUES(?,?,?,NULL,NULL)').run(
        entry.id,
        chat.id,
        JSON.stringify(entry)
      );
    db.prepare('INSERT INTO author_note_heads VALUES(?,2)').run(chat.id);
  } finally {
    db.close();
  }
  const memory = async (): Promise<OrphanMemoryDetail> =>
    (await request.get(`/api/chats/${chat.id}/orphan-memory`)).json();
  let failRead = true;
  await page.route(`**/api/chats/${chat.id}/orphan-memory`, async (route) => {
    if (route.request().method() === 'GET' && failRead) {
      failRead = false;
      await route.fulfill({ status: 500, json: { error: '합성 기억 읽기 실패' } });
    } else await route.continue();
  });
  await page.goto(`/?chat=${chat.id}`);
  await openChatSettings(page);
  await selectChatSettingsSection(page, '기억과 메모');
  const panel = page.getByTestId('orphan-memory');
  await expect(panel.getByRole('alert')).toContainText('서버 작업을 완료하지 못했어요. (500)');
  await panel.getByRole('button', { name: '새로고침', exact: true }).click();
  const disclosure = panel.locator('.orphan-memory-disclosure');
  await expect(disclosure.locator(':scope > summary')).toHaveText('연결이 끊긴 기억 (2)');
  await expect(panel.getByText(note.text, { exact: true })).toBeHidden();
  await expect(
    panel.getByRole('button', { name: '현재 장면에 다시 연결', exact: true }).first()
  ).toBeHidden();
  await page.screenshot({ path: info.outputPath('orphan-memory-collapsed.png') });
  await disclosure.locator(':scope > summary').click();
  await expect(panel.getByText(note.text, { exact: true })).toBeVisible();
  await expect(panel.getByText('연결된 원문 장면이 삭제되었어요.', { exact: true })).toHaveCount(2);
  expect((await memory()).entries).toHaveLength(2);
  for (const width of DEFAULT_WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await panel.scrollIntoViewIfNeeded();
    expect(
      await panel.evaluate((element) => element.getBoundingClientRect().right <= innerWidth + 1)
    ).toBe(true);
    await page.screenshot({ path: info.outputPath(`orphan-memory-${width}.png`) });
  }
  const first = panel.locator('li').filter({ hasText: note.text });
  const provenance = first.locator('details');
  await expect(provenance.locator('small').first()).toBeHidden();
  await provenance.locator('summary').click();
  await expect(provenance.locator('small').first()).toBeVisible();
  await provenance.locator('summary').click();
  const modelRequests: string[] = [];
  page.on('request', (sent) => {
    if (sent.method() === 'POST' && /\/helper-conversations\/[^/]+\/tasks(?:\?|$)/.test(sent.url()))
      modelRequests.push(sent.url());
  });
  await first.getByRole('button', { name: 'AI 검토 요청 초안', exact: true }).click();
  await expect(page.getByLabel('도우미에게 요청', { exact: true })).toHaveValue(
    new RegExp(note.id)
  );
  const helperDraft = await page.getByLabel('도우미에게 요청', { exact: true }).inputValue();
  expect(helperDraft).toContain('저장하거나 삭제하지 마');
  expect(helperDraft).toContain(note.text);
  expect(helperDraft).not.toContain(second.text);
  expect(modelRequests).toEqual([]);
  await page.getByRole('button', { name: '도우미 닫기', exact: true }).click();
  await openChatSettings(page);
  await selectChatSettingsSection(page, '기억과 메모');
  if (!(await disclosure.evaluate((element) => (element as HTMLDetailsElement).open)))
    await disclosure.locator(':scope > summary').click();
  await first.getByRole('button', { name: '현재 장면에 다시 연결', exact: true }).click();
  await first.getByRole('button', { name: '취소', exact: true }).click();
  expect((await memory()).entries).toHaveLength(2);
  await first.getByRole('button', { name: '현재 장면에 다시 연결', exact: true }).click();
  await first.getByRole('button', { name: '현재 장면에 다시 연결', exact: true }).click();
  await expect.poll(async () => (await memory()).entries.length).toBe(1);
  await expect(disclosure.locator(':scope > summary')).toHaveText('연결이 끊긴 기억 (1)');
  const story = await (await request.get(`/api/chats/${chat.id}/story`)).json();
  expect(story.notes).toMatchObject([
    { text: note.text, declaration: note.declaration, atRevision: null },
  ]);
  const other = panel.locator('li').filter({ hasText: second.text });
  await other.getByRole('button', { name: '사용 중지', exact: true }).click();
  await other.getByRole('button', { name: '사용 중지', exact: true }).click();
  await expect.poll(async () => (await memory()).entries.length).toBe(0);
  await expect(panel).toHaveCount(0);
  await page.reload();
  await openChatSettings(page);
  await selectChatSettingsSection(page, '기억과 메모');
  await expect(panel).toHaveCount(0);
  const saved = new DatabaseSync(process.env.UIMORI_DB!, { readOnly: true });
  try {
    expect(
      JSON.parse(
        String(saved.prepare('SELECT entry FROM author_notes WHERE id=?').get(note.id)?.entry)
      )
    ).toEqual(note);
    expect(
      JSON.parse(
        String(saved.prepare('SELECT entry FROM author_notes WHERE id=?').get(second.id)?.entry)
      )
    ).toEqual(second);
  } finally {
    saved.close();
  }
});
