import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Locator } from '@playwright/test';
import type { HelperConversation, HelperConversationSummary, HelperScope } from '../core/helper.js';
import type { ChatDetail } from '../core/types.js';
import type { Content } from '../core/product.js';
import { fixtureBotInput } from './fixtures/chat.js';
import { createReadingChat } from './fixtures/personal-workspace.js';
import {
  DESKTOP_HEIGHT,
  DESKTOP_WIDTH,
  MOBILE_HEIGHT,
  MOBILE_WIDTH,
} from './fixtures/browser-viewports.js';
import { navigationAction, visibleNavigation } from './ui-navigation.js';

test.setTimeout(60000);

async function createSession(request: APIRequestContext, scope: HelperScope, title: string) {
  const response = await request.post('/api/helper/conversations/new', {
    data: { scope, title, requestKey: randomUUID() },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as HelperConversation;
}

async function openRowMenu(row: Locator, label: string) {
  await row.hover();
  await row.getByLabel(label, { exact: true }).click();
}

async function startProject(history: Locator) {
  await openRowMenu(history.locator('.bot-navigation-header'), '대화 목록 메뉴');
  await history.page().getByRole('button', { name: '프로젝트 만들기', exact: true }).click();
}

test('HSPACE12 activity tabs keep unread counts until acknowledgement and include busy conversations in recent', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: DESKTOP_HEIGHT });
  const title = `활동 탐색 ${randomUUID().slice(0, 8)}`;
  const scope: HelperScope = { kind: 'library', workId: 'workspace' };
  const current = await createSession(request, scope, `${title} 현재`);
  const completed = await createSession(request, scope, `${title} 완료`);
  const failed = await createSession(request, scope, `${title} 실패`);
  const running = await createSession(request, scope, `${title} 실행`);
  const ids = [current.id, completed.id, failed.id, running.id];
  await page.route('**/api/helper/conversations?kind=all', async (route) => {
    const response = await route.fetch();
    const summaries = (await response.json()) as HelperConversationSummary[];
    await route.fulfill({
      response,
      json: summaries
        .filter((item) => ids.includes(item.id))
        .map((item) => ({
          ...item,
          latestActivityEventSeq: item.id === completed.id ? 700 : item.id === failed.id ? 701 : 0,
          lastTaskStatus:
            item.id === completed.id ? 'completed' : item.id === failed.id ? 'failed' : undefined,
          activity: { running: Number(item.id === running.id), queued: 0 },
        })),
    });
  });
  await page.addInitScript(
    (id) => localStorage.setItem('uimori:helper-session:all', id),
    current.id
  );
  await page.goto('/');
  await navigationAction(page, '도우미');
  const history = page.getByRole('navigation', { name: '도우미 대화', exact: true });
  await history.getByRole('tab', { name: '미확인 활동 2개', exact: true }).click();
  const unread = history.locator('[data-activity-section="unread"]');
  const active = history.locator('[data-activity-section="running"]');
  const recent = history.locator('[data-activity-section="recent"]');
  await expect(unread.locator('[data-conversation-id]')).toHaveCount(2);
  await expect(unread.locator(`[data-conversation-id="${completed.id}"]`)).toContainText('완료');
  await expect(unread.locator(`[data-conversation-id="${failed.id}"]`)).toContainText('실패');
  await expect(active.locator('[data-conversation-id]')).toHaveCount(1);
  await expect(recent.locator('[data-conversation-id]')).toHaveCount(4);
  for (const id of ids)
    await expect(recent.locator(`[data-conversation-id="${id}"]`)).toBeVisible();
  await history.getByRole('tab', { name: '탐색', exact: true }).click();
  await history.getByRole('tab', { name: '미확인 활동 2개', exact: true }).click();
  await unread.getByRole('button', { name: `${failed.title} 활동 확인`, exact: true }).click();
  await expect(history.getByRole('tab', { name: '미확인 활동 1개', exact: true })).toBeVisible();
  await page.reload();
  await navigationAction(page, '도우미');
  await expect(history.getByRole('tab', { name: '미확인 활동 1개', exact: true })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  await expect(unread.locator('[data-conversation-id]')).toHaveCount(1);
  await unread.getByRole('button', { name: `${completed.title} 활동 확인`, exact: true }).click();
  await expect(history.getByRole('tab', { name: '미확인 활동 0개', exact: true })).toBeVisible();
  await expect(recent.locator('[data-conversation-id]')).toHaveCount(4);
});

