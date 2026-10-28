import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { Content } from '../core/product.js';
import type { HelperConversation, HelperConversationSummary, HelperScope } from '../core/helper.js';
import type { ChatDetail } from '../core/types.js';
import { createDefaultRisuPrompt } from '../core/prompt-defaults.js';
import { fixtureBotInput, postFixtureChat } from './fixtures/chat.js';
import { createReadingChat } from './fixtures/personal-workspace.js';
import {
  DESKTOP_HEIGHT,
  DESKTOP_WIDTH,
  MOBILE_HEIGHT,
  MOBILE_WIDTH,
} from './fixtures/browser-viewports.js';
import {
  navigationAction,
  openHelper,
  selectSettingsSection,
  visibleNavigation,
} from './ui-navigation.js';

test.setTimeout(60000);

async function createSession(request: APIRequestContext, scope: HelperScope, title: string) {
  const response = await request.post('/api/helper/conversations/new', {
    data: { scope, title, requestKey: randomUUID() },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as HelperConversation;
}

test('HSPACE03 failed-task diagnosis prepares a precise helper draft without starting work', async ({
  page,
  request,
}, info) => {
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
  await expect(helperDraft).toHaveValue(
    `이 작업의 실패 원인을 확인해 주세요. 작업 종류: run, 작업 ID: ${failed.id}.`
  );
  await expect(manuscriptDraft).toHaveValue('실패 분석을 열어도 보존할 원고 요청 초안');
  const session = await panel.getByLabel('도우미 세션 선택', { exact: true }).inputValue();
  expect(await (await request.get(`/api/helper/conversations/${session}/tasks`)).json()).toEqual(
    []
  );
  expect(admissions).toEqual([]);
  const after = await readDetail();
  expect(after.runs).toEqual(before.runs);
  expect(after.sources).toEqual(before.sources);
  await page.screenshot({ path: info.outputPath('helper-failed-task-draft-412.png') });
  await panel.getByRole('button', { name: '도우미 닫기', exact: true }).click();
  await expect(manuscriptDraft).toBeVisible();
  await expect(manuscriptDraft).toHaveValue('실패 분석을 열어도 보존할 원고 요청 초안');
  expect(admissions).toEqual([]);
});

test('HSPACE04 a prompt-card target can be explicitly attached again after expansion and return', async ({
  page,
  request,
}, info) => {
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: DESKTOP_HEIGHT });
  const title = `다시 첨부할 프롬프트 ${randomUUID().slice(0, 8)}`;
  const response = await request.post('/api/prompt-presets', {
    data: {
      title,
      role: 'main',
      program: createDefaultRisuPrompt('Synthetic prompt for attachment.', 'main'),
      values: {},
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const saved = await response.json();
  await page.goto('/');
  await navigationAction(page, '프롬프트');
  await page.getByLabel('프롬프트 검색', { exact: true }).fill(title);
  const attach = async () => {
    const menu = page.getByLabel(`${title} 메뉴`, { exact: true });
    await menu.click();
    await menu.locator('..').getByRole('button', { name: '도우미에게 묻기', exact: true }).click();
  };
  await attach();
  const panel = page.locator('#helper-panel');
  const input = panel.getByLabel('도우미에게 요청', { exact: true });
  const chip = panel.locator('.helper-context-chip.helper-editor');
  await expect(input).toBeEnabled();
  await expect(chip).toContainText(`참고 자료: ${title}`);
  await input.fill('프롬프트 대상을 다시 붙여도 남길 초안');
  const session = await panel.getByLabel('도우미 세션 선택', { exact: true }).inputValue();
  await panel.getByRole('button', { name: '도우미 크게 보기', exact: true }).click();
  await expect(panel).toHaveClass(/helper-expanded/u);
  await panel.getByRole('button', { name: '프롬프트', exact: true }).click();
  await expect(panel).not.toHaveClass(/helper-expanded/u);
  await chip.getByRole('button', { name: '대상 해제', exact: true }).click();
  await expect(chip).toHaveCount(0);
  await panel.getByRole('button', { name: '도우미 닫기', exact: true }).click();
  await attach();
  await expect(chip).toContainText(`참고 자료: ${title}`);
  await expect(panel.getByLabel('도우미 세션 선택', { exact: true })).toHaveValue(session);
  await expect(input).toHaveValue('프롬프트 대상을 다시 붙여도 남길 초안');
  await page.screenshot({ path: info.outputPath('helper-reattached-prompt-2560.png') });
  expect(await (await request.get(`/api/prompt-presets/${saved.id}`)).json()).toEqual(saved);
  expect(await (await request.get(`/api/helper/conversations/${session}/tasks`)).json()).toEqual(
    []
  );
});

test('HSPACE05 a contextual reopen attaches the editor after an independent workspace session', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: DESKTOP_HEIGHT });
  const response = await request.post('/api/content', {
    data: fixtureBotInput(`다시 연결할 자료 ${randomUUID().slice(0, 8)}`),
  });
  expect(response.ok()).toBe(true);
  const resource = (await response.json()) as Content;
  const session = await createSession(
    request,
    { kind: 'library', workId: 'library:bot' },
    '별도 작업'
  );
  await page.goto('/');
  await navigationAction(page, '서재');
  await page.getByRole('searchbox', { name: '서재 검색', exact: true }).fill(resource.title);
  await page.getByRole('button', { name: `${resource.title} 상세 보기`, exact: true }).click();
  await page.getByRole('button', { name: '편집', exact: true }).click();
  await page.getByLabel('Risu 자료 이름', { exact: true }).fill('연결할 현재 편집 내용');
  await navigationAction(page, '도우미');
  const panel = page.locator('#helper-panel');
  await page
    .getByRole('navigation', { name: '도우미 대화', exact: true })
    .locator('.helper-nav-select')
    .filter({ hasText: session.title })
    .first()
    .click();
  await expect(panel.getByLabel('도우미 세션 선택', { exact: true })).toHaveValue(session.id);
  await expect(panel.locator('details.helper-editor')).toHaveCount(0);
  await panel.getByRole('button', { name: '서재', exact: true }).click();
  await expect(panel).toBeHidden();
  await page
    .getByRole('region', { name: '자료 상세', exact: true })
    .getByRole('button', { name: '도우미 열기', exact: true })
    .click();
  await expect(panel).not.toHaveClass(/helper-expanded/u);
  const input = panel.getByLabel('도우미에게 요청', { exact: true });
  await expect(input).toBeEnabled();
  await expect(panel.locator('details.helper-editor > summary')).toHaveText(
    '편집 중: 연결할 현재 편집 내용'
  );
  await input.fill('현재 편집 내용을 확인해 주세요');
  const admission = page.waitForRequest(
    (incoming) =>
      incoming.method() === 'POST' &&
      new URL(incoming.url()).pathname === `/api/helper/conversations/${session.id}/messages`
  );
  await page.route(`**/api/helper/conversations/${session.id}/messages`, (route) =>
    route.fulfill({ status: 400, contentType: 'application/json', body: '{"error":"synthetic"}' })
  );
  await panel.getByRole('button', { name: '도우미 요청 보내기', exact: true }).click();
  expect((await admission).postDataJSON().editor?.model?.title).toBe('연결할 현재 편집 내용');
});

