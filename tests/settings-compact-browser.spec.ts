import packageJson from '../package.json' with { type: 'json' };
import { MOBILE_WIDTH, DESKTOP_WIDTH } from './fixtures/browser-viewports.js';
import { visualReview } from './fixtures/visual-review.js';
import { test, expect } from '@playwright/test';
import { fixtureBotInput } from './fixtures/chat.js';
import {
  navigationAction,
  selectSettingsSection,
  startProviderConnection,
} from './ui-navigation.js';

test('SCUI04 every settings section renders its main controls', async ({ page, request }) => {
  const health = await (await request.get('/api/health')).json();
  expect(health.version).toBe(packageJson.version);
  const connectionResponse = await request.post('/api/connections', {
    data: {
      title: '설정 배치 확인용 프로바이더',
      protocol: 'fixture-sse-v1',
      endpoint: 'http://127.0.0.1:9/not-called',
      enabled: true,
    },
  });
  expect(connectionResponse.ok()).toBe(true);
  const connection = await connectionResponse.json();
  const modelResponse = await request.post('/api/model-presets', {
    data: {
      title: '설정 배치 확인용 모델',
      connectionId: connection.id,
      modelId: 'settings-layout-fixture',
      maxOutputTokens: 1000,
      temperature: null,
    },
  });
  expect(modelResponse.ok()).toBe(true);
  await page.route('**/api/agent-runtimes/codex', (route) =>
    route.fulfill({
      json: {
        available: false,
        authenticated: false,
        authMode: null,
        limits: [],
        error: 'CODEX_DISABLED',
      },
    })
  );
  await page.goto('/');
  await navigationAction(page, '설정');
  const dialog = page.getByRole('dialog', { name: '설정', exact: true });
  for (const section of [
    '일반',
    '테마와 색상',
    '역할별 모델',
    '기본 프롬프트',
    '프로바이더와 모델',
    '로어 컨텍스트',
    'Codex 연결',
    '삽화',
    '사용량',
    '데이터 관리',
    '앱 정보',
  ]) {
    await selectSettingsSection(page, section);
    const pane = dialog.getByRole('tabpanel');
    if (section === '일반') {
      await expect(pane.getByLabel('앱 화면 테마')).toBeVisible();
    } else if (section === '테마와 색상') {
      const controls = pane.locator('.theme-control-bar select');
      await expect(controls).toHaveCount(2);
      await expect(pane.getByLabel('테마 적용 범위', { exact: true })).toBeVisible();
      await pane.getByText('테마 관리', { exact: true }).click();
      await expect(pane.getByRole('button', { name: '새 커스텀 테마', exact: true })).toBeVisible();
    } else if (section === '로어 컨텍스트') {
      await expect(
        pane.getByRole('switch', { name: '조회 로어를 다음 생성에도 유지', exact: true })
      ).toBeVisible();
    } else if (section === '데이터 관리') {
      await expect(
        pane.getByRole('heading', { name: '작업실 전체 백업', exact: true })
      ).toBeVisible();
      await expect(pane.getByRole('button', { name: '백업 다운로드', exact: true })).toBeVisible();
      const restore = pane
        .locator('details')
        .filter({ has: page.locator('summary', { hasText: '전체 복원 방법' }) });
      await expect(
        pane.getByRole('heading', { name: '백업 파일 가져오기', exact: true })
      ).toBeVisible();
      await expect(pane.getByLabel('백업 파일 선택', { exact: true })).toHaveCount(1);
      await expect(restore).not.toHaveAttribute('open', '');
      await restore.locator('summary').click();
      await expect(restore).toContainText('서버를 종료하고');
      await restore.locator('summary').click();
    } else if (section === 'Codex 연결') {
      await expect(pane.getByText('서버 설정 필요', { exact: true })).toBeVisible();
    } else if (section === '역할별 모델') {
      await expect(pane.getByLabel('본문 모델', { exact: true })).toBeVisible();
    } else if (section === '기본 프롬프트') {
      await expect(pane.getByLabel('기본 프롬프트 역할', { exact: true })).toBeVisible();
    } else if (section === '프로바이더와 모델') {
      await expect(pane.getByLabel('프로바이더와 모델 검색', { exact: true })).toBeVisible();
    } else if (section === '삽화') {
      await expect(pane.getByRole('heading', { name: '프리셋', exact: true })).toBeVisible();
      await expect(pane.getByRole('heading', { name: '생성 환경', exact: true })).toBeVisible();
      await expect(pane.getByLabel('삽화 프리셋 적용 범위', { exact: true })).toBeVisible();
    } else if (section === '사용량') {
      await expect(pane.getByRole('button', { name: '이번 달', exact: true })).toBeVisible();
    } else {
      await expect(pane.getByTestId('app-version')).toHaveText(`v${packageJson.version}`);
      await expect(pane.getByTestId('app-build-id')).toHaveText(health.buildId);
      await pane.getByText('라이선스 전문', { exact: true }).click();
      await expect(pane.locator('.app-about-document').first()).toContainText(
        'GNU AFFERO GENERAL PUBLIC LICENSE'
      );
      await pane.getByText('라이선스 전문', { exact: true }).click();
      await pane.getByText('저작권 및 제3자 고지', { exact: true }).click();
      await expect(pane.locator('.app-about-document').last()).toContainText('RisuAI');
      await pane.getByText('저작권 및 제3자 고지', { exact: true }).click();
    }
  }
  await dialog.getByRole('button', { name: '설정 닫기', exact: true }).click();
});