test('HSPACE03 failed-task diagnosis prepares a precise helper draft without starting work', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: MOBILE_WIDTH, height: MOBILE_HEIGHT });
  const { chat } = await createReadingChat(
    request,
    `실패 원인 검토 ${randomUUID().slice(0, 8)}`,
    1
  );
  expect(
    (
      await request.post('/api/test/control', {
        data: { action: 'fail-next', point: 'source-transaction' },
      })
    ).ok()
  ).toBe(true);
  const response = await request.post(`/api/chats/${chat.id}/runs`, {
    data: {
      request: '실패 원인 검토를 위한 합성 요청',
      expectedRevision: chat.headRevision,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: randomUUID(),
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const failed = await response.json();
  const readDetail = async () =>
    (await (await request.get(`/api/chats/${chat.id}`)).json()) as ChatDetail;
  await expect
    .poll(async () => (await readDetail()).runs.find((run) => run.id === failed.id)?.status)
    .toBe('failed');
  const before = await readDetail();
  const admissions: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (
      request.method() === 'POST' &&
      (/^\/api\/helper\/conversations\/[^/]+\/messages$/u.test(path) ||
        /^\/api\/chats\/[^/]+\/runs$/u.test(path) ||
        /^\/api\/runs\/[^/]+\/retry$/u.test(path))
    )
      admissions.push(path);
  });
  await page.goto(`/?chat=${chat.id}`);
  const manuscriptDraft = page.getByRole('textbox', {
    name: '다음 장면 요청',
    exact: true,
    includeHidden: true,
  });
  await manuscriptDraft.fill('실패 분석을 열어도 보존할 원고 요청 초안');
  await navigationAction(page, '작업 현황');
  const tasks = page.getByRole('dialog', { name: '작업 현황', exact: true });
  const row = tasks.locator(`[data-run-id="${failed.id}"]`);
  await row.getByRole('button', { name: '실패 원인 확인', exact: true }).click();
  await expect(tasks).toBeHidden();
  const panel = page.locator('#helper-panel');
  const helperDraft = panel.getByLabel('도우미에게 요청', { exact: true });
  await expect(helperDraft).toHaveValue(new RegExp(failed.id, 'u'));
  await expect(manuscriptDraft).toHaveValue('실패 분석을 열어도 보존할 원고 요청 초안');
  const session = await panel.getByLabel('도우미 대화 선택', { exact: true }).inputValue();
  expect(await (await request.get(`/api/helper/conversations/${session}/tasks`)).json()).toEqual(
    []
  );
  expect(admissions).toEqual([]);
  const after = await readDetail();
  expect(after.runs).toEqual(before.runs);
  expect(after.sources).toEqual(before.sources);
  await panel.getByRole('button', { name: '도우미 닫기', exact: true }).click();
  await expect(manuscriptDraft).toBeVisible();
  await expect(manuscriptDraft).toHaveValue('실패 분석을 열어도 보존할 원고 요청 초안');
  expect(admissions).toEqual([]);
});

