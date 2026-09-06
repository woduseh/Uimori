import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Chat, ChatDetail, Run } from '../core/types.js';
import type { Connection, Content, CreativePreset, Library, ModelPreset } from '../core/product.js';

async function getDetail(request: APIRequestContext, id: string): Promise<ChatDetail> { const response = await request.get(`/api/chats/${id}`); expect(response.ok()).toBeTruthy(); return response.json(); }
async function getLibrary(request: APIRequestContext): Promise<Library> { const response = await request.get('/api/library'); expect(response.ok()).toBeTruthy(); return response.json(); }
async function createChat(page: Page, title: string): Promise<Chat> {
  await page.goto('/'); await page.getByLabel('새 이야기 이름').fill(title);
  const response = page.waitForResponse(response => response.url().endsWith('/api/chats') && response.request().method() === 'POST');
  await page.getByRole('button', { name: '이야기 만들기', exact: true }).click();
  const created = await response; expect(created.ok()).toBeTruthy(); const chat = await created.json() as Chat;
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible(); return chat;
}
async function send(page: Page, text: string): Promise<Run> {
  await page.getByLabel('다음 장면 요청').fill(text);
  const response = page.waitForResponse(response => /\/api\/chats\/[^/]+\/runs$/.test(response.url()) && response.request().method() === 'POST');
  await page.getByRole('button', { name: '원문 생성', exact: true }).click();
  const created = await response; expect(created.ok()).toBeTruthy(); return created.json();
}
async function openDetails(page: Page, testId: string) { const panel = page.getByTestId(testId); if ((await panel.getAttribute('open')) === null) await panel.locator('summary').first().click(); return panel; }

test('P01 content revisions stay pinned and a creative preset fully replaces prior controls', async ({ page, request }) => {
  const unique = `P01-${Date.now()}`;
  const chat = await createChat(page, `합성 ${unique}`);
  const library = await openDetails(page, 'library-panel');
  await page.getByLabel('자료 종류', { exact: true }).selectOption('bot');
  await page.getByLabel('자료 이름', { exact: true }).fill(`Mira ${unique}`);
  await page.getByLabel('자료 설명', { exact: true }).fill('Synthetic keeper of the harbor.');
  await page.getByLabel('자료 본문', { exact: true }).fill('Mira is a synthetic harbor keeper. Her compass is brass.');
  const addedResponse = page.waitForResponse(response => response.url().endsWith('/api/content') && response.request().method() === 'POST');
  await page.getByRole('button', { name: '자료 등록', exact: true }).click();
  const added = await (await addedResponse).json() as Content;
  expect(added.revision).toBe(1);
  const profile = await openDetails(page, 'profile-editor');
  await page.getByLabel(`장착 봇 Mira ${unique} v1`, { exact: true }).check();
  await page.getByLabel('profile 공동 서술', { exact: true }).check();
  await page.getByRole('button', { name: '콘텐츠와 제어 저장', exact: true }).click();
  await expect(profile.getByText('장착 설정 v2')).toBeVisible();
  await page.getByLabel('자료 본문', { exact: true }).fill('Mira is a synthetic harbor keeper. Her compass is silver in this new authored revision.');
  await page.getByRole('button', { name: '새 revision 저장', exact: true }).click();
  await expect(library.getByRole('status')).toContainText('v2 저장됨');
  expect((await getDetail(request, chat.id)).profile?.attachments).toEqual([{ id: added.id, revision: 1 }]);
  await expect(page.getByLabel(`장착 봇 Mira ${unique} v1`, { exact: true })).toBeChecked();

  await library.getByRole('tab', { name: '창작 프리셋', exact: true }).click();
  await page.getByLabel('새 창작 프리셋 이름').fill(`공동 ${unique}`);
  await page.getByLabel('preset 공동 서술', { exact: true }).check();
  await page.getByLabel('preset 선언 결과 확정', { exact: true }).check();
  const presetAResponse = page.waitForResponse(response => response.url().endsWith('/api/creative-presets') && response.request().method() === 'POST');
  await page.getByRole('button', { name: '창작 프리셋 저장', exact: true }).click();
  const presetA = await (await presetAResponse).json() as CreativePreset;
  await page.getByLabel('새 창작 프리셋 이름').fill(`개별 ${unique}`);
  await page.getByLabel('preset 공동 서술', { exact: true }).uncheck();
  await page.getByLabel('preset 선언 결과 확정', { exact: true }).uncheck();
  const presetBResponse = page.waitForResponse(response => response.url().endsWith('/api/creative-presets') && response.request().method() === 'POST');
  await page.getByRole('button', { name: '창작 프리셋 저장', exact: true }).click();
  const presetB = await (await presetBResponse).json() as CreativePreset;
  await page.getByLabel('적용할 창작 프리셋').selectOption(`${presetA.id}@1`);
  await page.getByRole('button', { name: '프리셋으로 제어 전체 교체' }).click();
  await expect(profile.getByText('장착 설정 v3')).toBeVisible();
  await expect(page.getByLabel('profile 공동 서술', { exact: true })).toBeChecked();
  await page.getByLabel('적용할 창작 프리셋').selectOption(`${presetB.id}@1`);
  await page.getByRole('button', { name: '프리셋으로 제어 전체 교체' }).click();
  await expect(profile.getByText('장착 설정 v4')).toBeVisible();
  await expect(page.getByLabel('profile 공동 서술', { exact: true })).not.toBeChecked();
  await expect(page.getByLabel('profile 선언 결과 확정', { exact: true })).not.toBeChecked();
  await expect(page.getByLabel('profile 직접 지정 단어')).toBeDisabled();
  const run = await send(page, '(OOC: Continue the harbor scene.) SYNTHETIC_P01');
  await expect.poll(async () => (await getDetail(request, chat.id)).runs.find(item => item.id === run.id)?.status).toBe('completed');
  const saved = (await getDetail(request, chat.id)).runs.find(item => item.id === run.id)!;
  expect(saved.snapshot.profile?.contents[0].text).toBe('Mira is a synthetic harbor keeper. Her compass is brass.');
  expect(saved.snapshot.profile?.creative).toMatchObject({ coNarration: false, declarationFinal: false, lengthMode: 'range' });
  expect(saved.inputs[0].task).toBe('(OOC: Continue the harbor scene.) SYNTHETIC_P01');
  expect(JSON.stringify(saved.inputs[0])).not.toContain('15000');
});