async function expectWithinViewport(page: Page, expanded = false) {
  const panel = page.locator('#helper-panel');
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth))
    .toBeLessThanOrEqual(1);
  const input = panel.getByLabel('도우미에게 요청', { exact: true });
  await expect(input).toBeInViewport();
  const box = await panel.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  if (expanded) expect(box!.x + box!.width).toBeCloseTo(page.viewportSize()!.width, 0);
}

test('HSPACE06 shared sidebar preserves drafts and project history across search, copy and project removal', async ({
  page,
  request,
}, info) => {
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
  const picker = panel.getByLabel('도우미 세션 선택', { exact: true });
  const nav = await visibleNavigation(page);
  const history = nav.getByRole('navigation', { name: '도우미 대화', exact: true });
  await expect(panel.getByRole('navigation', { name: '도우미 대화', exact: true })).toHaveCount(0);
  await expect(history).toBeVisible();
  const recent = history.getByRole('region', { name: '최근 대화', exact: true });
  await expect(recent.locator('.helper-nav-select')).toHaveCount(5);
  const totalSessions = (
    (await (
      await request.get('/api/helper/conversations?kind=all')
    ).json()) as HelperConversationSummary[]
  ).length;
  await recent
    .getByRole('button', { name: `${Math.min(5, totalSessions - 5)}개 더 보기`, exact: true })
    .click();
  await expect(recent.locator('.helper-nav-select')).toHaveCount(Math.min(10, totalSessions));
  await expect(history.locator('.helper-nav-heading')).toHaveCount(0);
  const projectTitle = `${prefix} 프로젝트`;
  const search = history.getByRole('searchbox', { name: '대화 검색', exact: true });
  await search.fill('일치하지 않는 검색');
  await history.getByRole('button', { name: '프로젝트 만들기', exact: true }).click();
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
  await expect(group.locator('.helper-nav-select')).toHaveCount(0);
  await recent.getByLabel(`${sessions[0].title} 대화 메뉴`, { exact: true }).click();
  await page.getByRole('button', { name: '프로젝트로 이동', exact: true }).click();
  const move = page.getByRole('dialog', { name: '프로젝트로 이동', exact: true });
  await move
    .getByRole('combobox', { name: '프로젝트', exact: true })
    .selectOption({ label: projectTitle });
  await move.getByRole('button', { name: '프로젝트로 이동', exact: true }).click();
  await expect(move).toBeHidden();
  await expect(group.locator('.helper-nav-select')).toHaveCount(1);
  const heading = group.getByRole('button', { name: projectTitle, exact: true });
  await heading.click();
  await expect(heading).toHaveAttribute('aria-expanded', 'false');
  await expect(group.locator('.helper-nav-select')).toHaveCount(0);
  await search.fill(prefix);
  await expect(history.locator('.helper-nav-select')).toHaveCount(7);
  await expect(history.locator('.helper-nav-heading')).toHaveCount(0);
  const choice = history.locator(`[data-conversation-id="${sessions[0].id}"]`);
  await choice.locator('.helper-nav-select').click();
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
  await choice.getByLabel(`${sessions[0].title} 대화 메뉴`, { exact: true }).click();
  await expect(page.getByRole('button', { name: '세션 이름 변경', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '세션 삭제', exact: true })).toBeVisible();
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
  await page.screenshot({ path: info.outputPath('helper-project-sidebar-2560.png') });
  await group.getByLabel(`${projectTitle} 프로젝트 메뉴`, { exact: true }).click();
  await page.getByRole('button', { name: '프로젝트 이름 변경', exact: true }).click();
  const rename = page.getByRole('dialog', { name: '프로젝트 이름 변경', exact: true });
  const renamedTitle = `${projectTitle} 수정`;
  await rename.getByLabel('프로젝트 이름', { exact: true }).fill(renamedTitle);
  await rename.getByRole('button', { name: '프로젝트 이름 저장', exact: true }).click();
  const renamed = history.getByRole('region', { name: renamedTitle, exact: true });
  await expect(renamed).toBeVisible();
  await renamed.getByLabel(`${renamedTitle} 프로젝트 메뉴`, { exact: true }).click();
  await page.getByRole('button', { name: '프로젝트 삭제', exact: true }).click();
  const remove = page.getByRole('alertdialog', { name: '프로젝트 삭제', exact: true });
  await expect(remove).toContainText(`${renamedTitle}의 대화는 그대로 남아요.`);
  await remove.getByRole('button', { name: '프로젝트 삭제', exact: true }).click();
  await expect(renamed).toHaveCount(0);
  const retained = await (await request.get(`/api/helper/conversations/${sessions[0].id}`)).json();
  expect(retained).toEqual({
    ...original,
    revision: original.revision + 1,
    updatedAt: retained.updatedAt,
  });
  const afterDelete = (await (
    await request.get('/api/helper/conversations?kind=all')
  ).json()) as HelperConversationSummary[];
  expect(afterDelete.find((session) => session.id === sessions[0].id)?.projectId).toBeNull();
  expect(afterDelete.find((session) => session.id === copied.id)?.projectId).toBeNull();
  await search.fill(sessions[0].title);
  await history.locator(`[data-conversation-id="${sessions[0].id}"] .helper-nav-select`).click();
  await expect(picker).toHaveValue(sessions[0].id);
  await expect(helperDraft).toHaveValue('작업 공간을 바꿔도 남길 도우미 초안');
  expect(new URL(page.url()).searchParams.get('chat')).toBe(chat.id);
  await expect(mainDraft).toHaveValue('작업 공간을 바꿔도 남길 원고 초안');
  await page.setViewportSize({ width: MOBILE_WIDTH, height: MOBILE_HEIGHT });
  const drawer = page.getByRole('dialog', { name: '탐색', exact: true });
  const mobileNav = await visibleNavigation(page);
  const mobileHistory = mobileNav.getByRole('navigation', { name: '도우미 대화', exact: true });
  await page.screenshot({ path: info.outputPath('helper-history-drawer-412.png') });
  await mobileHistory
    .getByRole('searchbox', { name: '대화 검색', exact: true })
    .fill(sessions[1].title);
  await mobileHistory
    .locator(`[data-conversation-id="${sessions[1].id}"] .helper-nav-select`)
    .click();
  await expect(drawer).toBeHidden();
  await expect(picker).toHaveValue(sessions[1].id);
  await helperDraft.fill('모바일에서 선택한 세션의 초안');
  await visibleNavigation(page);
  await mobileHistory
    .getByRole('searchbox', { name: '대화 검색', exact: true })
    .fill(sessions[0].title);
  await mobileHistory
    .locator(`[data-conversation-id="${sessions[0].id}"] .helper-nav-select`)
    .click();
  await expect(drawer).toBeHidden();
  await expect(picker).toHaveValue(sessions[0].id);
  await expect(helperDraft).toHaveValue('작업 공간을 바꿔도 남길 도우미 초안');
});