test('HSPACE06 shared sidebar preserves drafts and project history across search, copy and project removal', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: DESKTOP_HEIGHT });
  const prefix = `탐색 회귀 ${randomUUID().slice(0, 8)}`;
  const { chat } = await createReadingChat(request, prefix, 1);
  const sessions: HelperConversation[] = [];
  for (let index = 0; index < 7; index++)
    sessions.push(
      await createSession(request, { kind: 'chat', chatId: chat.id }, `${prefix} ${index}`)
    );
  await page.goto(`/?chat=${chat.id}`);
  const mainDraft = page.getByRole('textbox', {
    name: '다음 장면 요청',
    exact: true,
    includeHidden: true,
  });
  await mainDraft.fill('작업 공간을 바꿔도 남길 원고 초안');
  await navigationAction(page, '도우미');
  const panel = page.locator('#helper-panel');
  const picker = panel.getByLabel('도우미 대화 선택', { exact: true });
  const nav = await visibleNavigation(page);
  const history = nav.getByRole('navigation', { name: '도우미 대화', exact: true });
  await expect(panel.getByRole('navigation', { name: '도우미 대화', exact: true })).toHaveCount(0);
  await expect(history).toBeVisible();
  await history.getByRole('tab', { name: /^미확인 활동/u }).click();
  const recent = history.locator('[data-activity-section="recent"]');
  await expect(recent.locator('.activity-nav-link')).toHaveCount(5);
  const existingSessions = (await (
    await request.get('/api/helper/conversations?kind=all')
  ).json()) as HelperConversationSummary[];
  const totalSessions = existingSessions.filter((item) => !item.unused).length;
  await recent
    .getByRole('button', { name: `${Math.min(20, totalSessions - 5)}개 더 보기`, exact: true })
    .click();
  await expect(recent.locator('.activity-nav-link')).toHaveCount(Math.min(25, totalSessions));
  await history.getByRole('tab', { name: '탐색', exact: true }).click();
  const unfiled = history.locator('.helper-nav-unfiled');
  for (const session of sessions)
    expect(existingSessions.find((item) => item.id === session.id)?.projectId).toBeNull();
  const projectTitle = `${prefix} 프로젝트`;
  const search = history.getByRole('searchbox', { name: '대화 검색', exact: true });
  await search.fill('일치하지 않는 검색');
  await startProject(history);
  const createProject = page.getByRole('dialog', { name: '프로젝트 만들기', exact: true });
  await createProject.getByLabel('프로젝트 이름', { exact: true }).fill(projectTitle);
  await createProject.getByRole('button', { name: '프로젝트 이름 저장', exact: true }).click();
  await expect(createProject).toBeHidden();
  const group = history.getByRole('region', { name: projectTitle, exact: true });
  await expect(search).toHaveValue('');
  await expect(group.getByRole('button', { name: projectTitle, exact: true })).toBeFocused();
  await expect(group.getByRole('button', { name: projectTitle, exact: true })).toHaveAttribute(
    'aria-expanded',
    'true'
  );
  await expect(group.locator('[data-conversation-id]')).toHaveCount(0);
  await openRowMenu(
    unfiled.locator(`[data-conversation-id="${sessions[0].id}"]`),
    `${sessions[0].title} 대화 메뉴`
  );
  await page.getByRole('button', { name: '프로젝트로 이동', exact: true }).click();
  const move = page.getByRole('dialog', { name: '프로젝트로 이동', exact: true });
  await move
    .getByRole('combobox', { name: '프로젝트', exact: true })
    .selectOption({ label: projectTitle });
  await move.getByRole('button', { name: '프로젝트로 이동', exact: true }).click();
  await expect(move).toBeHidden();
  await expect(group.locator('[data-conversation-id]')).toHaveCount(1);
  const heading = group.getByRole('button', { name: projectTitle, exact: true });
  await heading.click();
  await expect(heading).toHaveAttribute('aria-expanded', 'false');
  await expect(group.locator('[data-conversation-id]')).toHaveCount(0);
  await search.fill(prefix);
  await expect(history.locator('[data-conversation-id]')).toHaveCount(7);
  await expect(history.locator('.helper-nav-project-heading')).toHaveCount(1);
  const choice = history.locator(`[data-conversation-id="${sessions[0].id}"]`);
  await choice.locator('.chat-link').click();
  await expect(picker).toHaveValue(sessions[0].id);
  const helperDraft = panel.getByLabel('도우미에게 요청', { exact: true });
  await helperDraft.fill('작업 공간을 바꿔도 남길 도우미 초안');
  await nav.getByRole('button', { name: '채팅', exact: true }).click();
  await expect(panel).toBeHidden();
  await expect(mainDraft).toHaveValue('작업 공간을 바꿔도 남길 원고 초안');
  await expect(nav.getByRole('button', { name: '채팅', exact: true })).toHaveAttribute(
    'aria-current',
    'page'
  );
  await nav.getByRole('button', { name: '도우미', exact: true }).click();
  await expect(helperDraft).toHaveValue('작업 공간을 바꿔도 남길 도우미 초안');
  await expect(nav.getByRole('button', { name: '도우미', exact: true })).toHaveAttribute(
    'aria-current',
    'page'
  );
  await search.fill(sessions[0].title);
  await expect(choice).toHaveCount(1);
  await openRowMenu(choice, `${sessions[0].title} 대화 메뉴`);
  await expect(page.getByRole('button', { name: '대화 이름 변경', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '대화 삭제', exact: true })).toBeVisible();
  const original = await (await request.get(`/api/helper/conversations/${sessions[0].id}`)).json();
  await page.getByRole('button', { name: '대화 복사', exact: true }).click();
  await expect(picker).not.toHaveValue(sessions[0].id);
  const copied = (await (
    await request.get(`/api/helper/conversations/${await picker.inputValue()}`)
  ).json()) as HelperConversation;
  expect(copied.scope).toEqual(sessions[0].scope);
  const summaries = (await (
    await request.get('/api/helper/conversations?kind=all')
  ).json()) as HelperConversationSummary[];
  const originalProject = summaries.find((session) => session.id === sessions[0].id)?.projectId;
  expect(originalProject).toBeTruthy();
  expect(summaries.find((session) => session.id === copied.id)?.projectId).toBe(originalProject);
  expect(await (await request.get(`/api/helper/conversations/${sessions[0].id}`)).json()).toEqual(
    original
  );
  await search.fill('');
  await heading.click();
  await openRowMenu(group.locator('.helper-nav-project-heading'), `${projectTitle} 프로젝트 메뉴`);
  await page.getByRole('button', { name: '프로젝트 이름 변경', exact: true }).click();
  const rename = page.getByRole('dialog', { name: '프로젝트 이름 변경', exact: true });
  const renamedTitle = `${projectTitle} 수정`;
  await rename.getByLabel('프로젝트 이름', { exact: true }).fill(renamedTitle);
  await rename.getByRole('button', { name: '프로젝트 이름 저장', exact: true }).click();
  const renamed = history.getByRole('region', { name: renamedTitle, exact: true });
  await expect(renamed).toBeVisible();
  await openRowMenu(
    renamed.locator('.helper-nav-project-heading'),
    `${renamedTitle} 프로젝트 메뉴`
  );
  await page.getByRole('button', { name: '프로젝트 삭제', exact: true }).click();
  const remove = page.getByRole('alertdialog', { name: '프로젝트 삭제', exact: true });
  await expect(remove).toContainText(`${renamedTitle}의 대화는 그대로 남아요.`);
  await remove.getByRole('button', { name: '프로젝트 삭제', exact: true }).click();
  await expect(renamed).toHaveCount(0);
  const retained = await (await request.get(`/api/helper/conversations/${sessions[0].id}`)).json();
  expect(retained).toEqual({
    ...original,
    projectId: null,
    revision: original.revision + 1,
    updatedAt: retained.updatedAt,
  });
  const afterDelete = (await (
    await request.get('/api/helper/conversations?kind=all')
  ).json()) as HelperConversationSummary[];
  expect(afterDelete.find((session) => session.id === sessions[0].id)?.projectId).toBeNull();
  expect(afterDelete.find((session) => session.id === copied.id)?.projectId).toBeNull();
  await search.fill(sessions[0].title);
  await history.locator(`[data-conversation-id="${sessions[0].id}"] .chat-link`).click();
  await expect(picker).toHaveValue(sessions[0].id);
  await expect(helperDraft).toHaveValue('작업 공간을 바꿔도 남길 도우미 초안');
  expect(new URL(page.url()).searchParams.get('chat')).toBe(chat.id);
  await expect(mainDraft).toHaveValue('작업 공간을 바꿔도 남길 원고 초안');
});

