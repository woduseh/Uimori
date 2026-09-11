import { reviewWidths, visualReview } from './fixtures/visual-review.js';
import { expect, test, type Page } from '@playwright/test';
import { navigationAction, selectSettingsSection } from './ui-navigation.js';

async function openArchive(page: Page) {
  await page.goto('/');
  await navigationAction(page, '설정');
  await selectSettingsSection(page, '데이터 관리');
  const panel = page.getByTestId('archive-panel');
  await expect(panel).toBeVisible();
  return panel;
}
const jsonFile = (name: string, value: unknown) => ({
  name,
  mimeType: 'application/json',
  buffer: Buffer.from(JSON.stringify(value)),
});

test('ACOM01 backup choices and native file selection stay compact across desktop and mobile widths', async ({
  page,
}, info) => {
  // Only the UI state is synthetic; these routes never restore the shared browser fixture DB.
  await page.route('**/api/import/status', (route) => route.fulfill({ json: { canImport: true } }));
  await page.route('**/api/export', (route) => route.fulfill({ json: { synthetic: 'backup' } }));
  await page.route('**/api/backup', (route) =>
    route.fulfill({ contentType: 'application/vnd.sqlite3', body: 'SYNTHETIC_BACKUP_BYTES' })
  );
  const posts: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST') posts.push(request.url());
  });
  const panel = await openArchive(page);
  const file = panel.getByLabel('가져올 JSON 파일', { exact: true });
  const name = '합성-아주-긴-자료와-대화-백업-선택-파일.json';
  await file.setInputFiles(jsonFile(name, { synthetic: 'selected archive' }));
  await expect(panel.getByRole('button', { name: '빈 DB에 가져오기', exact: true })).toBeEnabled();
  // The native input already names the selected file; the app does not repeat it below.
  await expect(panel.getByText(name, { exact: true })).toHaveCount(0);
  for (const width of reviewWidths([360, 390, 430, 768, 1024, 1440])) {
    await page.setViewportSize({ width, height: 900 });
    await expect(panel.getByRole('heading', { name: '백업 받기', exact: true })).toBeVisible();
    await expect(panel.getByRole('heading', { name: '가져오기', exact: true })).toBeVisible();
    await expect(panel.getByText(/SQLite 백업은 서버를 종료하고/)).toBeHidden();
    await expect(panel.getByText(/새 빈 데이터베이스에만 복원할 수 있어요/)).toBeVisible();
    const clear = panel.getByRole('button', { name: '선택한 파일 해제', exact: true });
    await expect(clear).toBeVisible();
    const box = (await clear.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    if (visualReview) {
      const inputBox = (await file.boundingBox())!;
      expect(
        Math.abs(box.y + box.height / 2 - inputBox.y - inputBox.height / 2)
      ).toBeLessThanOrEqual(1);
    }
    expect(await file.evaluate((node) => (node as HTMLInputElement).files?.[0]?.name)).toBe(name);
    expect(await panel.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(
      1
    );
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
    ).toBeLessThanOrEqual(1);
    if (visualReview)
      await page.screenshot({ path: info.outputPath(`archive-compact-${width}.png`) });
  }
  const jsonDownload = page.waitForEvent('download');
  await panel.getByRole('button', { name: 'JSON 내보내기', exact: true }).click();
  expect((await jsonDownload).suggestedFilename()).toBe('narrative-archive.json');
  const sqliteDownload = page.waitForEvent('download');
  await panel.getByRole('button', { name: 'SQLite 백업 다운로드', exact: true }).click();
  expect((await sqliteDownload).suggestedFilename()).toBe('narrative-backup.sqlite');
  expect(posts).toEqual([]);
});

