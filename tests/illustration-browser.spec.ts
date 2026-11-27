import { readIllustrationAppearanceProfiles } from '../core/illustration-profiles.js';
import type { Content } from '../core/product.js';
import type { PackageImage } from '../core/package-images.js';
import sharp from 'sharp';
import { MOBILE_WIDTH, DESKTOP_WIDTH } from './fixtures/browser-viewports.js';
import { test, expect, type APIRequestContext } from '@playwright/test';
import type { Chat, ChatDetail, Run } from '../core/types.js';
import type {
  Illustration,
  IllustrationReferences,
  IllustrationSettings,
} from '../core/illustration.js';
import { fixtureBotInput, postFixtureChat } from './fixtures/chat.js';
import { nativeContent } from './fixtures/native-content.js';
import {
  navigationAction,
  openChatSettings,
  openSourceActions,
  selectChatSettingsSection,
  selectEditorSection,
} from './ui-navigation.js';

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
        data: { ...chat.settings, expectedSettingsRevision: 1 },
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

for (const width of [360]) {
  test(`character profiles keep linked roles reversible and protect drafts on refresh at ${width}px`, async ({
    page,
    request,
  }) => {
    const created = await postFixtureChat(request, { data: { title: `인물 외형 ${width}` } });
    expect(created.ok()).toBe(true);
    const chat = (await created.json()) as Chat;
    const image = await sharp({
      create: { width: 80, height: 80, channels: 3, background: '#6688aa' },
    })
      .png()
      .toBuffer();
    const uploaded = await request.post(`/api/chats/${chat.id}/assets`, {
      data: {
        title: '미라 초상',
        description: '',
        actor: '',
        outfit: '',
        location: '',
        allowedUse: 'both',
        mime: 'image/png',
        base64: image.toString('base64'),
      },
    });
    expect(uploaded.ok()).toBe(true);
    const asset = await uploaded.json();
    const path = `/api/chats/${chat.id}/illustration-references`;
    const seeded = await request.put(path, {
      data: { expectedRevision: 0, references: [{ ref: asset.id, role: 'style' }] },
    });
    expect(seeded.ok()).toBe(true);
    await page.setViewportSize({ width, height: 915 });
    await page.goto(`/?chat=${chat.id}`);
    await openChatSettings(page);
    await selectChatSettingsSection(page, '이미지');
    const dialog = page.getByRole('dialog', { name: '채팅 설정', exact: true });
    const references = dialog.getByRole('region', { name: '삽화 참고', exact: true });
    const role = references.getByLabel('미라 초상 참고 역할');
    await expect(role).toHaveValue('style');
    await references.getByRole('button', { name: '인물 추가' }).click();
    const profile = references.locator('.illustration-character-profile').first();
    await profile.getByLabel('이름', { exact: true }).fill('미라');
    await profile.getByRole('textbox', { name: '외형', exact: true }).fill('짧은 은발과 초록 눈');
    await expect(references.getByText('1 / 8 선택', { exact: true })).toBeVisible();
    await profile.getByRole('button', { name: '참조 이미지 선택', exact: true }).click();
    await page
      .getByRole('dialog', { name: '참조 이미지 선택', exact: true })
      .getByRole('button', { name: '미라 초상', exact: true })
      .click();
    await expect(profile.getByText('미라 초상', { exact: true })).toBeVisible();
    await expect(role).toHaveValue('character');
    await expect(role).toBeDisabled();
    await references.getByRole('button', { name: '삽화 참고 저장' }).click();
    await expect(references.getByRole('button', { name: '삽화 참고 저장' })).toBeDisabled();
    const saved = (await (await request.get(path)).json()) as IllustrationReferences;
    expect(saved.references).toEqual([{ ref: asset.id, role: 'style' }]);
    expect(saved.characterProfiles).toMatchObject([
      { name: '미라', appearance: '짧은 은발과 초록 눈', referenceRef: asset.id },
    ]);
    await profile.getByRole('button', { name: '이미지 연결 해제', exact: true }).click();
    await expect(role).toHaveValue('style');
    await expect(role).toBeEnabled();
    await profile.getByRole('textbox', { name: '외형', exact: true }).fill('초안: 짧은 은발');
    const remote = await request.put(path, {
      data: {
        expectedRevision: saved.revision,
        references: saved.references,
        characterProfiles: [{ ...saved.characterProfiles[0], appearance: '다른 창에서 바뀐 외형' }],
      },
    });
    expect(remote.ok()).toBe(true);
    await dialog.locator('.chat-settings-image-management > summary').click();
    const assets = dialog.getByRole('region', { name: '이 이야기의 이미지', exact: true });
    await assets
      .getByLabel('이미지 파일', { exact: true })
      .setInputFiles({ name: 'new.png', mimeType: 'image/png', buffer: image });
    await assets.getByLabel('이미지 이름', { exact: true }).fill('새 참고');
    await assets.getByLabel('이미지 설명', { exact: true }).fill('새 이미지');
    await assets.getByRole('button', { name: '이미지 등록', exact: true }).click();
    await expect(references.getByLabel('새 참고 참고 역할')).toBeVisible();
    await expect(profile.getByRole('textbox', { name: '외형', exact: true })).toHaveValue(
      '초안: 짧은 은발'
    );
    await references.getByRole('button', { name: '삽화 참고 저장' }).click();
    const conflict = page.getByRole('alertdialog', { name: '삽화 참고 저장본 확인' });
    await expect(conflict).toBeVisible();
    await expect(conflict).toContainText('다른 창에서 바뀐 외형');
    await conflict.getByRole('button', { name: '초안으로 계속' }).click();
    await expect(profile.getByRole('textbox', { name: '외형', exact: true })).toHaveValue(
      '초안: 짧은 은발'
    );
    await references.getByRole('button', { name: '삽화 참고 저장' }).click();
    await expect(references.getByRole('button', { name: '삽화 참고 저장' })).toBeDisabled();
    const final = (await (await request.get(path)).json()) as IllustrationReferences;
    expect(final.characterProfiles[0]).toMatchObject({
      name: '미라',
      appearance: '초안: 짧은 은발',
    });
    expect(final.characterProfiles[0].referenceRef).toBeUndefined();
    expect(final.references).toEqual([{ ref: asset.id, role: 'style' }]);
  });
}

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
  await expect(failedCard.getByRole('alert')).toHaveText('모의 실패예요.');
  await failedCard.getByLabel('삽화 작업 메뉴', { exact: true }).click();
  await failedCard.getByRole('button', { name: '생성 상세', exact: true }).click();
  await expect(detailDialog).toContainText('오류 코드: FIXTURE_FAILURE');
  await page.keyboard.press('Escape');
  await expect(failedCard.getByRole('button', { name: /다시 요청/u })).toHaveAttribute(
    'title',
    /사용량이 추가/u
  );
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
  await confirm.getByRole('button', { name: '삽화 삭제', exact: true }).click();
  await expect(page.getByTestId('illustration')).toHaveCount(1);
  expect(
    (await illustrations(request, chat.id)).filter((item) => item.task === 'render')
  ).toHaveLength(1);
  await page.screenshot({ path: info.outputPath('illustration-desktop.png') });
  expect((await detail(request, chat.id)).sources[0].text).toBe(source.text);
});

