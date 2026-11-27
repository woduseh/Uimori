import { DESKTOP_WIDTH } from './fixtures/browser-viewports.js';
import { expect, test, type Page } from './fixtures/browser-test.js';
import {
  createHelperChat,
  openHelperPanel,
  routeSyntheticHelper,
} from './fixtures/helper-browser.js';

test.setTimeout(60000);

async function toggleHelperTone(page: Page) {
  const settings = page.getByRole('dialog', { name: '도우미 설정', exact: true });
  if (await settings.isVisible()) {
    await settings.getByRole('button', { name: '도우미 설정 닫기', exact: true }).click();
    return;
  }
  const panel = page.locator('#helper-panel');
  await panel.getByLabel('도우미 대화 관리', { exact: true }).click();
  await panel.getByRole('button', { name: '도우미 말투 설정', exact: true }).click();
}

test('HELPSTEER adds instructions to the active task once after a lost acknowledgement and keeps ordinary requests queued', async ({
  page,
  request,
}) => {
  const chat = await createHelperChat(request),
    state = await routeSyntheticHelper(page);
  await page.goto(`/?chat=${chat.id}`);
  let panel = await openHelperPanel(page);
  await panel.getByLabel('도우미에게 요청').fill('자료 전체를 살펴봐 주세요');
  await panel.getByRole('button', { name: '도우미 요청 보내기', exact: true }).click();
  await expect(panel.getByLabel('도우미에게 요청')).toHaveValue('');
  const task = state.current().tasks[0];
  const instructionText = '우선 설명문만 살펴봐 주세요';
  const stop = panel.locator('.helper-composer').getByRole('button', {
    name: '진행 중인 도우미 작업 취소',
    exact: true,
  });
  await expect(stop).toBeVisible();
  const queueSend = panel.getByRole('button', { name: '다음 요청', exact: true });
  await expect(queueSend).toBeDisabled();
  await panel.getByLabel('도우미에게 요청').fill(instructionText);
  await expect(stop).toHaveCount(1);
  await expect(stop).toBeEnabled();
  await expect(queueSend).toBeEnabled();
  const sendMode = panel.getByTestId('helper-running-mode');
  await expect(sendMode).toHaveAccessibleName('실행 중 전송 방식: 대기 요청');
  await sendMode.click();
  await expect(sendMode).toHaveAccessibleName('실행 중 전송 방식: 추가 지시');
  await expect(queueSend).toHaveCount(0);
  state.loseNext();
  await panel.getByRole('button', { name: '현재 작업에 추가', exact: true }).click();
  await expect(panel.getByRole('button', { name: '이전 요청 확인', exact: true })).toBeVisible();
  await expect(panel.getByLabel('도우미에게 요청')).toHaveValue(instructionText);
  await expect(stop).toBeVisible();
  await page.reload();
  panel = await openHelperPanel(page);
  await panel.getByRole('button', { name: '이전 요청 확인', exact: true }).click();
  await page
    .getByRole('dialog', { name: '도우미 요청 확인', exact: true })
    .getByRole('button', { name: '접수 확인 및 재시도' })
    .click();
  await expect(panel.locator('.helper-outbox')).toHaveCount(0);
  await expect.poll(() => state.steerPosts.length).toBe(2);
  expect(state.steerPosts[1]).toEqual(state.steerPosts[0]);
  await expect(panel.getByLabel('도우미에게 요청')).toHaveValue('');
  await expect(stop).toBeVisible();
  expect(state.steerPosts[0]).toMatchObject({ taskId: task.id, text: instructionText });
  expect(state.posts).toHaveLength(1);
  expect(state.current().tasks).toHaveLength(1);
  expect(task.instructions).toHaveLength(1);
  const instruction = panel
    .locator(`.helper-task[data-task-id="${task.id}"]`)
    .getByTestId('helper-instruction');
  await expect(instruction).toContainText(instructionText);
  await expect(instruction.getByRole('status')).toContainText('전달 대기');
  task.instructions![0].status = 'delivered';
  state.emit('instruction.updated');
  await expect(instruction.getByRole('status')).toContainText('작업 입력에 반영');

  await panel.getByLabel('도우미에게 요청').fill('그다음 첫 메시지를 검토해 주세요');
  await panel.getByTestId('helper-running-mode').click();
  await panel.getByRole('button', { name: '다음 요청', exact: true }).click();
  await expect(panel.getByLabel('도우미에게 요청')).toHaveValue('');
  expect(state.posts).toHaveLength(2);
  expect(state.current().tasks).toHaveLength(2);
  expect(state.current().tasks[0]).toMatchObject({
    request: '그다음 첫 메시지를 검토해 주세요',
    status: 'queued',
  });
  expect(task.status).toBe('running');
});