test('ACOM02 stale file reads cannot replace a later selection or restore a cleared draft', async ({
  page,
}, info) => {
  await page.route('**/api/import/status', (route) => route.fulfill({ json: { canImport: true } }));
  await page.addInitScript(() => {
    const original = File.prototype.text;
    const reads: Record<string, { release: () => void; done: Promise<void> }> = {};
    Object.assign(window, { syntheticArchiveReads: reads });
    File.prototype.text = async function () {
      if (!this.name.startsWith('slow-')) return original.call(this);
      let release!: () => void, complete!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const done = new Promise<void>((resolve) => {
        complete = resolve;
      });
      reads[this.name] = { release, done };
      await gate;
      try {
        return await original.call(this);
      } finally {
        setTimeout(complete, 0);
      }
    };
  });
  const release = async (name: string) =>
    page.evaluate(async (name) => {
      const reads = (
        window as unknown as {
          syntheticArchiveReads: Record<string, { release: () => void; done: Promise<void> }>;
        }
      ).syntheticArchiveReads;
      reads[name].release();
      await reads[name].done;
    }, name);
  await page.setViewportSize({ width: 390, height: 844 });
  const panel = await openArchive(page);
  const file = panel.getByLabel('가져올 JSON 파일', { exact: true });
  const submit = panel.getByRole('button', { name: '빈 DB에 가져오기', exact: true });
  await file.setInputFiles(jsonFile('first.json', { marker: 'first' }));
  await expect(submit).toBeEnabled();
  await file.setInputFiles({
    name: 'slow-invalid.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{'),
  });
  await expect(submit).toBeDisabled();
  await expect(panel.getByText('파일을 읽고 있어요…', { exact: true })).toBeVisible();
  await file.setInputFiles(jsonFile('current.json', { marker: 'current' }));
  await expect(submit).toBeEnabled();
  await release('slow-invalid.json');
  await expect(file).toHaveAttribute('aria-invalid', 'false');
  await expect(panel.getByRole('alert')).toHaveCount(0);
  await selectSettingsSection(page, '일반');
  await selectSettingsSection(page, '데이터 관리');
  expect(await file.evaluate((node) => (node as HTMLInputElement).files?.[0]?.name)).toBe(
    'current.json'
  );
  await page.getByRole('button', { name: '설정 닫기', exact: true }).click();
  const guard = page.getByRole('alertdialog', { name: '미저장 설정 확인', exact: true });
  await expect(guard).toBeVisible();
  await guard.getByRole('button', { name: '계속 편집', exact: true }).click();
  await file.setInputFiles(jsonFile('slow-cleared.json', { marker: 'must not return' }));
  await expect(submit).toBeDisabled();
  await panel.getByRole('button', { name: '선택한 파일 해제', exact: true }).click();
  await release('slow-cleared.json');
  await expect(submit).toBeDisabled();
  expect(await file.evaluate((node) => (node as HTMLInputElement).files?.length)).toBe(0);
  await expect(panel.getByRole('button', { name: '선택한 파일 해제', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('alert')).toHaveCount(0);
  if (visualReview) await page.screenshot({ path: info.outputPath('archive-cleared-mobile.png') });
  await page.getByRole('button', { name: '설정 닫기', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '설정', exact: true })).toBeHidden();
});