for (const width of [DESKTOP_WIDTH, MOBILE_WIDTH]) {
  test(`HSPACE09 workspace quick actions keep drafts and target helper at ${width}px`, async ({
    page,
    request,
  }, info) => {
    await page.setViewportSize({
      width,
      height: width === MOBILE_WIDTH ? MOBILE_HEIGHT : DESKTOP_HEIGHT,
    });
    const { chat } = await createReadingChat(request, `빠른 탐색 ${randomUUID().slice(0, 8)}`, 1);
    await page.goto(`/?chat=${chat.id}`);
    const draft = page.getByRole('textbox', {
      name: '다음 장면 요청',
      exact: true,
      includeHidden: true,
    });
    await draft.fill('남겨 둘 원고 초안');
    const admissions: string[] = [];
    page.on('request', (item) => {
      if (
        item.method() === 'POST' &&
        /\/api\/(?:helper\/conversations\/[^/]+\/messages|chats\/[^/]+\/runs)$/u.test(
          new URL(item.url()).pathname
        )
      )
        admissions.push(item.url());
    });
    if (width !== MOBILE_WIDTH) {
      await openHelper(page);
      const storyActions = (await visibleNavigation(page)).locator('.navigation-quick-actions');
      await expect(
        storyActions.getByRole('button', { name: '새 채팅', exact: true })
      ).toBeVisible();
      await expect(
        storyActions.getByRole('button', { name: '전체 채팅 검색', exact: true })
      ).toBeVisible();
    }
    await navigationAction(page, '도우미');
    const panel = page.locator('#helper-panel');
    const picker = panel.getByLabel('도우미 세션 선택', { exact: true });
    await expect(picker).not.toHaveValue('');
    const previous = await picker.inputValue();
    const helperDraft = panel.getByLabel('도우미에게 요청', { exact: true });
    await helperDraft.fill('남겨 둘 도우미 초안');
    let nav = await visibleNavigation(page);
    if (width !== MOBILE_WIDTH) {
      await nav.getByRole('button', { name: '좌측 패널 접기', exact: true }).click();
      nav = await visibleNavigation(page);
    }
    const actions =
      width === MOBILE_WIDTH
        ? page
            .getByRole('dialog', { name: '탐색', exact: true })
            .locator('.navigation-quick-actions')
        : nav.locator('.navigation-quick-actions');
    await actions.getByRole('button', { name: '대화 검색', exact: true }).click();
    const history = page.getByRole('navigation', { name: '도우미 대화', exact: true });
    const search = history.getByRole('searchbox', { name: '대화 검색', exact: true });
    await expect(search).toBeFocused();
    await search.fill('일치하지 않는 검색');
    await expect(history.getByRole('status')).toBeVisible();
    if (width !== MOBILE_WIDTH)
      await expect(page.locator('#workspace-sidebar')).toHaveCSS('width', '320px');
    await page.screenshot({ path: info.outputPath(`helper-quick-actions-${width}.png`) });
    await actions.getByRole('button', { name: '새 대화', exact: true }).click();
    await expect(picker).not.toHaveValue(previous);
    if (width === MOBILE_WIDTH) await picker.selectOption(previous);
    else {
      await search.fill('');
      await history
        .locator(`[data-conversation-id="${previous}"] .helper-nav-select`)
        .first()
        .click();
    }
    await expect(helperDraft).toHaveValue('남겨 둘 도우미 초안');
    await expect(draft).toHaveValue('남겨 둘 원고 초안');
    expect(new URL(page.url()).searchParams.get('chat')).toBe(chat.id);
    expect(admissions).toEqual([]);
  });
}

