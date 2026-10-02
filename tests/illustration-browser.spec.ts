import sharp from 'sharp';
import { MOBILE_WIDTH, DESKTOP_WIDTH, DEFAULT_WIDTHS } from './fixtures/browser-viewports.js';
import { test, expect, type APIRequestContext } from '@playwright/test';
import type { Chat, ChatDetail, Run } from '../core/types.js';
import type { Illustration, IllustrationSettings } from '../core/illustration.js';
import { fixtureBotInput } from './fixtures/chat.js';
import { navigationAction, openSourceActions, selectSettingsSection } from './ui-navigation.js';

test.setTimeout(60000);

async function detail(request: APIRequestContext, id: string): Promise<ChatDetail> {
  const response = await request.get(`/api/chats/${id}`);
  expect(response.ok()).toBeTruthy();
  return response.json();
}
async function seed(request: APIRequestContext, backgroundHTML = '') {
  const botInput = fixtureBotInput();
  botInput.package.nativeRisu!.card.extensions = { risuai: { backgroundHTML } };
  const bot = await request.post('/api/content', { data: botInput });
  expect(bot.ok()).toBeTruthy();
  const created = await request.post('/api/chats', {
    data: { title: `Illustration synthetic ${Date.now()}`, botId: (await bot.json()).id },
  });
  expect(created.ok()).toBeTruthy();
  const chat = (await created.json()) as Chat;
  expect(
    (
      await request.patch(`/api/chats/${chat.id}/settings`, {
        data: { ...chat.settings, status: false, expectedSettingsRevision: 1 },
      })
    ).ok()
  ).toBeTruthy();
  const before = await detail(request, chat.id);
  const started = await request.post(`/api/chats/${chat.id}/runs`, {
    data: {
      request: 'Synthetic scene: a lantern lights the quiet river.',
      expectedRevision: before.chat.headRevision,
      expectedSettingsRevision: before.chat.settingsRevision,
      idempotencyKey: `illustration-${chat.id}`,
    },
  });
  expect(started.ok()).toBeTruthy();
  const run = (await started.json()) as Run;
  await expect
    .poll(
      async () => (await detail(request, chat.id)).runs.find((item) => item.id === run.id)?.status
    )
    .toBe('completed');
  const after = await detail(request, chat.id);
  return { chat, source: after.sources.find((item) => item.runId === run.id)! };
}
async function settings(request: APIRequestContext, patch: Partial<IllustrationSettings>) {
  const current = await request.get('/api/illustration-settings');
  expect(current.ok()).toBeTruthy();
  const { revision, ...body } = (await current.json()) as IllustrationSettings;
  const saved = await request.put('/api/illustration-settings', {
    data: { expectedRevision: revision, ...body, ...patch },
  });
  expect(saved.ok(), await saved.text()).toBeTruthy();
  return (await saved.json()) as IllustrationSettings;
}
async function illustrations(request: APIRequestContext, chatId: string) {
  const response = await request.get(`/api/chats/${chatId}/illustrations`);
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as Illustration[];
}
const byStatus = (status: string) => `[data-testid="illustration"][data-status="${status}"]`;