test('SCUI05 global lore defaults are saved and copied only to new chats', async ({
  page,
  request,
}) => {
  const original = await (await request.get('/api/lore-context-defaults')).json();
  const created = await request.post('/api/content', {
    data: fixtureBotInput('로어 기본값 합성 봇'),
  });
  expect(created.ok()).toBe(true);
  const bot = await created.json();
  const firstResponse = await request.post('/api/chats', {
    data: { botId: bot.id, title: '기본값 변경 전 채팅' },
  });
  expect(firstResponse.ok()).toBe(true);
  const first = await firstResponse.json();
  await page.goto('/');
  await navigationAction(page, '설정');
  await selectSettingsSection(page, '로어 컨텍스트');
  const settings = page.getByRole('dialog', { name: '설정', exact: true });
  const section = settings.getByRole('region', { name: '로어 컨텍스트 기본값', exact: true });
  const reset = section.getByRole('button', { name: '초기값으로 되돌리기', exact: true });
  await expect(reset).toBeHidden();
  await section.getByText('선별 기준과 용량', { exact: true }).click();
  await expect(reset).toBeVisible();
  await section.getByText('선별 기준과 용량', { exact: true }).click();
  await expect(reset).toBeHidden();
  await section.getByText('선별 기준과 용량', { exact: true }).click();
  const retained = section.getByLabel('조회 로어 토큰 한도', { exact: true });
  await expect(retained).toBeVisible();
  await expect(retained).toHaveValue(String(original.maxRetainedTokens));
  const nextLimit = original.maxRetainedTokens === 24_000 ? 20_000 : 24_000;
  await retained.fill(String(nextLimit));
  await section.getByRole('button', { name: '로어 컨텍스트 기본값 저장', exact: true }).click();
  await expect(
    page.locator('.transient-notice[role="status"]').filter({ hasText: '새 채팅부터 적용돼요' })
  ).toBeVisible();
  const secondResponse = await request.post('/api/chats', {
    data: { botId: bot.id, title: '기본값 변경 후 채팅' },
  });
  expect(secondResponse.ok()).toBe(true);
  const second = await secondResponse.json();
  const firstDetail = await (await request.get(`/api/chats/${first.id}`)).json();
  const secondDetail = await (await request.get(`/api/chats/${second.id}`)).json();
  expect(firstDetail.profile.loreContext.maxRetainedTokens).toBe(original.maxRetainedTokens);
  expect(secondDetail.profile.loreContext.maxRetainedTokens).toBe(nextLimit);
  const saved = await (await request.get('/api/lore-context-defaults')).json();
  const { revision: _revision, ...policy } = original;
  const restored = await request.put('/api/lore-context-defaults', {
    data: { expectedRevision: saved.revision, ...policy },
  });
  expect(restored.ok()).toBe(true);
});

test('SCUI02 settings back, resize and close preserve provider and chat drafts until explicit discard', async ({
  page,
  request,
}, info) => {
  const created = await request.post('/api/content', {
    data: fixtureBotInput('설정 초안 보존 합성 봇'),
  });
  expect(created.ok()).toBe(true);
  const bot = await created.json();
  const response = await request.post('/api/chats', {
    data: { botId: bot.id, title: '설정 초안 보존 합성 채팅' },
  });
  expect(response.ok()).toBe(true);
  const chat = await response.json();
  await page.setViewportSize({ width: MOBILE_WIDTH, height: 844 });
  await page.goto(`/?chat=${chat.id}`);
  const composer = page.getByLabel('다음 장면 요청', { exact: true });
  await composer.fill('계속 보존할 사용자 요청');
  await navigationAction(page, '설정');
  await selectSettingsSection(page, '프로바이더와 모델');
  await startProviderConnection(page);
  await page.getByRole('button', { name: /OpenAI Responses/ }).click();
  const name = page
    .getByRole('form', { name: '프로바이더 편집 양식' })
    .getByLabel('프로바이더 이름', { exact: true });
  await name.fill('아직 저장하지 않은 합성 연결');
  await page.goBack();
  await expect(name).toBeHidden();
  await page.goBack();
  const dialog = page.getByRole('dialog', { name: '설정', exact: true });
  await expect(dialog.locator('.settings-navigation')).toBeVisible();
  await expect(
    dialog
      .locator('.settings-navigation')
      .getByRole('button', { name: '프로바이더와 모델', exact: true })
  ).toHaveText('프로바이더와 모델');
  await expect(dialog.getByRole('tabpanel')).toHaveCount(0);
  await page.goBack();
  const confirm = page.getByRole('alertdialog', { name: '미저장 설정 확인', exact: true });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: '계속 편집', exact: true }).click();
  await selectSettingsSection(page, '프로바이더와 모델');
  await dialog
    .getByRole('button', {
      name: '프로바이더 편집 이어 하기: 아직 저장하지 않은 합성 연결',
      exact: true,
    })
    .click();
  await expect(name).toHaveValue('아직 저장하지 않은 합성 연결');
  await name.focus();
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
  await expect(name).toBeFocused();
  await selectSettingsSection(page, '일반');
  await selectSettingsSection(page, '프로바이더와 모델');
  await expect(name).toHaveValue('아직 저장하지 않은 합성 연결');
  await page.setViewportSize({ width: MOBILE_WIDTH, height: 844 });
  await expect(name).toBeVisible();
  await dialog.getByRole('button', { name: '설정 닫기', exact: true }).click();
  await expect(confirm).toBeVisible();
  if (visualReview)
    await page.screenshot({ path: info.outputPath(`settings-unsaved-${MOBILE_WIDTH}.png`) });
  await page.keyboard.press('Escape');
  await expect(confirm).toBeHidden();
  await expect(name).toHaveValue('아직 저장하지 않은 합성 연결');
  await dialog.getByRole('button', { name: '설정 닫기', exact: true }).click();
  await confirm.getByRole('button', { name: '초안 버리고 닫기', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(composer).toHaveValue('계속 보존할 사용자 요청');
  await expect(page).toHaveURL(new RegExp(`chat=${chat.id}`));
  const after = await (await request.get(`/api/chats/${chat.id}`)).json();
  expect(after.runs).toHaveLength(0);
  expect(after.jobs).toHaveLength(0);
});