test('ACOM03 status failure and occupied data block import, while a failed write keeps the selected file and local error', async ({
  page,
}, info) => {
  let status: 'occupied' | 'allowed' | 'failed' = 'occupied';
  await page.route('**/api/import/status', (route) =>
    status === 'failed'
      ? route.fulfill({ status: 503, json: { error: 'SYNTHETIC_STATUS_FAILURE' } })
      : route.fulfill({ json: { canImport: status === 'allowed' } })
  );
  const imports: unknown[] = [];
  await page.route('**/api/import', (route) => {
    imports.push(route.request().postDataJSON());
    return route.fulfill({ status: 503, json: { error: 'SYNTHETIC_IMPORT_FAILURE' } });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  const panel = await openArchive(page);
  const file = panel.getByLabel('가져올 JSON 파일', { exact: true });
  const submit = panel.getByRole('button', { name: '빈 DB에 가져오기', exact: true });
  const refresh = panel.getByRole('button', { name: '복원 가능 여부 다시 확인', exact: true });
  await file.setInputFiles(jsonFile('retry.json', { marker: 'preserve selected bytes' }));
  await expect(panel.getByText(/현재 DB에 자료가 있어 가져올 수 없어요/)).toBeVisible();
  await expect(submit).toBeDisabled();
  expect(imports).toEqual([]);
  status = 'failed';
  await refresh.click();
  await expect(panel.getByRole('alert')).toContainText('복원 가능 여부를 확인하지 못했어요');
  await expect(submit).toBeDisabled();
  status = 'allowed';
  await refresh.click();
  await expect(submit).toBeEnabled();
  await file.setInputFiles({
    name: 'invalid.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{ invalid'),
  });
  await expect(submit).toBeDisabled();
  await expect(file).toHaveAttribute('aria-invalid', 'true');
  await expect(
    panel.getByRole('form', { name: 'JSON 가져오기', exact: true }).getByRole('alert')
  ).toContainText('JSON 형식');
  await file.setInputFiles(jsonFile('retry.json', { marker: 'preserve selected bytes' }));
  await expect(submit).toBeEnabled();
  await submit.click();
  const form = panel.getByRole('form', { name: 'JSON 가져오기', exact: true });
  await expect(form.getByRole('alert')).toContainText('서버 작업을 완료하지 못했어요');
  expect(imports).toEqual([{ archive: { marker: 'preserve selected bytes' } }]);
  expect(await file.evaluate((node) => (node as HTMLInputElement).files?.[0]?.name)).toBe(
    'retry.json'
  );
  await selectSettingsSection(page, '일반');
  await selectSettingsSection(page, '데이터 관리');
  await expect(form.getByRole('alert')).toContainText('서버 작업을 완료하지 못했어요');
  if (visualReview)
    await page.screenshot({ path: info.outputPath('archive-import-error-mobile.png') });
  expect(imports).toHaveLength(1);
});

test('ACOM04 an accepted import clears its file once even when the following library refresh fails', async ({
  page,
}, info) => {
  let accepted = false;
  let imports = 0;
  await page.route('**/api/import/status', (route) =>
    route.fulfill({ json: { canImport: !accepted } })
  );
  await page.route('**/api/import', (route) => {
    imports++;
    accepted = true;
    return route.fulfill({ json: { restored: true, chats: 0 } });
  });
  await page.route('**/api/library?view=summary', (route) =>
    accepted
      ? route.fulfill({ status: 503, json: { error: 'SYNTHETIC_REFRESH_FAILURE' } })
      : route.continue()
  );
  const panel = await openArchive(page);
  const file = panel.getByLabel('가져올 JSON 파일', { exact: true });
  await file.setInputFiles(
    jsonFile('accepted.json', { synthetic: 'accepted only by the route fixture' })
  );
  const submit = panel.getByRole('button', { name: '빈 DB에 가져오기', exact: true });
  await expect(submit).toBeEnabled();
  await submit.click();
  const form = panel.getByRole('form', { name: 'JSON 가져오기', exact: true });
  await expect(form.getByRole('status')).toContainText('빈 DB에 가져오기를 완료했어요.');
  await expect(form.getByRole('alert')).toContainText(
    '가져오기는 완료됐어요. 목록을 새로 읽지 못했어요.'
  );
  expect(await file.evaluate((node) => (node as HTMLInputElement).files?.length)).toBe(0);
  await expect(submit).toBeDisabled();
  await expect(panel.getByRole('button', { name: '선택한 파일 해제', exact: true })).toHaveCount(0);
  expect(imports).toBe(1);
  if (visualReview)
    await page.screenshot({ path: info.outputPath('archive-accepted-refresh-error.png') });
});

test('ACOM03 a chat transcript file creates a new chat through the data panel without touching the archive import', async ({
  page,
}) => {
  await page.route('**/api/import/status', (route) =>
    route.fulfill({ json: { canImport: false } })
  );
  const imports: unknown[] = [];
  await page.route('**/api/chats/import-transcript', async (route) => {
    imports.push(route.request().postDataJSON());
    await route.fulfill({
      json: {
        chat: { id: 'synthetic-imported', title: '복원된 작품' },
        created: true,
        skippedAttachments: [{ id: 'missing-module', revision: 2 }],
      },
    });
  });
  const panel = await openArchive(page);
  const section = panel.getByRole('region', { name: '채팅 본문 가져오기', exact: true });
  await expect(section.getByText(/완전 백업은 위의 채팅 백업 가져오기를 사용해요/)).toBeVisible();
  const transcript = {
    format: 'uimori-chat-transcript',
    version: 1,
    exportedAt: '2026-09-10T00:00:00.000Z',
    title: '복원된 작품',
    attachments: [],
    packageAttachments: [{ id: 'bot-1', revision: 1, role: 'bot' }],
    notes: [],
    entries: [{ request: '시작', text: '첫 장면.', translation: null }],
  };
  await section
    .getByLabel('채팅 본문 JSON 파일', { exact: true })
    .setInputFiles(jsonFile('story.transcript.json', transcript));
  const done = section.getByRole('status').filter({ hasText: '채팅을 만들었어요' });
  await expect(done).toContainText('"복원된 작품" 채팅을 만들었어요.');
  await expect(done).toContainText('서재에 없는 자료 1개는 장착하지 않았어요.');
  // The busy notice ends when the server has created the chat, not after the list refresh.
  await expect(section.getByText('채팅을 만들고 있어요…', { exact: true })).toBeHidden();
  expect(imports).toHaveLength(1);
  const body = imports[0] as { transcript: unknown; idempotencyKey: string };
  expect(body.transcript).toEqual(transcript);
  expect(body.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  // The whole-database import stays gated by the empty-DB rule; the transcript path is separate.
  await expect(panel.getByRole('button', { name: '빈 DB에 가져오기', exact: true })).toBeDisabled();
  await section
    .getByLabel('채팅 본문 JSON 파일', { exact: true })
    .setInputFiles({ name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from('{') });
  await expect(section.getByRole('alert')).toContainText('JSON 형식이 아니에요');
  expect(imports).toHaveLength(1);
});