test('ILUI01 scene menu requests an illustration, shows the stored image, retries a failure and deletes', async ({
  page,
  request,
}, info) => {
  const { chat, source } = await seed(request);
  await settings(request, {
    generator: 'fixture',
    automatic: false,
    maxPerSource: 3,
    maxAutoRetries: 0,
  });
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
  await page.goto(`/?chat=${chat.id}`);
  const scene = page.getByTestId('source').first();
  await expect(scene).toBeVisible();
  await expect(page.getByTestId('illustrations')).toHaveCount(0);
  await openSourceActions(scene);
  const illustrate = page.getByTestId('illustrate');
  await expect(illustrate).toHaveText(/삽화 생성/u);
  await illustrate.click();
  await page
    .getByRole('dialog', { name: '삽화 생성', exact: true })
    .getByRole('button', { name: '삽화 만들기', exact: true })
    .click();
  const strip = page.getByTestId('illustrations').filter({ visible: true });
  await expect(strip).toHaveCount(1);
  const card = strip.getByTestId('illustration').first();
  await expect(card).toHaveAttribute('data-status', 'completed');
  const expand = card.getByRole('button', { name: '펼치기', exact: true });
  if (await expand.isVisible()) await expand.click();
  const image = card.locator('img');
  await expect(image).toBeVisible();
  expect(
    await image.evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > 0)
  ).toBe(true);
  await expect(card).toContainText('모의 삽화');
  await card.getByLabel('삽화 작업 메뉴', { exact: true }).click();
  await card.getByRole('button', { name: '생성 상세', exact: true }).click();
  const detailDialog = page.getByRole('dialog', { name: '삽화 생성 상세', exact: true });
  await expect(detailDialog).toContainText('직접 요청');
  await page.keyboard.press('Escape');
  const stored = (await illustrations(request, chat.id)).filter((item) => item.task === 'render');
  expect(stored).toHaveLength(1);
  expect(stored[0]).toMatchObject({
    status: 'completed',
    sourceRevision: source.id,
    origin: 'manual',
  });
  // Persisted server-side: a reload shows the same illustration without another request.
  await page.reload();
  await expect(page.getByTestId('illustration').first()).toHaveAttribute(
    'data-status',
    'completed'
  );
  const failing = await request.post(`/api/sources/${source.id}/illustrations`, {
    data: { fixture: { failures: 1 } },
  });
  expect(failing.ok()).toBeTruthy();
  const failedCard = page.locator(byStatus('failed'));
  await expect(failedCard).toHaveCount(1);
  await expect(failedCard).toContainText('모의 실패예요');
  await expect(failedCard).toContainText('FIXTURE_FAILURE');
  await failedCard.getByRole('button', { name: /다시 요청/u }).click();
  await expect(page.locator(byStatus('completed'))).toHaveCount(2);
  await page
    .getByTestId('illustration')
    .last()
    .getByLabel('삽화 작업 메뉴', { exact: true })
    .click();
  await page
    .getByTestId('illustration')
    .last()
    .getByRole('button', { name: /삽화 삭제/u })
    .click();
  const confirm = page.getByRole('alertdialog', { name: '삭제 확인', exact: true });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: '영구 삭제', exact: true }).click();
  await expect(page.getByTestId('illustration')).toHaveCount(1);
  expect(
    (await illustrations(request, chat.id)).filter((item) => item.task === 'render')
  ).toHaveLength(1);
  await page.screenshot({ path: info.outputPath('illustration-desktop.png') });
  // The illustration strip never rewrote the story text.
  expect((await detail(request, chat.id)).sources[0].text).toBe(source.text);
});

