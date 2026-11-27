import { DESKTOP_WIDTH } from './fixtures/browser-viewports.js';
import { randomUUID } from 'node:crypto';
import { expect, test } from './fixtures/browser-test.js';
import type { HelperChange, HelperRollbackUnit } from '../core/helper.js';
import { fixtureBotInput } from './fixtures/chat.js';
import {
  createHelperChat,
  openHelperPanel,
  routeSyntheticHelper,
} from './fixtures/helper-browser.js';
import { navigationAction } from './ui-navigation.js';

test.setTimeout(60000);

test('HPLAN01 plan mode sends a plan request, shows the plan and carries it out', async ({
  page,
  request,
}) => {
  const chat = await createHelperChat(request),
    state = await routeSyntheticHelper(page);
  await page.goto(`/?chat=${chat.id}`);
  const panel = await openHelperPanel(page);
  const modeChip = panel.locator('.helper-mode-chip');
  await expect(modeChip).toHaveAccessibleName('요청 방식: 바로 적용');
  await modeChip.click();
  await expect(modeChip).toHaveAccessibleName('요청 방식: 계획만');
  await panel.getByLabel('도우미에게 요청').fill('등장인물 소개를 다시 정리할 계획을 세워 주세요');
  await panel.getByRole('button', { name: '도우미 요청 보내기' }).click();
  await expect.poll(() => state.posts.length).toBe(1);
  expect(state.posts[0].mode).toBe('plan');
  const task = state.current().tasks[0];
  const row = panel.locator(`.helper-task[data-task-id="${task.id}"]`);
  await expect(row.locator('.helper-plan-badge')).toHaveText('계획');
  state.complete(task);
  state.current().messages.at(-1)!.text = Array.from(
    { length: 24 },
    (_, index) => `${index + 1}. 인물 ${index + 1}의 소개 문단을 읽고 말투와 관계를 정리해요.`
  ).join('\n');
  const plan = panel.getByTestId('helper-plan');
  await expect(plan).toBeVisible();
  await plan.getByRole('button', { name: '이 계획대로 진행', exact: true }).click();
  await expect.poll(() => state.posts.length).toBe(2);
  expect(state.posts[1].text).toBe('위 계획대로 진행해 주세요.');
  expect(state.posts[1].mode).toBeUndefined();
  await expect(modeChip).toHaveAccessibleName('요청 방식: 바로 적용');
});

test('HCONFIRM01 held operations are confirmed with an editable request, declined without one, or expired', async ({
  page,
  request,
}) => {
  const title = `삭제를 기다리는 봇 ${randomUUID()}`;
  const created = await request.post('/api/content', { data: fixtureBotInput(title) });
  expect(created.ok()).toBe(true);
  const bot = await created.json();
  const chat = await createHelperChat(request),
    state = await routeSyntheticHelper(page, 1);
  await page.goto(`/?chat=${chat.id}`);
  await openHelperPanel(page);
  const task = state.current().tasks[0];
  const held = (
    id: string,
    operation: string,
    reason: 'delete' | 'bulk' | 'paid',
    targets: { kind: string; id: string }[],
    grantable = true
  ) => ({
    id,
    taskId: task.id,
    operation,
    reason,
    chatId: chat.id,
    targets,
    grantedBy: null,
    grantable,
  });
  state.results.set(task.id, {
    confirmations: [
      held('delete-bot', 'resource.delete', 'delete', [{ kind: 'content', id: bot.id }]),
      held('paid-scene', 'scene.request', 'paid', [{ kind: 'chat', id: chat.id }]),
      held('old-bulk', 'resource.patchMany', 'bulk', [{ kind: 'content', id: bot.id }], false),
    ],
  });
  const cards = () => page.locator('#helper-panel .helper-confirmation');
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
  await page.goto(`/?chat=${chat.id}`);
  const panel = await openHelperPanel(page);
  const deletion = cards().filter({ hasText: '자료 삭제' });
  await expect(deletion).toContainText(title);
  await expect(deletion).toContainText('삭제하면 되돌릴 수 없어요.');
  const expired = cards().filter({ hasText: '여러 자료 한꺼번에 수정' });
  await expect(expired).toContainText('더 이상 확인할 수 없어요.');
  await expect(expired.getByRole('button')).toHaveCount(0);

  const paid = cards().filter({ hasText: '다음 장면 요청' });
  await expect(paid).toContainText(chat.title);
  await paid.getByRole('button', { name: '다음 장면 요청 거절', exact: true }).click();
  await expect(cards()).toHaveCount(2);
  await page.reload();
  await openHelperPanel(page);
  await expect(cards()).toHaveCount(2);
  expect(state.posts).toHaveLength(0);

  await deletion.getByRole('button', { name: '자료 삭제 확인', exact: true }).click();
  const input = panel.getByLabel('도우미에게 요청');
  const confirmedText = `보류한 작업을 확인했어요. 자료 삭제: ${title}. 그대로 진행해 주세요.`;
  await expect(input).toHaveValue(confirmedText);
  await expect(input).toBeFocused();
  await expect(panel.locator('.helper-confirmation-chip')).toHaveText('확인: 자료 삭제');
  await expect(deletion).toContainText('입력창에서 요청을 보내면 진행해요.');
  await expect(deletion.getByRole('button')).toHaveCount(0);
  expect(state.posts).toHaveLength(0);
  await input.press('End');
  await input.pressSequentially(' 끝나면 서재 목록도 정리해 주세요.');
  await panel.getByRole('button', { name: '도우미 요청 보내기' }).click();
  await expect.poll(() => state.posts.length).toBe(1);
  expect(state.posts[0].confirmations).toEqual(['delete-bot']);
  expect(state.posts[0].text).toBe(`${confirmedText} 끝나면 서재 목록도 정리해 주세요.`);
  await expect(panel.locator('.helper-confirmation-chip')).toHaveCount(0);
});