for (const width of [360]) {
  test(`ILUI-DIRECTION manual direction and redraw changes preserve drafts and submit once at ${width}px`, async ({
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
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: width === 360 ? 'light' : 'dark' });
    const manualRequests: Record<string, unknown>[] = [];
    let rejectManual = true;
    await page.route(`**/api/sources/${source.id}/illustrations`, async (route) => {
      manualRequests.push(route.request().postDataJSON());
      if (rejectManual)
        return route.fulfill({ status: 400, json: { error: '합성 삽화 요청 실패' } });
      return route.continue();
    });
    await page.goto(`/?chat=${chat.id}`);
    const scene = page.getByTestId('source').first();
    const openManual = async () => {
      await scene.getByLabel('장면 작업 메뉴', { exact: true }).scrollIntoViewIfNeeded();
      await openSourceActions(scene);
      await page.getByTestId('illustrate').click();
    };
    await openManual();
    const manual = page.getByRole('dialog', { name: '삽화 생성', exact: true });
    const direction = manual.getByRole('textbox', { name: '이번 삽화 연출 (선택)', exact: true });
    const directionText = '비 오는 강가에서 인물의 손과 등불을 가까이 보여 주세요.';
    await expect(direction).toHaveAttribute('maxlength', '8000');
    await direction.fill(directionText);
    await page.keyboard.press('Escape');
    expect(manualRequests).toEqual([]);
    await openManual();
    await expect(direction).toHaveValue(directionText);
    await manual.getByRole('button', { name: '삽화 만들기', exact: true }).click();
    await expect(manual.getByRole('alert')).toHaveText('요청을 처리할 수 없어요. (400)');
    await expect(direction).toHaveValue(directionText);
    await page.screenshot({ path: info.outputPath(`illustration-direction-${width}.png`) });
    await page.keyboard.press('Escape');
    await openManual();
    await expect(direction).toHaveValue(directionText);
    rejectManual = false;
    await manual.getByRole('button', { name: '삽화 만들기', exact: true }).click();
    await expect(manual).toBeHidden();
    expect(manualRequests).toHaveLength(2);
    expect(manualRequests[0]).toEqual(manualRequests[1]);
    expect(manualRequests[1]).toMatchObject({ direction: directionText, maxTargets: 1 });
    const card = page.getByTestId('illustration').first();
    await expect(card).toHaveAttribute('data-status', 'completed');
    const originalImage = (await illustrations(request, chat.id)).find(
      (item) => item.task === 'render' && item.status === 'completed'
    )!;
    const redrawRequests: Record<string, unknown>[] = [];
    let rejectRedraw = true;
    await page.route(`**/api/illustrations/*/regenerate`, async (route) => {
      expect(new URL(route.request().url()).pathname).toBe(
        `/api/illustrations/${originalImage.id}/regenerate`
      );
      redrawRequests.push(route.request().postDataJSON());
      if (rejectRedraw)
        return route.fulfill({ status: 400, json: { error: '합성 다시 그리기 실패' } });
      return route.continue();
    });
    const openRedraw = async () => {
      await card.getByLabel('삽화 작업 메뉴', { exact: true }).click();
      await card.getByRole('button', { name: '현재 설정으로 다시 그리기', exact: true }).click();
    };
    await openRedraw();
    const redraw = page.getByRole('dialog', { name: '현재 설정으로 다시 그리기', exact: true });
    const changes = redraw.getByRole('textbox', { name: '변경 요청 (선택)', exact: true });
    const changesText = '구도는 유지하고 등불의 빛을 조금 더 따뜻하게 해 주세요.';
    await expect(changes).toHaveAttribute('maxlength', '8000');
    await changes.fill(changesText);
    await page.keyboard.press('Escape');
    await expect(card.getByLabel('삽화 작업 메뉴', { exact: true })).toBeFocused();
    expect(redrawRequests).toEqual([]);
    await openRedraw();
    await expect(changes).toHaveValue(changesText);
    await redraw.getByRole('button', { name: '현재 설정으로 다시 그리기', exact: true }).click();
    await expect(redraw.getByRole('alert')).toHaveText('요청을 처리할 수 없어요. (400)');
    await expect(changes).toHaveValue(changesText);
    await page.screenshot({ path: info.outputPath(`illustration-redraw-${width}.png`) });
    rejectRedraw = false;
    await redraw.getByRole('button', { name: '현재 설정으로 다시 그리기', exact: true }).click();
    await expect(redraw).toBeHidden();
    expect(redrawRequests).toEqual([
      { changeRequest: changesText },
      { changeRequest: changesText },
    ]);
    await expect
      .poll(
        async () =>
          (await illustrations(request, chat.id)).filter(
            (item) => item.task === 'render' && item.status === 'completed'
          ).length
      )
      .toBe(2);
    const redrawn = (await illustrations(request, chat.id)).find(
      (item) =>
        item.task === 'render' && item.id !== originalImage.id && item.status === 'completed'
    )!;
    await expect(card).toHaveAttribute('data-illustration-id', redrawn.id);
    await expect(card).toHaveAttribute('data-status', 'completed');
    await expect(card.locator('img').first()).toHaveJSProperty('complete', true);
    expect((await detail(request, chat.id)).sources[0].text).toBe(source.text);
    await openManual();
    await expect(direction).toHaveValue('');
    await page.keyboard.press('Escape');
    await openRedraw();
    await expect(changes).toHaveValue('');
    expect(await redraw.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  });
}