test('ILUI02 mobile settings save illustration limits with CAS and expose the generator choice', async ({
  page,
  request,
}, info) => {
  await seed(request);
  const before = await settings(request, { generator: 'none', maxPerSource: 2 });
  await page.setViewportSize({ width: MOBILE_WIDTH, height: 844 });
  await page.goto('/');
  await navigationAction(page, '설정');
  await selectSettingsSection(page, '삽화');
  const section = page.getByRole('region', { name: '삽화 설정', exact: true });
  await expect(section).toBeVisible();
  const generator = section.getByLabel('테스트 삽화 생성기', { exact: true });
  await expect(generator).toHaveValue('');
  await generator.selectOption('fixture');
  await expect(section.getByLabel('응답 완료 후 자동 삽화 생성', { exact: true })).toBeVisible();
  const limit = section.getByLabel('장면당 최대 삽화 개수', { exact: true });
  await limit.fill('3');
  await section.getByLabel('자동 재요청 횟수', { exact: true }).fill('2');
  await section.getByRole('button', { name: '삽화 설정 저장', exact: true }).click();
  await expect(
    section.getByRole('status').filter({ hasText: '삽화 설정을 저장했어요' })
  ).toBeVisible();
  const saved = await request.get('/api/illustration-settings');
  expect((await saved.json()) as IllustrationSettings).toMatchObject({
    generator: 'fixture',
    maxPerSource: 3,
    maxAutoRetries: 2,
    revision: before.revision + 1,
  });
  // A concurrent save elsewhere is rejected by CAS; the stale draft stays until it reloads.
  await settings(request, { maxAutoRetries: 3 });
  await limit.fill('4');
  await section.getByRole('button', { name: '삽화 설정 저장', exact: true }).click();
  await expect(section.getByRole('alert').filter({ hasText: '초안은 유지했어요' })).toBeVisible();
  await expect(limit).toHaveValue('4');
  await section.getByRole('button', { name: '저장된 설정 다시 불러오기', exact: true }).click();
  const reloadDialog = page.getByRole('alertdialog', { name: '삽화 설정 다시 불러오기' });
  await expect(reloadDialog.getByRole('button', { name: '계속 편집' })).toBeFocused();
  await reloadDialog.getByRole('button', { name: '계속 편집' }).click();
  await expect(limit).toHaveValue('4');
  await section.getByRole('button', { name: '저장된 설정 다시 불러오기', exact: true }).click();
  await page.route('**/api/illustration-settings', async (route) => {
    if (route.request().method() === 'GET')
      await route.fulfill({ status: 503, body: 'unavailable' });
    else await route.continue();
  });
  await reloadDialog.getByRole('button', { name: '초안 버리고 불러오기' }).click();
  await expect(reloadDialog.getByRole('alert')).toContainText('초안은 유지했어요');
  await expect(limit).toHaveValue('4');
  await page.unroute('**/api/illustration-settings');
  await reloadDialog.getByRole('button', { name: '초안 버리고 불러오기' }).click();
  await expect(section.getByLabel('자동 재요청 횟수', { exact: true })).toHaveValue('3');
  await expect(page.locator('body')).not.toHaveCSS('overflow-x', 'scroll');
  await page.screenshot({ path: info.outputPath('illustration-settings-mobile.png') });
});

test('ILUI03 illustration editors use full width and seconds preserve stored milliseconds', async ({
  page,
  request,
}, info) => {
  await seed(request);
  await settings(request, { generator: 'none' });
  await page.goto('/');
  await navigationAction(page, '설정');
  await selectSettingsSection(page, '삽화');
  const section = page.getByRole('region', { name: '삽화 설정', exact: true });
  await section.locator('summary').filter({ hasText: 'ComfyUI 생성 환경' }).click();
  await page.getByRole('button', { name: '새 삽화 프리셋', exact: true }).click();
  const presetEditor = page.getByRole('region', { name: '삽화 프리셋 편집기', exact: true });
  await presetEditor.getByLabel('프리셋 삽화 생성기').selectOption('comfyui');
  await presetEditor.locator('summary').filter({ hasText: 'ComfyUI 설정' }).click();
  for (const width of [DESKTOP_WIDTH, MOBILE_WIDTH]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const label of [
      '삽화 그림 지침',
      'ComfyUI 네거티브 프롬프트 지침',
      'ComfyUI 워크플로 JSON',
    ]) {
      const field = presetEditor.getByLabel(label, { exact: true });
      const bounds = await field.evaluate((node) => {
        const fieldset = node.closest('fieldset')!;
        const css = getComputedStyle(fieldset);
        return {
          actual: node.getBoundingClientRect().width,
          available:
            fieldset.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight),
        };
      });
      expect(Math.abs(bounds.actual - bounds.available)).toBeLessThan(3);
    }
    const toggle = section.getByRole('switch', { name: '응답 완료 후 자동 삽화 생성' });
    const offset = await toggle.evaluate((node) => {
      const a = node.getBoundingClientRect(),
        b = node.parentElement!.getBoundingClientRect();
      return Math.abs(a.y + a.height / 2 - b.y - b.height / 2);
    });
    expect(offset).toBeLessThan(2);
    await page.screenshot({ path: info.outputPath(`illustration-form-${width}.png`) });
    await section.getByLabel('확인 간격 (초)', { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`illustration-comfyui-${width}.png`) });
  }
  await section.getByLabel('시간 제한 (초)', { exact: true }).fill('60');
  await section.getByLabel('확인 간격 (초)', { exact: true }).fill('0.25');
  await section.getByLabel('테스트 삽화 생성기', { exact: true }).selectOption('');
  await section.getByRole('button', { name: '삽화 설정 저장', exact: true }).click();
  await expect(
    section.getByRole('status').filter({ hasText: '삽화 설정을 저장했어요' })
  ).toBeVisible();
  const saved = await (await request.get('/api/illustration-settings')).json();
  expect(saved.comfyui).toMatchObject({ timeoutMs: 60000, pollIntervalMs: 250 });
  await page.route('**/api/illustration-settings', (route) =>
    route.fulfill({ status: 503, body: 'unavailable' })
  );
  await section.getByRole('button', { name: '저장된 설정 다시 불러오기' }).click();
  await expect(section.getByRole('status')).toContainText('설정을 불러오지 못했어요');
  await page.unroute('**/api/illustration-settings');
  await section.getByLabel('장면당 최대 삽화 개수').fill('5');
  await section.getByRole('button', { name: '저장된 설정 다시 불러오기' }).click();
  const guard = page.getByRole('alertdialog', { name: '삽화 설정 다시 불러오기' });
  for (const width of DEFAULT_WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(guard.getByRole('button', { name: '계속 편집' })).toBeFocused();
    await page.screenshot({ path: info.outputPath(`illustration-discard-${width}.png`) });
  }
  await page.keyboard.press('Escape');
  await expect(guard).toBeHidden();
  await expect(section.getByLabel('장면당 최대 삽화 개수')).toHaveValue('5');
});