test('P04 manual model IDs and distinct main/translation routing preserve connection authority after catalog failure', async ({ page, request }) => {
  const unique = `P04-${Date.now()}`; const chat = await createChat(page, `합성 ${unique}`);
  const library = await openDetails(page, 'library-panel');
  await library.getByRole('tab', { name: '연결과 모델', exact: true }).click();
  await page.getByLabel('연결 이름', { exact: true }).fill(`격리 연결 ${unique}`);
  await page.getByLabel('로컬 endpoint').fill('http://127.0.0.1:9/turn');
  await page.getByLabel('서버 환경변수 이름').fill('NARRATIVE_PROVIDER_SYNTHETIC');
  const connectionResponse = page.waitForResponse(response => response.url().endsWith('/api/connections') && response.request().method() === 'POST');
  await page.getByRole('button', { name: '연결 등록', exact: true }).click();
  const connection = await (await connectionResponse).json() as Connection;
  expect(connection.enabled).toBe(false);
  const modelRefs: ModelPreset[] = [];
  for (const role of ['main', 'translation']) {
    await page.getByLabel('모델 프리셋 이름', { exact: true }).fill(`${role} ${unique}`);
    await page.getByLabel('모델 연결', { exact: true }).selectOption(`${connection.id}@1`);
    await page.getByLabel('모델 ID', { exact: true }).fill(`synthetic-${role}-unlisted`);
    const response = page.waitForResponse(response => response.url().endsWith('/api/model-presets') && response.request().method() === 'POST');
    await page.getByRole('button', { name: '모델 프리셋 등록', exact: true }).click();
    modelRefs.push(await (await response).json() as ModelPreset);
  }
  await library.locator('.compact-card').filter({ hasText: connection.title }).getByRole('button', { name: '모델 목록 새로고침' }).click();
  await expect(library.locator('.compact-card').filter({ hasText: connection.title })).toContainText('모델 목록을 새로 받지 못했어요');
  const after = (await getLibrary(request)).connections.find(item => item.id === connection.id)!;
  expect(after).toMatchObject({ endpoint: connection.endpoint, enabled: false, credentialEnv: 'NARRATIVE_PROVIDER_SYNTHETIC' });
  expect((await request.get(`/api/revisions/connection/${connection.id}/1`)).ok()).toBe(true);
  await openDetails(page, 'profile-editor');
  await page.getByLabel('원문 모델', { exact: true }).selectOption(`${modelRefs[0].id}@1`);
  await page.getByLabel('번역 모델', { exact: true }).selectOption(`${modelRefs[1].id}@1`);
  await page.getByRole('button', { name: '콘텐츠와 제어 저장', exact: true }).click();
  await expect(page.getByText('장착 설정 v2')).toBeVisible();
  const profile = (await getDetail(request, chat.id)).profile!;
  expect(profile.routes.main).toEqual({ id: modelRefs[0].id, revision: 1 });
  expect(profile.routes.translation).toEqual({ id: modelRefs[1].id, revision: 1 });
  expect(await page.evaluate(() => Object.values(localStorage).concat(Object.values(sessionStorage)).some(value => String(value).includes('NARRATIVE_PROVIDER_SYNTHETIC')))).toBe(false);
});