const resourceChange = (id: string, title: string): HelperChange => ({
  domain: 'resource',
  targetId: id,
  title,
  location: { kind: 'resource-field', path: ['description'] },
  action: 'update',
  diff: null,
  anchor: null,
});
const resourceUnit = (
  id: string,
  title: string,
  status: HelperRollbackUnit['status'] = 'restorable',
  reason?: HelperRollbackUnit['reason']
): HelperRollbackUnit => ({
  unit: `resource:content:${id}`,
  domain: 'resource',
  title,
  changeTargetIds: [id],
  status,
  ...(reason ? { reason } : {}),
  touches: { domain: 'resource', kind: 'content', id },
});

test('HROLLBACK03 undoing a resource under an unsaved editor draft keeps the draft and reports the changed saved version', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: 1000 });
  const original = `되돌릴 봇 ${randomUUID()}`;
  const created = await request.post('/api/content', {
    data: fixtureBotInput(original, 'Original source.'),
  });
  expect(created.ok()).toBe(true);
  const bot = await created.json();
  const changedTitle = `${original} 도우미 수정`;
  const changed = await request.put(`/api/content/${bot.id}`, {
    data: { ...fixtureBotInput(changedTitle, 'Original source.'), expectedRevision: bot.revision },
  });
  expect(changed.ok(), await changed.text()).toBe(true);
  const saved = await changed.json();
  const state = await routeSyntheticHelper(page, 1);
  const openEditor = async () => {
    if (page.url().startsWith('http'))
      await page.evaluate(() => localStorage.removeItem('uimori:workspace-panel'));
    await page.goto('/');
    await navigationAction(page, '서재');
    await page.getByRole('searchbox', { name: '서재 검색', exact: true }).fill(changedTitle);
    await page.getByRole('button', { name: `${changedTitle} 편집`, exact: true }).click();
    await expect(page.getByLabel(/^(봇|페르소나|모듈) 이름$/u)).toBeVisible();
  };
  const openEditorHelper = async () => {
    await page
      .getByRole('region', { name: '자료 상세', exact: true })
      .getByRole('button', { name: '도우미 열기', exact: true })
      .click();
    const panel = page.locator('#helper-panel');
    await expect(panel.getByLabel('도우미에게 요청')).toBeEnabled();
    return panel;
  };
  await openEditor();
  await openEditorHelper();
  const task = state.current().tasks[0];
  state.results.set(task.id, {
    changes: [resourceChange(bot.id, changedTitle), resourceChange('bot-other', '다른 자료')],
  });
  state.rollbacks.set(task.id, {
    taskId: task.id,
    blocked: null,
    units: [resourceUnit(bot.id, changedTitle), resourceUnit('bot-other', '다른 자료')],
  });
  state.onRollback(async (units) => {
    if (!units.some((unit) => unit.changeTargetIds.includes(bot.id))) return;
    const restored = await request.put(`/api/content/${bot.id}`, {
      data: {
        ...fixtureBotInput(original, 'Original source.'),
        expectedRevision: saved.revision,
      },
    });
    expect(restored.ok(), await restored.text()).toBe(true);
  });
  await openEditor();
  const draft = page.getByLabel(/^(봇|페르소나|모듈) 이름$/u);
  await draft.fill('지키려는 미저장 입력');
  const panel = await openEditorHelper();
  const results = panel.getByTestId('helper-task-results');
  const card = results.locator('.helper-change', { hasText: changedTitle });
  await expect(card.locator('.helper-rollback-status')).toHaveCount(0);
  await results.getByRole('button', { name: '모두 되돌리기', exact: true }).click();
  const dialog = page.getByRole('alertdialog', { name: '도우미 변경 되돌리기', exact: true });
  await expect(
    dialog.getByRole('region', { name: '되돌릴 대상' }).getByRole('listitem')
  ).toHaveText([changedTitle, '다른 자료']);
  await expect(dialog.getByRole('region', { name: '그대로 둘 대상' })).toHaveCount(0);
  await dialog.getByRole('button', { name: '변경 2개 되돌리기', exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(state.rollbackPosts).toEqual([{}]);
  expect((await (await request.get(`/api/content/${bot.id}`)).json()).title).toBe(original);
  await expect(card.locator('.helper-rollback-status')).toHaveText('되돌렸어요');
  await expect(draft).toHaveValue('지키려는 미저장 입력');
  const status = page.getByRole('alert').filter({ hasText: '저장된 자료가 변경됐어요.' });
  await expect(status).toContainText('현재 입력은 유지돼요.');
  await status.getByRole('button', { name: '저장본 확인', exact: true }).click();
  const review = page.getByRole('alertdialog', { name: '변경된 저장본 확인', exact: true });
  await expect(review.getByRole('region', { name: '현재 저장본' })).toContainText(original);
  await review.getByRole('button', { name: '현재 입력 유지', exact: true }).click();
  await expect(review).toBeHidden();
  await expect(draft).toHaveValue('지키려는 미저장 입력');
  expect((await (await request.get(`/api/content/${bot.id}`)).json()).title).toBe(original);
});