test('ILUI04 storyboard places a hero and inline cuts, folds persist, and planning never blocks the next chat', async ({
  page,
  request,
}, info) => {
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: 1000 });
  const { chat, source } = await seed(request);
  const paragraphs = [
    '미라는 창문을 열었다. 비가 그친 도시는 아직 푸른 새벽빛 속에 잠겨 있었다. 젖은 지붕 너머에서 첫 전차가 천천히 움직였다.',
    '옥상 문이 열리고 유나가 모습을 드러냈다. 두 사람은 잠시 서로를 바라보다가 웃음을 터뜨렸다. 미라가 내민 손을 유나는 망설임 없이 잡았다.',
    '해가 떠오르자 두 사람은 나란히 난간에 기대었다. 도시가 깨어나는 소리 사이로 온기를 나누는 두 손만 조용히 남아 있었다.',
  ];
  const edited = await request.put(`/api/sources/${source.id}/text`, {
    data: { text: paragraphs.join('\n\n'), expectedRevision: 0 },
  });
  expect(edited.ok()).toBe(true);
  await settings(request, {
    generator: 'fixture',
    automatic: false,
    maxPerSource: 4,
    maxAutoRetries: 0,
  });
  // Visually representative synthetic image bytes + dimensions. No paid provider is contacted.
  const picture = await sharp(
    Buffer.from(
      '<svg width="800" height="450" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="#425e72"/><stop offset="1" stop-color="#dfcbb1"/></linearGradient></defs><rect width="800" height="450" fill="url(#g)"/><circle cx="620" cy="105" r="48" fill="#f7e7ca"/><path d="M0 310L90 260V200H155V285H260V180H330V260H425V220H510V320H620V265H720V320H800V450H0Z" fill="#283c4a"/><text x="32" y="415" font-family="sans-serif" font-size="18" fill="white">SYNTHETIC READER FIXTURE</text></svg>'
    )
  )
    .webp()
    .toBuffer();
  await page.route('**/api/illustration-images/*', (route) =>
    route.fulfill({ contentType: 'image/webp', body: picture })
  );
  await page.route('**/api/chats/*/reader?*', async (route) => {
    const response = await route.fetch();
    if (!response.ok()) return route.fulfill({ response });
    const body = await response.json();
    for (const item of body.illustrations ?? [])
      for (const image of item.images) {
        image.width = 800;
        image.height = 450;
      }
    await route.fulfill({ response, json: body });
  });
  await page.goto(`/?chat=${chat.id}`);
  const scene = page.locator(`[data-testid="source"][data-source-id="${source.id}"]`);
  await expect(scene).toBeVisible();
  await request.post('/api/test/control', { data: { action: 'hold', barrier: 'illustration' } });
  await openSourceActions(scene);
  await page.getByTestId('illustrate').click();
  const dialog = page.getByRole('dialog', { name: '삽화 생성', exact: true });
  await dialog.getByLabel('최대 컷 수').selectOption('3');
  await dialog.getByRole('button', { name: '삽화 만들기', exact: true }).click();
  await expect(scene.getByTestId('illustration-task')).toHaveAttribute('data-status', 'running');
  const input = page.getByLabel('다음 장면 요청', { exact: true });
  await input.fill('두 사람의 다음 이야기를 이어줘.');
  await expect(page.getByRole('button', { name: '원문 생성', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '원문 생성', exact: true }).click();
  await expect.poll(async () => (await detail(request, chat.id)).sources.length).toBe(2);
  await request.post('/api/test/control', { data: { action: 'release', barrier: 'illustration' } });
  await expect
    .poll(
      async () =>
        (await illustrations(request, chat.id)).filter(
          (item) => item.task === 'render' && item.status === 'completed'
        ).length
    )
    .toBe(3);
  await page.reload();
  await expect(scene.locator('[data-placement="hero"]')).toHaveCount(1);
  await expect(scene.locator('[data-placement="inline"]')).toHaveCount(2);
  await expect(scene.getByTestId('illustration')).toHaveCount(3);
  const hero = scene.locator('[data-placement="hero"]');
  await hero.scrollIntoViewIfNeeded();
  for (const button of await scene.getByRole('button', { name: '펼치기', exact: true }).all())
    await button.click();
  const firstInline = scene.locator('[data-placement="inline"]').first();
  const after = await firstInline.getAttribute('data-after-anchor');
  expect(
    await firstInline.evaluate(
      (node) =>
        node
          .closest('[slot]')
          ?.assignedSlot?.previousElementSibling?.getAttribute('data-uimori-illustration-after') ??
        node.previousElementSibling?.getAttribute('data-block-anchor')
    )
  ).toBe(after);
  await hero.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('storyboard-desktop.png') });
  const pages = page.context().pages().length;
  const preview = firstInline.getByRole('button', { name: '삽화 크게 보기', exact: true });
  await preview.click();
  const enlarged = page.getByRole('dialog', { name: '삽화 크게 보기', exact: true });
  await expect(enlarged).toBeVisible();
  await expect(enlarged).toHaveCSS('opacity', '1');
  expect((await enlarged.boundingBox())!.width).toBeGreaterThan(1000);
  expect(page.context().pages()).toHaveLength(pages);
  await page.screenshot({ path: info.outputPath('illustration-modal-desktop.png') });
  await page.keyboard.press('Escape');
  await expect(enlarged).toBeHidden();
  await expect(preview).toBeFocused();
  const cutId = await hero.getByTestId('illustration').getAttribute('data-target-id');
  await hero.getByRole('button', { name: '접기', exact: true }).click();
  await page.reload();
  const folded = scene.locator(`[data-target-id="${cutId}"]`);
  await expect(folded.getByRole('button', { name: '펼치기', exact: true })).toBeVisible();
  await expect(folded.locator('.illustration-preview-trigger img')).toBeHidden();
  await scene.getByRole('button', { name: '모두 접기', exact: true }).click();
  await expect(scene.locator('.illustration-cut.is-collapsed')).toHaveCount(3);
  await scene.getByRole('button', { name: '모두 펼치기', exact: true }).click();
  await firstInline.getByLabel('삽화 작업 메뉴', { exact: true }).click();
  const promoted = await firstInline.getByTestId('illustration').getAttribute('data-target-id');
  await firstInline.getByRole('button', { name: '대표 삽화로 지정', exact: true }).click();
  await expect(scene.locator('[data-placement="hero"] [data-target-id]')).toHaveAttribute(
    'data-target-id',
    promoted!
  );
  await expect(scene.getByTestId('illustration')).toHaveCount(3);
  await page.setViewportSize({ width: MOBILE_WIDTH, height: 844 });
  await scene.locator('[data-placement="hero"]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('storyboard-mobile.png') });
  await scene
    .locator('[data-placement="hero"]')
    .getByRole('button', { name: '삽화 크게 보기', exact: true })
    .click();
  await expect(enlarged).toBeVisible();
  await expect(enlarged).toHaveCSS('opacity', '1');
  const geometry = (await enlarged.boundingBox())!;
  expect(geometry.x).toBeGreaterThanOrEqual(16);
  expect(geometry.y).toBeGreaterThanOrEqual(16);
  expect(geometry.x + geometry.width).toBeLessThanOrEqual(MOBILE_WIDTH - 16);
  expect(geometry.y + geometry.height).toBeLessThanOrEqual(844 - 16);
  expect(Math.abs(geometry.x + geometry.width / 2 - MOBILE_WIDTH / 2)).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry.y + geometry.height / 2 - 844 / 2)).toBeLessThanOrEqual(1);
  const original = enlarged.locator('img');
  await expect(original).toHaveCSS('object-fit', 'contain');
  await expect(original).toBeInViewport({ ratio: 1 });
  const imageBox = (await original.boundingBox())!;
  expect(imageBox.width / imageBox.height).toBeCloseTo(800 / 450, 2);
  const close = enlarged.getByRole('button', { name: '삽화 크게 보기 닫기', exact: true });
  await expect(close).toBeInViewport({ ratio: 1 });
  const closeBox = (await close.boundingBox())!;
  expect(closeBox.width).toBeGreaterThanOrEqual(44);
  expect(closeBox.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: info.outputPath('illustration-modal-mobile.png') });
  await enlarged.getByRole('button', { name: '삽화 크게 보기 닫기', exact: true }).click();
  await expect(enlarged).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect((await detail(request, chat.id)).sources.find((item) => item.id === source.id)?.text).toBe(
    paragraphs.join('\n\n')
  );
});