test('ILUI04 storyboard places a hero and inline cuts, folds persist, and planning never blocks the next chat', async ({
  page,
  request,
}, info) => {
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: 1000 });
  await settings(request, {
    generator: 'fixture',
    automatic: false,
    maxPerSource: 4,
    maxAutoRetries: 0,
  });
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
  await firstInline.scrollIntoViewIfNeeded();
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
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect((await detail(request, chat.id)).sources.find((item) => item.id === source.id)?.text).toBe(
    paragraphs.join('\n\n')
  );
});

for (const width of [MOBILE_WIDTH]) {
  test(`ILLUSTRATION-PROFILES dedicated appearance tab saves package image references at ${width}px`, async ({
    page,
    request,
  }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const title = `기본 외형 ${width} ${Date.now()}`;
    const imageResponse = await request.post('/api/package-image-blobs', {
      data: {
        mime: 'image/png',
        base64: (
          await sharp({
            create: { width: 96, height: 128, channels: 3, background: '#826c94' },
          })
            .png()
            .toBuffer()
        ).toString('base64'),
      },
    });
    expect(imageResponse.ok(), await imageResponse.text()).toBe(true);
    const image = (await imageResponse.json()) as { hash: string; mime: PackageImage['mime'] };
    const input = fixtureBotInput(title, '미라는 녹색 눈과 검은 머리의 인물이다.');
    input.package = nativeContent(input.package.nativeRisu!.card, {
      images: [
        {
          id: 'mira-reference',
          title: '미라 참고 이미지',
          description: '',
          blobHash: image.hash,
          mime: image.mime,
          allowedUse: 'inline',
        },
      ],
    });
    const created = await request.post('/api/content', { data: input });
    expect(created.ok(), await created.text()).toBe(true);
    const bot = (await created.json()) as Content;
    const open = async () => {
      await page.goto('/');
      await navigationAction(page, '서재');
      await page.getByRole('searchbox', { name: '서재 검색', exact: true }).fill(title);
      await page.getByRole('button', { name: `${title} 편집`, exact: true }).click();
      const navigation = page.getByLabel('자료 편집 영역', { exact: true });
      await expect
        .poll(async () => {
          const titles = await navigation.locator('button').allTextContents();
          const index = titles.indexOf('기본 인물 외형');
          return index > 0 ? titles.slice(index - 1, index + 2) : titles;
        })
        .toEqual(['에셋1', '기본 인물 외형', '번역 지침']);
      await selectEditorSection(page, '기본 정보');
      await expect(page.getByRole('button', { name: '인물 추가', exact: true })).toBeHidden();
      await selectEditorSection(page, '기본 인물 외형');
    };
    await open();
    const editor = page.getByRole('region', { name: '기본 인물 외형', exact: true });
    await editor.getByRole('button', { name: '인물 추가', exact: true }).click();
    await editor.getByLabel('이름', { exact: true }).fill('미라');
    const appearance = '녹색 눈, 검은 머리. 나이와 평소 의상은 정해져 있지 않다.';
    await editor.getByRole('textbox', { name: '외형', exact: true }).fill(appearance);
    await editor.getByRole('button', { name: '참조 이미지 선택', exact: true }).click();
    const picker = page.getByRole('dialog', { name: '참조 이미지 선택', exact: true });
    await expect(picker.locator('img')).toHaveAttribute(
      'src',
      `/api/package-image-blobs/${image.hash}`
    );
    await picker.getByRole('button', { name: '미라 참고 이미지', exact: true }).click();
    const save = async () => {
      const saving = page.waitForResponse(
        (response) =>
          response.url().endsWith('/api/resources/save') && response.request().method() === 'POST'
      );
      await page.getByRole('button', { name: '변경사항 저장', exact: true }).click();
      return saving;
    };
    const savedResponse = await save();
    expect(savedResponse.ok(), await savedResponse.text()).toBe(true);
    const saved = (await savedResponse.json()).saved as Content;
    expect(readIllustrationAppearanceProfiles(saved.package.nativeRisu.card)).toEqual([
      { id: expect.any(String), name: '미라', appearance, referenceImageId: 'mira-reference' },
    ]);
    expect(saved.package.images).toEqual(bot.package.images);
    expect(saved.text).toBe(bot.text);
    await open();
    await expect(editor.getByLabel('이름', { exact: true })).toHaveValue('미라');
    await expect(editor.getByRole('textbox', { name: '외형', exact: true })).toHaveValue(
      appearance
    );
    await expect(
      editor.getByRole('img', { name: '미라 참고 이미지', exact: true })
    ).toHaveAttribute('src', `/api/package-image-blobs/${image.hash}`);
    expect(
      await editor
        .getByRole('img')
        .evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)
    ).toBe(true);
    await editor.scrollIntoViewIfNeeded();
    expect(await editor.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
      true
    );
    await page.screenshot({
      path: info.outputPath(`illustration-default-appearances-${width}.png`),
      fullPage: true,
    });
    const chatResponse = await request.post('/api/chats', {
      data: { title: `외형 상속 ${width}`, botId: bot.id },
    });
    expect(chatResponse.ok(), await chatResponse.text()).toBe(true);
    const chat = (await chatResponse.json()) as Chat;
    const inherited = await request.get(`/api/chats/${chat.id}/illustration-references`);
    expect(inherited.ok(), await inherited.text()).toBe(true);
    expect((await inherited.json()).characterProfiles).toEqual([
      {
        id: expect.any(String),
        name: '미라',
        appearance,
        referenceRef: `package:${bot.id}:bot:mira-reference`,
      },
    ]);
    await editor.getByRole('button', { name: '이미지 연결 해제', exact: true }).click();
    await expect(editor.getByRole('img')).toHaveCount(0);
    const unlinkedResponse = await save();
    expect(unlinkedResponse.ok(), await unlinkedResponse.text()).toBe(true);
    const unlinked = (await unlinkedResponse.json()).saved as Content;
    expect(readIllustrationAppearanceProfiles(unlinked.package.nativeRisu.card)).toEqual([
      { id: expect.any(String), name: '미라', appearance },
    ]);
    expect(unlinked.package.images).toEqual(bot.package.images);
    await open();
    await expect(editor.getByRole('img')).toHaveCount(0);
    await expect(editor.getByLabel('이름', { exact: true })).toHaveValue('미라');
    expect(errors).toEqual([]);
  });
}