test('HSPACE07 project and copy retries recover the same saved result through sessionStorage and refresh projects on focus', async ({
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
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    projectIds.push(((await response.json()) as { id: string }).id);
    if (projectIds.length === 1) await route.abort('failed');
    else await route.fulfill({ response });
  });
  await history.getByRole('button', { name: '프로젝트 만들기', exact: true }).click();
  const project = page.getByRole('dialog', { name: '프로젝트 만들기', exact: true });
  await project.getByLabel('프로젝트 이름', { exact: true }).fill(title);
  await project.getByRole('button', { name: '프로젝트 이름 저장', exact: true }).click();
  await expect(project.getByRole('alert')).toBeVisible();
  const projectKey = `uimori:helper-project-create:${title}`;
  expect(
    await page.evaluate((key) => JSON.parse(sessionStorage.getItem(key) ?? 'null'), projectKey)
  ).toEqual(projectPayloads[0]);
  await project.getByRole('button', { name: '프로젝트 이름 저장', exact: true }).click();
  await expect(project).toBeHidden();
  expect(projectPayloads).toHaveLength(2);
  expect(projectPayloads[1]).toEqual(projectPayloads[0]);
  expect(projectIds[1]).toBe(projectIds[0]);
  expect(
    await page.evaluate(
      (key) => [localStorage.getItem(key), sessionStorage.getItem(key)],
      projectKey
    )
  ).toEqual([null, null]);
  const renamedTitle = `${title} 외부 변경`;
  const rename = await request.patch(`/api/helper/projects/${projectIds[0]}`, {
    data: { title: renamedTitle, expectedRevision: 1 },
  });
  expect(rename.ok(), await rename.text()).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(history.getByRole('region', { name: renamedTitle, exact: true })).toBeVisible();
  await expect(history.getByRole('region', { name: title, exact: true })).toHaveCount(0);
  await history.getByRole('searchbox', { name: '대화 검색', exact: true }).fill(title);
  const row = history.locator('.helper-nav-row').filter({ hasText: title });
  const copyPayloads: unknown[] = [];
  const copyIds: string[] = [];
  await page.route(`**/api/helper/conversations/${original.id}/copy`, async (route) => {
    copyPayloads.push(route.request().postDataJSON());
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    copyIds.push(((await response.json()) as { id: string }).id);
    if (copyIds.length === 1) await route.abort('failed');
    else await route.fulfill({ response });
  });
  await row.getByLabel(`${title} 대화 메뉴`, { exact: true }).click();
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
  await history.getByLabel(`${title} 대화 메뉴`, { exact: true }).click();
  await page.getByRole('button', { name: '대화 복사', exact: true }).click();
  await expect(panel.getByLabel('도우미 세션 선택', { exact: true })).toHaveValue(copyIds[0]);
  expect(copyPayloads).toHaveLength(2);
  expect(copyPayloads[1]).toEqual(copyPayloads[0]);
  expect(copyIds[1]).toBe(copyIds[0]);
  expect(
    await page.evaluate((key) => [localStorage.getItem(key), sessionStorage.getItem(key)], copyKey)
  ).toEqual([null, null]);
  const copies = (await (
    await request.get(`/api/helper/conversations?kind=chat&chatId=${chat.id}`)
  ).json()) as HelperConversationSummary[];
  expect(copies).toHaveLength(2);
});