test('ILUI05 styled Markdown keeps its message tree, shows progress and reconnects edited translations', async ({
  page,
  request,
}, info) => {
  const { chat, source } = await seed(
    request,
    '<style>.risu-chat-text p { letter-spacing: 0.3px; }</style><label>읽기 메모 <input id="reading-note"></label>'
  );
  const paragraphs = [
    '강 위로 등불이 흔들렸다.',
    '미라가 부두에 도착했다.',
    '유나는 미라의 손을 잡았다.',
    '---',
    '> 저편으로 건너가자.',
    '- 등불\n- 다리',
    '두 사람은 함께 걸었다.',
  ];
  const edited = await request.put(`/api/sources/${source.id}/text`, {
    data: { text: paragraphs.join('\n\n'), expectedRevision: 0 },
  });
  expect(edited.ok()).toBeTruthy();
  const current = await edited.json();
  await settings(request, {
    generator: 'fixture',
    automatic: false,
    maxPerSource: 3,
    maxAutoRetries: 0,
  });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
  await page.goto(`/?chat=${chat.id}`);
  const scene = page.locator(`[data-source-id="${source.id}"][data-testid="source"]`);
  const surface = scene.locator('.risu-message-surface');
  await expect(scene.locator('#reading-note')).toBeVisible();
  await scene.locator('#reading-note').fill('현재 본문 유지');
  await surface.evaluate((host) => {
    (window as any).illustrationBody = host.shadowRoot!.querySelector('.risu-chat-text');
  });
  await request.post('/api/test/control', { data: { action: 'hold', barrier: 'illustration' } });
  const planned = await request.post(`/api/sources/${source.id}/illustrations`, {
    data: { expectedSourceHash: current.hash, maxTargets: 3 },
  });
  expect(planned.ok()).toBeTruthy();
  const activity = scene.getByTestId('turn-activity');
  await expect(activity.locator(':scope > summary')).toContainText('장면 선택 중');
  const spinner = activity.locator(':scope > summary .activity-spinner');
  await expect
    .poll(() =>
      spinner.evaluate((node) =>
        node.getAnimations().some((animation) => animation.playState === 'running')
      )
    )
    .toBe(true);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(() => spinner.evaluate((node) => node.getAnimations().length)).toBe(0);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await request.post('/api/test/control', { data: { action: 'release', barrier: 'illustration' } });
  await expect
    .poll(
      async () =>
        (await illustrations(request, chat.id)).filter(
          (item) => item.task === 'render' && item.status === 'completed'
        ).length
    )
    .toBe(3);
  await expect(scene.locator('[data-placement="inline"]')).toHaveCount(2);
  await expect(scene.getByTestId('illustration-supplement')).toHaveCount(0);
  expect(
    await surface.evaluate(
      (host) =>
        host.shadowRoot!.querySelector('.risu-chat-text') === (window as any).illustrationBody
    )
  ).toBe(true);
  await expect(scene.locator('#reading-note')).toHaveValue('현재 본문 유지');
  expect(
    await scene
      .locator('.risu-chat-text p')
      .first()
      .evaluate((node) => getComputedStyle(node).letterSpacing)
  ).toBe('0.3px');
  for (const node of await scene.locator('[data-placement="inline"]').all()) {
    const actual = await node.evaluate((element) => {
      const slot = element.closest('[slot]')?.assignedSlot;
      return {
        anchor: slot?.previousElementSibling?.getAttribute('data-uimori-illustration-after'),
        top: element.getBoundingClientRect().top,
        previousBottom: slot?.previousElementSibling?.getBoundingClientRect().bottom,
      };
    });
    expect(actual.anchor).toBe(await node.getAttribute('data-after-anchor'));
    expect(actual.top).toBeGreaterThanOrEqual(actual.previousBottom!);
  }
  await activity.locator(':scope > summary').click();
  const progress = activity.getByRole('region', { name: '이 응답의 삽화 작업' });
  await expect(progress).toContainText('3/3컷 완료');
  await progress.getByText('삽화 호출과 토큰', { exact: true }).click();
  await expect(progress).toContainText('모델 요청 0회');
  await expect(progress).toContainText('미확인');
  await activity.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('illustration-progress-desktop.png') });
  const pictures = (await illustrations(request, chat.id)).flatMap((item) =>
    item.images.map((image) => image.id)
  );
  const translate = async (text: string, expectedRevision: number) => {
    const response = await request.put(`/api/sources/${source.id}/translation`, {
      data: { text, expectedRevision, expectedSourceHash: current.hash },
    });
    expect(response.ok()).toBeTruthy();
    return response.json();
  };
  const merged = await translate('등불 아래서 두 사람이 만나 함께 다리를 건넜다.', 0);
  await scene.getByRole('button', { name: '번역 보기', exact: true }).click();
  await expect(scene.getByTestId('illustration-supplement')).toBeVisible();
  await scene.getByTestId('illustration-supplement').locator(':scope > summary').click();
  await expect(scene.getByTestId('illustration-supplement')).toContainText(
    '번역문에서 이 장면의 위치를 찾지 못했어요'
  );
  const previousPlacements = (await illustrations(request, chat.id)).filter(
    (item) => item.task === 'placement'
  ).length;
  await scene
    .getByTestId('illustration-supplement')
    .getByRole('button', { name: '번역 위치 다시 연결', exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await illustrations(request, chat.id)).filter(
          (item) => item.task === 'placement' && item.status === 'completed'
        ).length
    )
    .toBe(previousPlacements + 1);
  await translate(
    paragraphs.map((text) => (text === '---' ? text : `${text} `)).join('\n\n'),
    merged.revision
  );
  await expect(scene.getByTestId('illustration-supplement')).toHaveCount(0);
  await expect(scene.locator('[data-placement="inline"]')).toHaveCount(2);
  expect(
    (await illustrations(request, chat.id)).flatMap((item) => item.images.map((image) => image.id))
  ).toEqual(pictures);
  expect((await detail(request, chat.id)).sources.find((item) => item.id === source.id)?.text).toBe(
    paragraphs.join('\n\n')
  );
});