test('SCUILEAVE global illustration settings retain failed drafts and save before closing', async ({
  page,
  request,
}) => {
  const original = await (await request.get('/api/illustration-settings')).json();
  const nextCount = original.maxPerSource === 2 ? 3 : 2;
  await page.goto('/');
  await navigationAction(page, '설정');
  await selectSettingsSection(page, '삽화');
  const settings = page.getByRole('dialog', { name: '설정', exact: true });
  const count = settings.getByLabel('장면당 최대 삽화 수', { exact: true });
  await settings.getByLabel('응답 완료 후 자동 삽화 생성', { exact: true }).check();
  await settings
    .getByRole('combobox', { name: '자동 생성 컷 수', exact: true })
    .selectOption('auto');
  await settings.getByLabel('최소 컷 수', { exact: true }).fill('1');
  await count.fill('0');
  await settings.getByRole('button', { name: '설정 닫기', exact: true }).click();
  const confirm = page.getByRole('alertdialog', { name: '미저장 설정 확인', exact: true });
  await confirm.getByRole('button', { name: '저장하고 닫기', exact: true }).click();
  await expect(confirm.getByRole('alert')).toBeVisible();
  expect((await (await request.get('/api/illustration-settings')).json()).revision).toBe(
    original.revision
  );
  await confirm.getByRole('button', { name: '계속 편집', exact: true }).click();
  await expect(count).toHaveValue('0');
  await count.fill('');
  await count.fill(String(nextCount));
  const automaticMax = settings.getByLabel('자동으로 고를 최대 컷 수', { exact: true });
  await automaticMax.fill('');
  await automaticMax.fill(String(nextCount));
  await expect(settings.getByRole('button', { name: '삽화 설정 저장', exact: true })).toBeEnabled();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let intercepted = false;
  await page.route('**/api/illustration-settings', async (route) => {
    if (route.request().method() !== 'PUT') return route.continue();
    intercepted = true;
    await held;
    await route.fulfill({ status: 503, json: { error: 'SCUILEAVE synthetic write failure' } });
  });
  await settings.getByRole('button', { name: '설정 닫기', exact: true }).click();
  await confirm.getByRole('button', { name: '저장하고 닫기', exact: true }).click();
  await expect.poll(() => intercepted).toBe(true);
  await page.keyboard.press('Escape');
  await expect(confirm).toBeVisible();
  await expect(confirm.getByRole('button', { name: '계속 편집', exact: true })).toBeDisabled();
  release();
  await expect(confirm.getByRole('alert')).toBeVisible();
  await page.unroute('**/api/illustration-settings');
  await confirm.getByRole('button', { name: '계속 편집', exact: true }).click();
  await expect(count).toHaveValue(String(nextCount));
  await settings.getByRole('button', { name: '설정 닫기', exact: true }).click();
  await confirm.getByRole('button', { name: '저장하고 닫기', exact: true }).click();
  await expect(settings).toBeHidden();
  const saved = await (await request.get('/api/illustration-settings')).json();
  expect(saved).toMatchObject({
    maxPerSource: nextCount,
    automaticMaxTargets: nextCount,
    automaticMinTargets: 1,
    revision: original.revision + 1,
  });
  const { revision: _revision, ...body } = original;
  const restored = await request.put('/api/illustration-settings', {
    data: { ...body, expectedRevision: saved.revision },
  });
  expect(restored.ok()).toBe(true);
});