for (const viewport of [
  { width: DESKTOP_WIDTH, height: DESKTOP_HEIGHT },
  { width: MOBILE_WIDTH, height: MOBILE_HEIGHT },
]) {
  test(`HSPACE01 expanded helper keeps reader state and session drafts across chats at ${viewport.width}px`, async ({
    page,
    request,
  }, info) => {
    await page.setViewportSize(viewport);
    const { chat, detail } = await createReadingChat(
      request,
      `도우미를 다녀와도 남는 원고 ${randomUUID().slice(0, 8)}`,
      1
    );
    const source = detail.sources[0];
    const text = Array.from(
      { length: 35 },
      (_, index) =>
        `${index + 1}. 비가 그친 도서관에서 하린은 접어 둔 편지를 펼쳤다. 창밖의 은행나무가 바람에 흔들리고, 오래된 책장 사이로 작은 발소리가 이어졌다.`
    ).join('\n\n');
    const edited = await request.put(`/api/sources/${source.id}/text`, {
      data: { expectedRevision: source.editRevision ?? 0, text },
    });
    expect(edited.ok(), await edited.text()).toBe(true);
    const otherResponse = await postFixtureChat(request, {
      data: { title: `다른 원고 ${randomUUID().slice(0, 8)}` },
    });
    expect(otherResponse.ok()).toBe(true);
    const other = await otherResponse.json();
    const resourceResponse = await request.post('/api/content', {
      data: fixtureBotInput(`자료 검토용 인물 ${randomUUID().slice(0, 8)}`),
    });
    expect(resourceResponse.ok()).toBe(true);
    const resource = (await resourceResponse.json()) as Content;
    const own = await createSession(
      request,
      { kind: 'chat', chatId: chat.id },
      `${chat.title} · 전개 검토`
    );
    const foreign = await createSession(
      request,
      { kind: 'chat', chatId: other.id },
      `${other.title} · 결말 검토`
    );
    const library = await createSession(
      request,
      { kind: 'library', workId: resource.id },
      `${resource.title} · 인물 설정 검토`
    );
    await page.goto(`/?chat=${chat.id}&source=${source.id}&mode=original`);
    await expect(page.getByTestId('source')).toContainText('비가 그친 도서관');
    const mainInput = page.getByRole('textbox', {
      name: '다음 장면 요청',
      exact: true,
      includeHidden: true,
    });
    await mainInput.fill('원고를 떠나지 않고 보관할 다음 장면 초안');
    const reader = page.locator('[data-reader-scrollport]');
    await reader.evaluate((node) => {
      node.scrollTop = 480;
    });
    await expect.poll(() => reader.evaluate((node) => node.scrollTop)).toBeGreaterThan(100);

    await openHelper(page);
    const panel = page.locator('#helper-panel');
    const input = panel.getByLabel('도우미에게 요청', { exact: true });
    const picker = panel.getByLabel('도우미 세션 선택', { exact: true });
    await expect(input).toBeEnabled();
    await picker.selectOption(own.id);
    await input.fill('옆에서 시작해서 크게 보아도 남을 도우미 초안');
    await expectWithinViewport(page);
    await page.screenshot({ path: info.outputPath(`helper-sidecar-${viewport.width}.png`) });
    const scrollBefore = await reader.evaluate((node) => node.scrollTop);
    await panel.getByRole('button', { name: '도우미 크게 보기', exact: true }).click();
    await expect(panel).toHaveClass(/helper-expanded/u);
    await expect(picker).toHaveValue(own.id);
    await expect(input).toHaveValue('옆에서 시작해서 크게 보아도 남을 도우미 초안');
    await expect(mainInput).toHaveValue('원고를 떠나지 않고 보관할 다음 장면 초안');
    await expect(page.getByTestId('source')).toBeAttached();
    await expect(page.getByTestId('source')).toBeHidden();
    await expectWithinViewport(page, true);
    await page.screenshot({
      path: info.outputPath(`helper-expanded-from-sidecar-${viewport.width}.png`),
    });
    await panel.getByRole('button', { name: chat.title, exact: true }).click();
    await expect(panel).not.toHaveClass(/helper-expanded/u);
    await expect(input).toHaveValue('옆에서 시작해서 크게 보아도 남을 도우미 초안');
    await expect.poll(() => reader.evaluate((node) => node.scrollTop)).toBeCloseTo(scrollBefore, 0);
    await panel.getByRole('button', { name: '도우미 닫기', exact: true }).click();
    await expect(panel).toBeHidden();
    await expect(mainInput).toBeVisible();
    await expect(mainInput).toHaveValue('원고를 떠나지 않고 보관할 다음 장면 초안');

    await navigationAction(page, '도우미');
    await expect(panel).toHaveClass(/helper-expanded/u);
    const list = page.getByRole('navigation', { name: '도우미 대화', exact: true });
    const foreignChoice = list
      .locator('.helper-nav-select')
      .filter({ hasText: foreign.title })
      .first();
    const selectSession = async (session: HelperConversation) => {
      if (viewport.width === MOBILE_WIDTH) await picker.selectOption(session.id);
      else
        await list.locator('.helper-nav-select').filter({ hasText: session.title }).first().click();
    };
    if (viewport.width !== MOBILE_WIDTH) await expect(foreignChoice).toContainText(other.title);
    await selectSession(foreign);
    await expect(picker).toHaveValue(foreign.id);
    await expect(input).toBeEnabled();
    await input.fill('다른 원고 세션에만 남길 초안');
    await selectSession(library);
    await expect(picker).toHaveValue(library.id);
    await expect(input).toBeEnabled();
    await input.fill('서재 세션에만 남길 초안');
    await selectSession(own);
    await expect(picker).toHaveValue(own.id);
    await expect(input).toHaveValue('옆에서 시작해서 크게 보아도 남을 도우미 초안');
    await selectSession(foreign);
    await expect(input).toHaveValue('다른 원고 세션에만 남길 초안');
    if (viewport.width !== MOBILE_WIDTH)
      await expect(foreignChoice).toHaveAttribute('aria-current', 'true');
    expect(new URL(page.url()).searchParams.get('chat')).toBe(chat.id);
    await expect(mainInput).toHaveValue('원고를 떠나지 않고 보관할 다음 장면 초안');

    for (const theme of ['dark', 'light']) {
      await navigationAction(page, '설정');
      await selectSettingsSection(page, '일반');
      await page.getByLabel('앱 화면 테마', { exact: true }).selectOption(theme);
      await page.getByRole('button', { name: '설정 닫기', exact: true }).click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(picker).toHaveValue(foreign.id);
      await expect(input).toHaveValue('다른 원고 세션에만 남길 초안');
      await expectWithinViewport(page, true);
      await page.screenshot({
        path: info.outputPath(`helper-workspace-${theme}-${viewport.width}.png`),
      });
    }
    await panel.getByRole('button', { name: chat.title, exact: true }).click();
    await expect(panel).toBeHidden();
    await expect(mainInput).toBeVisible();
    await expect(mainInput).toHaveValue('원고를 떠나지 않고 보관할 다음 장면 초안');
    await expect(page.getByTestId('source')).toContainText('비가 그친 도서관');
    expect(new URL(page.url()).searchParams.get('chat')).toBe(chat.id);
    await navigationAction(page, '도우미');
    await expect(panel).toHaveClass(/helper-expanded/u);
    await expect(picker).toHaveValue(foreign.id);
    await expect(input).toHaveValue('다른 원고 세션에만 남길 초안');
    await panel.getByRole('button', { name: chat.title, exact: true }).click();
    await expect(panel).toBeHidden();
    await page.reload();
    await expect(mainInput).toHaveValue('원고를 떠나지 않고 보관할 다음 장면 초안');
    await navigationAction(page, '도우미');
    await expect(panel).toHaveClass(/helper-expanded/u);
    await expect(picker).toHaveValue(foreign.id);
    await expect(input).toHaveValue('다른 원고 세션에만 남길 초안');
    expect(new URL(page.url()).searchParams.get('chat')).toBe(chat.id);
    await panel.getByRole('button', { name: chat.title, exact: true }).click();
    await expect(panel).toBeHidden();
    const retained = (await (await request.get(`/api/chats/${chat.id}`)).json()) as ChatDetail;
    expect(retained.sources[0].text).toBe(text);
    expect(retained.runs).toEqual(detail.runs);
    expect(
      (await (await request.get(`/api/helper/conversations/${foreign.id}`)).json()).scope
    ).toEqual({ kind: 'chat', chatId: other.id });
    expect(
      (await (await request.get(`/api/helper/conversations/${library.id}`)).json()).scope
    ).toEqual({ kind: 'library', workId: resource.id });
  });

  test(`HSPACE02 expanding a resource helper preserves its unsaved editor at ${viewport.width}px`, async ({
    page,
    request,
  }, info) => {
    await page.setViewportSize(viewport);
    const response = await request.post('/api/content', {
      data: fixtureBotInput(`편집 중인 자료 ${randomUUID().slice(0, 8)}`, '저장된 원래 인물 설명'),
    });
    expect(response.ok()).toBe(true);
    const resource = (await response.json()) as Content;
    await page.goto('/');
    await navigationAction(page, '서재');
    await page.getByRole('searchbox', { name: '서재 검색', exact: true }).fill(resource.title);
    await page.getByRole('button', { name: `${resource.title} 상세 보기`, exact: true }).click();
    await page.getByRole('button', { name: '편집', exact: true }).click();
    const editor = page.getByLabel('Risu 자료 이름', { exact: true });
    await editor.fill('저장하지 않은 인물 이름');
    await page
      .getByRole('region', { name: '자료 상세', exact: true })
      .getByRole('button', { name: '도우미 열기', exact: true })
      .click();
    const panel = page.locator('#helper-panel');
    const input = panel.getByLabel('도우미에게 요청', { exact: true });
    await expect(input).toBeEnabled();
    await input.fill('이 자료를 검토하려고 남긴 도우미 초안');
    const session = await panel.getByLabel('도우미 세션 선택', { exact: true }).inputValue();
    await panel.getByRole('button', { name: '도우미 크게 보기', exact: true }).click();
    await expect(panel).toHaveClass(/helper-expanded/u);
    await expect(editor).toBeAttached();
    await expect(editor).toBeHidden();
    await expect(input).toHaveValue('이 자료를 검토하려고 남긴 도우미 초안');
    await expectWithinViewport(page, true);
    await page.screenshot({
      path: info.outputPath(`helper-expanded-resource-${viewport.width}.png`),
    });
    await panel.getByRole('button', { name: '서재', exact: true }).click();
    await expect(panel).not.toHaveClass(/helper-expanded/u);
    await expect(panel.getByLabel('도우미 세션 선택', { exact: true })).toHaveValue(session);
    await expect(input).toHaveValue('이 자료를 검토하려고 남긴 도우미 초안');
    if (viewport.width === MOBILE_WIDTH)
      await panel.getByRole('button', { name: '도우미 닫기', exact: true }).click();
    await expect(editor).toBeVisible();
    await expect(editor).toHaveValue('저장하지 않은 인물 이름');
    await editor.fill('돌아온 뒤 다시 고친 인물 이름');
    if (viewport.width === MOBILE_WIDTH)
      await page
        .getByRole('region', { name: '자료 상세', exact: true })
        .getByRole('button', { name: '도우미 열기', exact: true })
        .click();
    const context = panel.locator('details.helper-editor');
    await expect(context.locator(':scope > summary')).toHaveText(
      '편집 중: 돌아온 뒤 다시 고친 인물 이름'
    );
    await context.locator(':scope > summary').click();
    await expect(context.locator('pre')).toContainText('돌아온 뒤 다시 고친 인물 이름');
    await expect(input).toHaveValue('이 자료를 검토하려고 남긴 도우미 초안');
    await page.screenshot({ path: info.outputPath(`helper-current-editor-${viewport.width}.png`) });
    await panel.getByRole('button', { name: '도우미 크게 보기', exact: true }).click();
    await expect(panel).toHaveClass(/helper-expanded/u);
    const expandedTitle = await context.locator(':scope > summary').textContent();
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
}