test('HSPACE07 project and copy retries recover the same saved result through sessionStorage', async ({
  page,
  request,
}) => {
  const title = `저장소 복구 ${randomUUID().slice(0, 8)}`;
  const { chat } = await createReadingChat(request, title, 1);
  const original = await createSession(request, { kind: 'chat', chatId: chat.id }, title);
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: DESKTOP_HEIGHT });
  await page.goto(`/?chat=${chat.id}`);
  await navigationAction(page, '도우미');
  const panel = page.locator('#helper-panel');
  const history = page.getByRole('navigation', { name: '도우미 대화', exact: true });
  await page.evaluate(() => {
    const originalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (
        this === localStorage &&
        (key.startsWith('uimori:helper-project-create:') || key.startsWith('uimori:helper-copy:'))
      )
        throw new DOMException('Full', 'QuotaExceededError');
      return originalSetItem.call(this, key, value);
    };
  });
  const projectPayloads: unknown[] = [];
  const projectIds: string[] = [];
  await page.route('**/api/helper/projects', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    projectPayloads.push(route.request().postDataJSON());
    if (projectPayloads.length === 2)
      return route.fulfill({ status: 409, json: { error: 'Temporary confirmation failure' } });
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    projectIds.push(((await response.json()) as { id: string }).id);
    if (projectIds.length === 1) await route.abort('failed');
    else await route.fulfill({ response });
  });
  await startProject(history);
  const project = page.getByRole('dialog', { name: '프로젝트 만들기', exact: true });
  await project.getByLabel('프로젝트 이름', { exact: true }).fill(title);
  await project.getByRole('button', { name: '프로젝트 이름 저장', exact: true }).click();
  await expect(project.getByRole('alert')).toBeVisible();
  const projectKey = `uimori:helper-project-create:${title}`;
  expect(
    await page.evaluate((key) => JSON.parse(sessionStorage.getItem(key) ?? 'null'), projectKey)
  ).toEqual(projectPayloads[0]);
  await project.getByRole('button', { name: '프로젝트 이름 저장', exact: true }).click();
  await expect.poll(() => projectPayloads.length).toBe(2);
  await expect(project.getByRole('alert')).toBeVisible();
  expect(
    await page.evaluate((key) => JSON.parse(sessionStorage.getItem(key) ?? 'null'), projectKey)
  ).toEqual(projectPayloads[0]);
  await project.getByRole('button', { name: '프로젝트 이름 저장', exact: true }).click();
  await expect(project).toBeHidden();
  expect(projectPayloads).toHaveLength(3);
  expect(projectPayloads[1]).toEqual(projectPayloads[0]);
  expect(projectPayloads[2]).toEqual(projectPayloads[0]);
  expect(projectIds[1]).toBe(projectIds[0]);
  expect(
    await page.evaluate(
      (key) => [localStorage.getItem(key), sessionStorage.getItem(key)],
      projectKey
    )
  ).toEqual([null, null]);
  await history.getByRole('searchbox', { name: '대화 검색', exact: true }).fill(title);
  const row = history.locator(`[data-conversation-id="${original.id}"]`);
  const copyPayloads: unknown[] = [];
  const copyIds: string[] = [];
  await page.route(`**/api/helper/conversations/${original.id}/copy`, async (route) => {
    copyPayloads.push(route.request().postDataJSON());
    if (copyPayloads.length === 2)
      return route.fulfill({ status: 409, json: { error: 'Temporary confirmation failure' } });
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    copyIds.push(((await response.json()) as { id: string }).id);
    if (copyIds.length === 1) await route.abort('failed');
    else await route.fulfill({ response });
  });
  await openRowMenu(row, `${title} 대화 메뉴`);
  await page.getByRole('button', { name: '대화 복사', exact: true }).click();
  await expect(history.getByRole('alert')).toBeVisible();
  const copyKey = `uimori:helper-copy:${original.id}`;
  expect(
    await page.evaluate((key) => JSON.parse(sessionStorage.getItem(key) ?? 'null'), copyKey)
  ).toEqual(copyPayloads[0]);
  const changed = await request.patch(`/api/helper/conversations/${original.id}`, {
    data: { expectedRevision: original.revision, persona: '응답 유실 후 바뀐 원본 말투' },
  });
  expect(changed.ok(), await changed.text()).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(history.locator('[data-conversation-id]')).toHaveCount(2);
  await openRowMenu(row, `${title} 대화 메뉴`);
  await page.getByRole('button', { name: '대화 복사', exact: true }).click();
  await expect.poll(() => copyPayloads.length).toBe(2);
  await expect(history.getByRole('alert')).toBeVisible();
  expect(
    await page.evaluate((key) => JSON.parse(sessionStorage.getItem(key) ?? 'null'), copyKey)
  ).toEqual(copyPayloads[0]);
  await openRowMenu(row, `${title} 대화 메뉴`);
  await page.getByRole('button', { name: '대화 복사', exact: true }).click();
  await expect(panel.getByLabel('도우미 대화 선택', { exact: true })).toHaveValue(copyIds[0]);
  expect(copyPayloads).toHaveLength(3);
  expect(copyPayloads[1]).toEqual(copyPayloads[0]);
  expect(copyPayloads[2]).toEqual(copyPayloads[0]);
  expect(copyIds[1]).toBe(copyIds[0]);
  expect(
    await page.evaluate((key) => [localStorage.getItem(key), sessionStorage.getItem(key)], copyKey)
  ).toEqual([null, null]);
  const copies = (await (
    await request.get(`/api/helper/conversations?kind=chat&chatId=${chat.id}`)
  ).json()) as HelperConversationSummary[];
  expect(copies).toHaveLength(2);
});