test('HELPACTIVITY observed stages retain tool errors and cancellation', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
  const chat = await createHelperChat(request),
    state = await routeSyntheticHelper(page);
  await page.goto(`/?chat=${chat.id}`);
  const panel = await openHelperPanel(page);
  await panel.getByLabel('도우미에게 요청').fill('설정을 읽고 바꿔 주세요');
  await panel.getByRole('button', { name: '도우미 요청 보내기' }).click();
  await expect.poll(() => state.posts.length).toBe(1);
  const task = state.current().tasks[0];
  state.activity(task, [
    { seq: 1, kind: 'attempt.started', attemptId: 'helper', purpose: 'helper' },
    { seq: 2, kind: 'attempt.finished', attemptId: 'helper', status: 'tool_calls' },
    { seq: 3, kind: 'tool.finished', name: 'resource.read', denied: false },
    { seq: 4, kind: 'tool.finished', name: 'data.search', denied: false },
    {
      seq: 5,
      kind: 'tool.finished',
      name: 'resource.patch',
      denied: true,
      error: 'EDITOR_SAVE_REQUIRED',
    },
    { seq: 6, kind: 'attempt.started', attemptId: 'context', purpose: 'context' },
  ]);
  const row = panel.locator(`.helper-task[data-task-id="${task.id}"]`);
  await expect(panel.getByTestId('helper-current-activity').locator('.activity-label')).toHaveText(
    '대화 내용 정리 중이에요'
  );
  await expect(row.getByTestId('helper-task-activity')).toContainText('대화 내용 정리 중이에요');
  await row.getByTestId('helper-task-activity').locator(':scope > summary').click();
  const activity = row.getByTestId('helper-activity-details');
  await expect(activity.locator('.helper-activity-stages > li')).toHaveCount(4);
  const liveToggle = panel.getByTestId('helper-current-activity').getByRole('button', {
    name: '진행 과정',
    exact: true,
  });
  await expect(liveToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(panel.locator('.helper-current-activity-details')).toHaveCount(0);
  await liveToggle.click();
  await expect(liveToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(
    panel.locator('.helper-current-activity-details .helper-activity-stages > li')
  ).toHaveCount(4);
  await expect(activity.locator('[data-state="running"]')).toContainText('대화 내용 정리');
  await expect(
    activity.getByText('resource.patch: EDITOR_SAVE_REQUIRED', { exact: true })
  ).toBeVisible();
  const reads = activity.locator('.helper-activity-stage').filter({ hasText: 'resource.read' });
  await expect(reads.locator(':scope > summary')).toContainText('2회');
  await reads.locator(':scope > summary').click();
  await expect(activity.locator('code').filter({ hasText: /^resource\.read$/u })).toBeVisible();
  await expect(activity.locator('code').filter({ hasText: /^data\.search$/u })).toBeVisible();
  await row.getByRole('button', { name: '진행 중인 도우미 작업 취소', exact: true }).click();
  await expect(row.getByTestId('helper-task-activity').locator(':scope > summary')).toContainText(
    '취소됨'
  );
  await expect(panel.getByTestId('helper-current-activity')).toHaveCount(0);
  await expect(row.getByTestId('helper-task-activity')).not.toHaveAttribute('open');
  await row.getByTestId('helper-task-activity').locator(':scope > summary').click();
  await expect(activity.locator('[data-state="running"]')).toHaveCount(0);
  await expect(
    activity.getByText('resource.patch: EDITOR_SAVE_REQUIRED', { exact: true })
  ).toBeVisible();
});

test('HELPUI07 the panel keeps its drafts, reading position, tone edits and Back behavior, and switching sessions isolates late responses', async ({
  page,
  request,
}) => {
  const chat = await createHelperChat(request),
    state = await routeSyntheticHelper(page, 20);
  await page.goto(`/?chat=${chat.id}`);
  await page.getByLabel('다음 장면 요청').fill('본문 입력 초안');
  const scrolledUpWithFirstPlacement = page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const observer = new MutationObserver(() => {
          const node = document.querySelector<HTMLElement>('#helper-panel .helper-messages');
          if (!node || node.scrollTop === 0) return;
          observer.disconnect();
          node.scrollTop = 400;
          requestAnimationFrame(() => requestAnimationFrame(() => resolve(node.scrollTop)));
        });
        observer.observe(document.body, { subtree: true, childList: true, attributes: true });
      })
  );
  const panel = await openHelperPanel(page),
    input = panel.getByLabel('도우미에게 요청');
  expect(await scrolledUpWithFirstPlacement).toBe(400);
  await input.fill('도우미 입력 초안');
  const list = panel.locator('.helper-messages');
  const before = await list.evaluate((node) => node.scrollTop);
  expect(before).toBeGreaterThan(300);
  expect(before).toBeLessThan(500);
  await panel.getByRole('button', { name: '도우미 닫기', exact: true }).click();
  await expect(panel).toBeHidden();
  await expect(page.getByLabel('다음 장면 요청')).toHaveValue('본문 입력 초안');
  await openHelperPanel(page);
  await expect(input).toHaveValue('도우미 입력 초안');
  await expect.poll(() => list.evaluate((node) => node.scrollTop)).toBe(before);
  const session = await panel.getByLabel('도우미 대화 선택', { exact: true }).inputValue();
  await panel.getByRole('button', { name: '도우미 크게 보기', exact: true }).click();
  await expect(panel).toHaveClass(/helper-expanded/u);
  await expect(panel.getByLabel('도우미 대화 선택', { exact: true })).toHaveValue(session);
  await expect(input).toHaveValue('도우미 입력 초안');
  await expect.poll(() => list.evaluate((node) => node.scrollTop)).toBe(before);
  await panel.getByRole('button', { name: chat.title, exact: true }).click();
  await expect(panel).not.toHaveClass(/helper-expanded/u);
  await expect.poll(() => list.evaluate((node) => node.scrollTop)).toBe(before);
  const url = page.url();
  await page.goBack();
  await expect(panel).toBeHidden();
  expect(page.url()).toBe(url);
  await openHelperPanel(page);
  await expect(input).toHaveValue('도우미 입력 초안');
  const readingPosition = await list.evaluate((node) => node.scrollTop);
  await toggleHelperTone(page);
  const settings = page.getByRole('dialog', { name: '도우미 설정', exact: true });
  await expect(settings).toBeVisible();
  const tone = settings.getByLabel('도우미 말투', { exact: true });
  const originalTone = await tone.inputValue();
  await tone.fill('설정 화면에서 남긴 말투 초안');
  await toggleHelperTone(page);
  const discard = page.getByRole('alertdialog', { name: '도우미 설정', exact: true });
  await expect(discard).toContainText('저장하지 않은 말투가 사라져요.');
  await discard.getByRole('button', { name: '계속 편집', exact: true }).click();
  await expect(tone).toHaveValue('설정 화면에서 남긴 말투 초안');
  await toggleHelperTone(page);
  await discard.getByRole('button', { name: '변경 내용 버리고 닫기', exact: true }).click();
  await expect(settings).toBeHidden();
  await expect(input).toHaveValue('도우미 입력 초안');
  await expect.poll(() => list.evaluate((node) => node.scrollTop)).toBe(readingPosition);
  await toggleHelperTone(page);
  await expect(tone).toHaveValue(originalTone);
  await toggleHelperTone(page);
  await expect(settings).toBeHidden();

  await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
  await expect(input).toBeEnabled();
  const picker = panel.getByLabel('도우미 대화 선택');
  const firstId = await picker.inputValue();
  await input.fill('첫 세션의 실행');
  await panel.getByRole('button', { name: '도우미 요청 보내기', exact: true }).click();
  await expect(input).toHaveValue('');
  const firstTask = state.views.get(firstId)!.tasks[0];
  await input.fill('첫 세션의 다음 초안');
  const release = state.holdNextStream(firstTask.id);
  try {
    await expect.poll(() => state.heldStreams.has(firstTask.id)).toBe(true);
    await panel.getByRole('button', { name: '새 도우미 대화', exact: true }).click();
    await expect(picker).not.toHaveValue(firstId);
    await expect(input).toBeEnabled();
    await expect(input).toHaveValue('');
    await input.fill('다른 세션에서 쓰는 초안');
    expect(firstTask.status).toBe('running');
    state.complete(firstTask);
    release();
    await expect
      .poll(() => picker.locator(`option[value="${firstId}"]`).textContent())
      .toContain('●');
    await expect(input).toHaveValue('다른 세션에서 쓰는 초안');
    await expect(panel.getByText('합성 완료 응답', { exact: true })).toHaveCount(0);
    await picker.selectOption(firstId);
    await expect(input).toHaveValue('첫 세션의 다음 초안');
    await expect(panel.getByText('합성 완료 응답', { exact: true })).toBeVisible();
    expect(state.posts).toHaveLength(1);
  } finally {
    release();
  }
});