test('P09 P10 P13 candidates and descendants retain tab views, anchors, drafts and separate image annotations', async ({ page, context, request }, testInfo) => {
  const chat = await createChat(page, `합성 P09-${Date.now()}`);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const imagePanel = page.locator('details').filter({ has: page.locator('summary', { hasText: '이 이야기의 이미지' }) });
  await imagePanel.locator('summary').click();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9n8AAAAASUVORK5CYII=', 'base64');
  await page.getByLabel('PNG 또는 JPEG 이미지').setInputFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer: png });
  await page.getByLabel('이미지 이름', { exact: true }).fill('Synthetic harbor pixel');
  await page.getByLabel('이미지 설명', { exact: true }).fill('Synthetic test pixel representing the harbor.');
  await page.getByLabel('이미지 장소', { exact: true }).fill('pier');
  await page.getByRole('button', { name: '이미지 등록', exact: true }).click();
  await expect(imagePanel.getByRole('status')).toContainText('이미지를 등록했어요');
  await openDetails(page, 'profile-editor');
  await page.getByLabel('보조 이미지 표시', { exact: true }).check();
  await page.getByRole('button', { name: '콘텐츠와 제어 저장', exact: true }).click();
  await expect(page.getByText('장착 설정 v2')).toBeVisible();
  const first = await send(page, 'SYNTHETIC_BRANCH: Mira waits at the pier.');
  await expect.poll(async () => (await getDetail(request, chat.id)).runs.find(run => run.id === first.id)?.status).toBe('completed');
  await expect.poll(async () => (await getDetail(request, chat.id)).jobs.length).toBe(3);
  await expect.poll(async () => (await getDetail(request, chat.id)).jobs.every(job => job.status === 'completed')).toBe(true);
  const before = await getDetail(request, chat.id); const source = before.sources[0];
  await expect(page.getByTestId('profile-asset')).toBeVisible();
  await expect(page.getByTestId('inline-annotation').first()).toBeVisible();
  const anchors = await page.getByTestId('source-text').locator('[data-block-anchor]').evaluateAll(elements => elements.map(element => element.getAttribute('data-block-anchor')));
  expect(anchors).toEqual(source.blocks!.map(block => block.anchor));
  await page.getByRole('button', { name: '번역 보기', exact: true }).click();
  await expect(page.getByTestId('translation-text')).toBeVisible();
  const translatedAnchors = await page.getByTestId('translation-text').locator('[data-block-anchor]').evaluateAll(elements => elements.flatMap(element => element.getAttribute('data-block-anchor')!.split(' ')));
  expect(translatedAnchors).toEqual(anchors);
  await page.getByRole('button', { name: '원문 보기', exact: true }).click();
  await page.getByLabel('다음 장면 요청').fill('SYNTHETIC retained default draft');
  const otherTab = await context.newPage();
  try {
    await otherTab.goto(`/?chat=${chat.id}`);
    await expect(otherTab.getByTestId('source')).toHaveAttribute('data-source-id', source.id);
    const candidateResponse = page.waitForResponse(response => response.url().endsWith(`/api/runs/${first.id}/candidate`) && response.request().method() === 'POST');
    await page.getByRole('button', { name: '같은 요청의 다른 후보 생성', exact: true }).click();
    const candidate = await (await candidateResponse).json() as Run;
    await expect(page.getByLabel('읽고 이어갈 분기')).toHaveValue(candidate.snapshot.branchId!);
    await expect.poll(async () => (await getDetail(request, chat.id)).runs.find(run => run.id === candidate.id)?.status).toBe('completed');
    const candidateSource = (await getDetail(request, chat.id)).sources.find(item => item.runId === candidate.id)!;
    expect(candidateSource.parentRevision).toBe(source.parentRevision);
    await expect(page.getByTestId('source')).toHaveAttribute('data-source-id', candidateSource.id);
    await expect(otherTab.getByTestId('source')).toHaveAttribute('data-source-id', source.id);
    const next = await send(page, 'SYNTHETIC descendant in the candidate branch.');
    await expect.poll(async () => (await getDetail(request, chat.id)).runs.find(run => run.id === next.id)?.status).toBe('completed');
    await expect(page.getByTestId('source')).toHaveCount(2);
    const final = await getDetail(request, chat.id);
    const descendant = final.sources.find(item => item.runId === next.id)!;
    expect(descendant.parentRevision).toBe(candidateSource.id);
    expect(final.runs.find(item => item.id === next.id)?.snapshot.history.map(item => item.revision)).toEqual([candidateSource.id]);
    await page.getByLabel('다음 장면 요청').fill('SYNTHETIC candidate draft');
    await page.getByLabel('읽고 이어갈 분기').selectOption('');
    await expect(page.getByTestId('source')).toHaveAttribute('data-source-id', source.id);
    await expect(page.getByLabel('다음 장면 요청')).toHaveValue('SYNTHETIC retained default draft');
    await page.getByLabel('읽고 이어갈 분기').selectOption(candidate.snapshot.branchId!);
    await expect(page.getByLabel('다음 장면 요청')).toHaveValue('SYNTHETIC candidate draft');
    await page.reload();
    await expect(page.getByLabel('읽고 이어갈 분기')).toHaveValue(candidate.snapshot.branchId!);
    await expect(page.getByLabel('다음 장면 요청')).toHaveValue('SYNTHETIC candidate draft');
    expect((await getDetail(request, chat.id)).sources.find(item => item.id === source.id)?.hash).toBe(createHash('sha256').update(source.text).digest('hex'));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('m1-mobile-reader.png'), fullPage: true });
    expect(errors).toEqual([]);
  } finally { await otherTab.close(); }
});