test('HSPACE02 expanding a resource helper preserves its unsaved editor', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: MOBILE_WIDTH, height: MOBILE_HEIGHT });
  const response = await request.post('/api/content', {
    data: fixtureBotInput(`편집 중인 자료 ${randomUUID().slice(0, 8)}`, '저장된 원래 인물 설명'),
  });
  expect(response.ok()).toBe(true);
  const resource = (await response.json()) as Content;
  await page.goto('/');
  await navigationAction(page, '서재');
  await page.getByRole('searchbox', { name: '서재 검색', exact: true }).fill(resource.title);
  await page.getByRole('button', { name: `${resource.title} 편집`, exact: true }).click();
  const editor = page.getByLabel(/^(봇|페르소나|모듈) 이름$/u);
  await editor.fill('저장하지 않은 인물 이름');
  await page
    .getByRole('region', { name: '자료 상세', exact: true })
    .getByRole('button', { name: '도우미 열기', exact: true })
    .click();
  const panel = page.locator('#helper-panel');
  const input = panel.getByLabel('도우미에게 요청', { exact: true });
  await expect(input).toBeEnabled();
  await input.fill('이 자료를 검토하려고 남긴 도우미 초안');
  const session = await panel.getByLabel('도우미 대화 선택', { exact: true }).inputValue();
  await panel.getByRole('button', { name: '도우미 크게 보기', exact: true }).click();
  await expect(panel).toHaveClass(/helper-expanded/u);
  await expect(editor).toBeAttached();
  await expect(editor).toBeHidden();
  await expect(input).toHaveValue('이 자료를 검토하려고 남긴 도우미 초안');
  await panel.getByRole('button', { name: '서재', exact: true }).click();
  await expect(panel).not.toHaveClass(/helper-expanded/u);
  await expect(panel.getByLabel('도우미 대화 선택', { exact: true })).toHaveValue(session);
  await expect(input).toHaveValue('이 자료를 검토하려고 남긴 도우미 초안');
  await panel.getByRole('button', { name: '도우미 닫기', exact: true }).click();
  await expect(editor).toBeVisible();
  await expect(editor).toHaveValue('저장하지 않은 인물 이름');
  await editor.fill('돌아온 뒤 다시 고친 인물 이름');
  await page
    .getByRole('region', { name: '자료 상세', exact: true })
    .getByRole('button', { name: '도우미 열기', exact: true })
    .click();
  const context = panel.locator('.helper-editor-draft .helper-chip-label');
  await expect(context).toHaveText('편집 중: 돌아온 뒤 다시 고친 인물 이름');
  await expect(input).toHaveValue('이 자료를 검토하려고 남긴 도우미 초안');
  await panel.getByRole('button', { name: '도우미 크게 보기', exact: true }).click();
  await expect(panel).toHaveClass(/helper-expanded/u);
  const expandedTitle = await context.textContent();
  const admission = page.waitForRequest(
    (request) =>
      request.method() === 'POST' &&
      new URL(request.url()).pathname === `/api/helper/conversations/${session}/messages`
  );
  await page.route(`**/api/helper/conversations/${session}/messages`, (route) =>
    route.fulfill({ status: 400, contentType: 'application/json', body: '{"error":"synthetic"}' })
  );
  await panel.getByRole('button', { name: '도우미 요청 보내기', exact: true }).click();
  const body = (await admission).postDataJSON();
  expect({ title: expandedTitle, editorTitle: body.editor?.model?.title }).toEqual({
    title: '편집 중: 돌아온 뒤 다시 고친 인물 이름',
    editorTitle: '돌아온 뒤 다시 고친 인물 이름',
  });
  await panel.getByRole('button', { name: '서재', exact: true }).click();
  await panel.getByRole('button', { name: '도우미 닫기', exact: true }).click();
  await expect(editor).toHaveValue('돌아온 뒤 다시 고친 인물 이름');
  const saved = (await (await request.get(`/api/content/${resource.id}`)).json()) as Content;
  expect(saved).toEqual(resource);
});