test('HELPUI05 a failed request retries once as edited, saved effects block replay, and a stopped task with recorded work resumes', async ({
  page,
  request,
}) => {
  const chat = await createHelperChat(request),
    state = await routeSyntheticHelper(page);
  await page.goto(`/?chat=${chat.id}`);
  let panel = await openHelperPanel(page);
  const failed = state.addFailed(state.current());
  failed.modelTitle = '이전 시도의 도우미 모델';
  await page.reload();
  panel = await openHelperPanel(page);
  const details = panel.locator(
    `[data-testid="helper-task-activity"][data-task-id="${failed.id}"]`
  );
  await details.locator(':scope > summary').click();
  await expect(details.getByText('모델: 이전 시도의 도우미 모델', { exact: true })).toBeVisible();
  await panel.getByLabel('도우미에게 요청').fill('새 요청 작성 중');
  await panel.getByLabel('요청 및 컨텍스트 메뉴', { exact: true }).click();
  await page.getByRole('button', { name: '요청 수정', exact: true }).click();
  await panel.getByLabel('요청 수정 내용').fill('고친 요청');
  await panel.getByRole('button', { name: '입력 저장', exact: true }).click();
  await expect(panel.getByTestId('source-request')).toHaveText('고친 요청');
  expect(state.posts).toHaveLength(0);
  await expect(panel.getByLabel('도우미에게 요청')).toHaveValue('새 요청 작성 중');
  state.loseNext();
  await panel
    .getByRole('group', { name: '실패한 요청' })
    .getByRole('button', { name: '다시 시도', exact: true })
    .click();
  await expect(panel.getByRole('button', { name: '이전 요청 확인', exact: true })).toBeVisible();
  expect(state.posts[0].text).toBe('고친 요청');
  const key = state.posts.at(-1)!.requestKey;
  await page.reload();
  panel = await openHelperPanel(page);
  await expect(panel.getByRole('button', { name: '이전 요청 확인', exact: true })).toBeVisible();
  await panel.getByRole('button', { name: '이전 요청 확인', exact: true }).click();
  await page
    .getByRole('dialog', { name: '도우미 요청 확인', exact: true })
    .getByRole('button', { name: '접수 확인 및 재시도' })
    .click();
  await expect.poll(() => state.posts.length).toBe(2);
  expect(state.posts[1].requestKey).toBe(key);
  await expect(panel.getByLabel('도우미에게 요청')).toHaveValue('새 요청 작성 중');
  await expect(panel.getByRole('group', { name: '실패한 요청' })).toHaveCount(0);
  const retried = state.current().tasks[0];
  retried.modelTitle = '재시도에 선택한 도우미 모델';
  state.complete(retried);
  await expect(panel.getByText('합성 완료 응답', { exact: true })).toBeVisible();
  await page.reload();
  panel = await openHelperPanel(page);
  await expect(panel.locator('[data-testid="source-request"]')).toHaveCount(1);
  await expect(panel.getByText('고친 요청', { exact: true })).toBeVisible();
  await expect(panel.getByRole('group', { name: '실패한 요청' })).toHaveCount(0);
  await panel.getByRole('button', { name: '작업 기록', exact: true }).click();
  await expect(panel.locator('[data-testid="helper-task-record"]')).toHaveCount(2);
  await expect(
    panel.locator(`[data-testid="helper-task-record"][data-task-id="${failed.id}"]`)
  ).toContainText('이전 시도의 도우미 모델');
  await expect(
    panel.locator(`[data-testid="helper-task-record"][data-task-id="${retried.id}"]`)
  ).toContainText('재시도에 선택한 도우미 모델');
  await expect(panel.locator('.helper-task-history').getByText('SYNTHETIC_FAILURE')).toBeVisible();

  const stopped = state.addFailed(state.current());
  stopped.error = 'UNEXPECTED_EOF';
  stopped.completedEffects = { count: 1 };
  stopped.resumable = true;
  await page.reload();
  panel = await openHelperPanel(page);
  await expect(panel.getByTestId('helper-completed-effects')).toContainText(
    '변경 사항 1건을 저장했지만 응답을 완료하지 못했어요.'
  );
  const actions = panel.getByRole('group', { name: '실패한 요청' });
  await expect(actions.getByRole('button', { name: '다시 시도', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: '요청 편집', exact: true })).toHaveCount(0);
  const stoppedDetails = panel.locator(
    `[data-testid="helper-task-activity"][data-task-id="${stopped.id}"]`
  );
  await stoppedDetails.locator(':scope > summary').click();
  await expect(stoppedDetails.getByText('저장한 작업: 완료된 도우미 작업')).toBeVisible();
  await expect(stoppedDetails.getByText('UNEXPECTED_EOF', { exact: true })).toBeVisible();
  expect(state.posts).toHaveLength(2);
  await actions.getByRole('button', { name: '이어서 하기', exact: true }).click();
  await expect.poll(() => state.posts.length).toBe(3);
  expect(state.posts[2]).toMatchObject({ retryOf: stopped.id, resume: true });
});