test('P06 P11 quality notes preserve source and export/backup downloads reject restore into an occupied DB', async ({ page, request }) => {
  const chat = await createChat(page, `합성 P11-${Date.now()}`);
  const run = await send(page, 'SYNTHETIC_ARCHIVE: The letter is still sealed.');
  await expect.poll(async () => (await getDetail(request, chat.id)).runs.find(item => item.id === run.id)?.status).toBe('completed');
  const source = (await getDetail(request, chat.id)).sources[0];
  await page.getByText('요청 충실성 기록', { exact: true }).click();
  await page.getByLabel('요청 충실성 메모', { exact: true }).fill('SYNTHETIC note: retain the sealed letter premise.');
  await page.getByRole('button', { name: '메모 저장', exact: true }).click();
  await expect(page.getByText('요청 충실성 메모: SYNTHETIC note: retain the sealed letter premise.')).toBeVisible();
  const after = await getDetail(request, chat.id);
  expect(after.sources[0]).toEqual(source);
  const archivePanel = page.locator('details').filter({ has: page.locator('summary', { hasText: '내보내기와 복원' }) });
  await archivePanel.locator('summary').click();
  const downloadPromise = page.waitForEvent('download'); await page.getByRole('button', { name: 'JSON 내보내기', exact: true }).click();
  const download = await downloadPromise; const filename = await download.path(); expect(filename).not.toBeNull();
  const bytes = await readFile(filename!); const archive = JSON.parse(bytes.toString('utf8'));
  expect(archive.format).toBe('narrative-archive');
  expect(archive.tables.sources.some((item: { id: string; hash: string }) => item.id === source.id && item.hash === source.hash)).toBe(true);
  const backupPromise = page.waitForEvent('download'); await page.getByRole('button', { name: 'SQLite 백업 다운로드', exact: true }).click();
  const backup = await backupPromise; const dbBytes = await readFile((await backup.path())!);
  expect(dbBytes.subarray(0, 16).toString('utf8')).toBe('SQLite format 3\u0000');
  await page.getByLabel('가져올 JSON 파일').setInputFiles({ name: 'synthetic-export.json', mimeType: 'application/json', buffer: bytes });
  await page.getByRole('button', { name: '빈 DB에 가져오기', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('다른 요청이 먼저 반영됐어요');
  expect((await getDetail(request, chat.id)).sources[0]).toEqual(source);
});
