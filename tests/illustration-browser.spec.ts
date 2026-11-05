import { editableResource } from '../core/resource-editing.js';
import { withIllustrationAppearanceProfiles } from '../core/illustration-profiles.js';
import { readIllustrationAppearanceProfiles } from '../core/illustration-profiles.js';
import type { Content } from '../core/product.js';
import type { PackageImage } from '../core/package-images.js';
import sharp from 'sharp';
import { MOBILE_WIDTH, DESKTOP_WIDTH, DEFAULT_WIDTHS } from './fixtures/browser-viewports.js';
import { test, expect, type APIRequestContext } from '@playwright/test';
import type { Chat, ChatDetail, ReaderDetail, Run } from '../core/types.js';
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
  selectSettingsSection,
  selectPackageSection,
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

for (const width of [360, 412]) {
  test(`AUDIT2 illustration reference refresh failure keeps candidates, draft roles and revision before retry at ${width}px`, async ({
    page,
    request,
  }, info) => {
    const created = await postFixtureChat(request, {
      data: { title: `참조 이미지 갱신 ${width}` },
    });
    expect(created.ok(), await created.text()).toBe(true);
    const chat = (await created.json()) as Chat;
    const image = await sharp({
      create: { width: 80, height: 80, channels: 3, background: '#6688aa' },
    })
      .png()
      .toBuffer();
    for (const title of ['인물 기준 이미지', '배경 기준 이미지']) {
      const uploaded = await request.post(`/api/chats/${chat.id}/assets`, {
        data: {
          title,
          description: '합성 참조 이미지',
          actor: '',
          outfit: '',
          location: '',
          allowedUse: 'both',
          mime: 'image/png',
          base64: image.toString('base64'),
        },
      });
      expect(uploaded.ok(), await uploaded.text()).toBe(true);
    }
    const path = `/api/chats/${chat.id}/illustration-references`;
    const initial = (await (await request.get(path)).json()) as IllustrationReferences & {
      candidates: Array<{ ref: string; title: string }>;
    };
    const person = initial.candidates.find((item) => item.title === '인물 기준 이미지')!;
    const seeded = await request.put(path, {
      data: {
        expectedRevision: initial.revision,
        references: [{ ref: person.ref, role: 'character' }],
      },
    });
    expect(seeded.ok(), await seeded.text()).toBe(true);
    const saved = (await seeded.json()) as IllustrationReferences;
    let failRefresh = false;
    let failedReads = 0;
    const referenceWrites: unknown[] = [];
    const generationRequests: string[] = [];
    await page.route(`**${path}`, async (route) => {
      const entry = route.request();
      if (entry.method() === 'PUT') referenceWrites.push(entry.postDataJSON());
      if (entry.method() === 'GET' && failRefresh) {
        failedReads++;
        return route.fulfill({ status: 503, json: { error: '합성 삽화 참조 갱신 실패' } });
      }
      return route.continue();
    });
    page.on('request', (entry) => {
      if (
        entry.method() === 'POST' &&
        /\/(runs|retranslate|illustrations)$/.test(new URL(entry.url()).pathname)
      )
        generationRequests.push(entry.url());
    });
    await page.setViewportSize({ width, height: 915 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`/?chat=${chat.id}`);
    await openChatSettings(page);
    await selectChatSettingsSection(page, '이미지');
    const dialog = page.getByRole('dialog', { name: '채팅 설정', exact: true });
    const references = dialog.getByRole('region', { name: '삽화 참고', exact: true });
    const personRole = references.getByLabel('인물 기준 이미지 참고 역할', { exact: true });
    await expect(personRole).toHaveValue('character');
    await personRole.selectOption('style');
    failRefresh = true;
    await dialog.locator('.chat-settings-image-management > summary').click();
    const assets = dialog.getByRole('region', { name: '이 이야기의 이미지', exact: true });
    await assets.getByLabel('PNG 또는 JPEG 이미지', { exact: true }).setInputFiles({
      name: 'additional.png',
      mimeType: 'image/png',
      buffer: image,
    });
    await assets.getByLabel('이미지 이름', { exact: true }).fill('갱신 후 새 이미지');
    await assets
      .getByLabel('이미지 설명', { exact: true })
      .fill('새 후보가 들어올 때도 참조 초안은 유지돼요.');
    await assets.getByRole('button', { name: '이미지 등록', exact: true }).click();
    await expect.poll(() => failedReads).toBeGreaterThan(0);
    await expect(references.locator('figure')).toHaveCount(initial.candidates.length);
    await expect(personRole).toHaveValue('style');
    const unchanged = (await (await request.get(path)).json()) as IllustrationReferences;
    expect(unchanged.revision).toBe(saved.revision);
    expect(unchanged.references).toEqual(saved.references);
    expect(referenceWrites).toEqual([]);
    await references.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: info.outputPath(`audit2-reference-refresh-failed-${width}.png`),
    });
    await expect(references.getByRole('alert')).toContainText(
      '삽화 참고 이미지를 새로 불러오지 못했어요. 기존 선택은 유지했어요.'
    );
    await expect(references.getByRole('alert')).toContainText('(503)');
    const retry = references.getByRole('button', { name: '다시 불러오기', exact: true });
    await expect(retry).toBeVisible();
    failRefresh = false;
    await retry.click();
    await expect(references.getByRole('alert')).toBeHidden();
    await expect(references.locator('figure')).toHaveCount(initial.candidates.length + 1);
    await expect(personRole).toHaveValue('style');
    await expect(references.getByLabel('갱신 후 새 이미지 참고 역할', { exact: true })).toHaveValue(
      ''
    );
    const [acknowledged] = await Promise.all([
      page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === path && response.request().method() === 'PUT'
      ),
      references.getByRole('button', { name: '삽화 참고 저장', exact: true }).click(),
    ]);
    expect(acknowledged.ok()).toBe(true);
    await acknowledged.json();
    await expect(
      references.getByRole('button', { name: '삽화 참고 저장', exact: true })
    ).toBeDisabled();
    expect(referenceWrites).toEqual([
      {
        expectedRevision: saved.revision,
        references: [{ ref: person.ref, role: 'style' }],
        chatCharacterProfiles: [],
      },
    ]);
    const accepted = (await (await request.get(path)).json()) as IllustrationReferences;
    expect(accepted.revision).toBe(saved.revision + 1);
    expect(accepted.references).toEqual([{ ref: person.ref, role: 'style' }]);
    expect(generationRequests).toEqual([]);
    expect((await detail(request, chat.id)).runs).toHaveLength(0);
    await page.screenshot({ path: info.outputPath(`audit2-reference-recovered-${width}.png`) });
  });
}

for (const width of [360, 1280]) {
  test(`character profiles keep linked roles reversible and protect drafts on refresh at ${width}px`, async ({
    page,
    request,
  }, info) => {
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
    await profile.getByLabel('참고 이미지 (선택)').selectOption(asset.id);
    await expect(role).toHaveValue('character');
    await expect(role).toBeDisabled();
    await references.getByRole('button', { name: '삽화 참고 저장' }).click();
    await expect(references.getByRole('button', { name: '삽화 참고 저장' })).toBeDisabled();
    const saved = (await (await request.get(path)).json()) as IllustrationReferences;
    expect(saved.references).toEqual([{ ref: asset.id, role: 'style' }]);
    expect(saved.characterProfiles).toMatchObject([
      { name: '미라', appearance: '짧은 은발과 초록 눈', referenceRef: asset.id },
    ]);
    await page.screenshot({ path: info.outputPath(`character-profiles-${width}.png`) });
    await profile.getByLabel('참고 이미지 (선택)').selectOption('');
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
      .getByLabel('PNG 또는 JPEG 이미지', { exact: true })
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
    await conflict.getByRole('button', { name: '저장본 확인', exact: true }).click();
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

test('editing appearance preserves an unavailable saved reference until explicitly cleared', async ({
  page,
  request,
}) => {
  const created = await postFixtureChat(request, { data: { title: '분리된 참고 이미지' } });
  expect(created.ok()).toBe(true);
  const chat = (await created.json()) as Chat;
  const image = await sharp({
    create: { width: 80, height: 80, channels: 3, background: '#6688aa' },
  })
    .png()
    .toBuffer();
  const upload = await request.post(`/api/chats/${chat.id}/assets`, {
    data: {
      title: '잠시 없는 그림체',
      description: '',
      actor: '',
      outfit: '',
      location: '',
      allowedUse: 'both',
      mime: 'image/png',
      base64: image.toString('base64'),
    },
  });
  expect(upload.ok()).toBe(true);
  const asset = await upload.json();
  const path = `/api/chats/${chat.id}/illustration-references`;
  const initial = await request.put(path, {
    data: {
      expectedRevision: 0,
      references: [{ ref: asset.id, role: 'style' }],
      characterProfiles: [{ id: 'one', name: '미라', appearance: '은발' }],
    },
  });
  expect(initial.ok()).toBe(true);
  await page.setViewportSize({ width: 360, height: 915 });
  await page.goto(`/?chat=${chat.id}`);
  await openChatSettings(page);
  await selectChatSettingsSection(page, '이미지');
  const dialog = page.getByRole('dialog', { name: '채팅 설정', exact: true });
  const references = dialog.getByRole('region', { name: '삽화 참고', exact: true });
  await references.getByRole('textbox', { name: '외형', exact: true }).fill('은발과 초록 눈');
  const removed = await request.delete(`/api/chats/${chat.id}/assets/${asset.id}`, { data: {} });
  expect(removed.ok()).toBe(true);
  await dialog.locator('.chat-settings-image-management > summary').click();
  const assets = dialog.getByRole('region', { name: '이 이야기의 이미지', exact: true });
  await assets
    .getByLabel('PNG 또는 JPEG 이미지', { exact: true })
    .setInputFiles({ name: 'refresh.png', mimeType: 'image/png', buffer: image });
  await assets.getByLabel('이미지 이름', { exact: true }).fill('새 후보');
  await assets.getByLabel('이미지 설명', { exact: true }).fill('갱신 확인');
  await assets.getByRole('button', { name: '이미지 등록', exact: true }).click();
  await expect(references.getByLabel('새 후보 참고 역할')).toBeVisible();
  const unavailable = references.getByLabel('사용할 수 없는 참고 이미지 1', { exact: true });
  await expect(unavailable).toHaveValue('style');
  await references.getByRole('button', { name: '삽화 참고 저장' }).click();
  await expect(references.getByRole('button', { name: '삽화 참고 저장' })).toBeDisabled();
  const kept = (await (await request.get(path)).json()) as IllustrationReferences;
  expect(kept.references).toEqual([{ ref: asset.id, role: 'style' }]);
  expect(kept.characterProfiles[0].appearance).toBe('은발과 초록 눈');
  await unavailable.selectOption('');
  await references.getByRole('button', { name: '삽화 참고 저장' }).click();
  await expect(references.getByRole('button', { name: '삽화 참고 저장' })).toBeDisabled();
  expect(((await (await request.get(path)).json()) as IllustrationReferences).references).toEqual(
    []
  );
});

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
  await confirm.getByRole('button', { name: '영구 삭제', exact: true }).click();
  await expect(page.getByTestId('illustration')).toHaveCount(1);
  expect(
    (await illustrations(request, chat.id)).filter((item) => item.task === 'render')
  ).toHaveLength(1);
  await page.screenshot({ path: info.outputPath('illustration-desktop.png') });
  // The illustration strip never rewrote the story text.
  expect((await detail(request, chat.id)).sources[0].text).toBe(source.text);
});

test('ILUI-MOBILE-SHEET illustration actions stay above mobile composer controls', async ({
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
  await page.setViewportSize({ width: 376, height: 700 });
  await page.goto(`/?chat=${chat.id}`);
  // A positioned composer (including mobile floating controls) must never cover the sheet.
  await page.addStyleTag({ content: '.composer-dock { position: relative; z-index: 24; }' });
  const requested = await request.post(`/api/sources/${source.id}/illustrations`, {
    data: { maxTargets: 1 },
  });
  expect(requested.ok(), await requested.text()).toBe(true);
  const card = page.getByTestId('illustration').filter({ visible: true }).first();
  await expect(card).toHaveAttribute('data-status', 'completed');
  await card.getByLabel('삽화 작업 메뉴', { exact: true }).click();
  const deletion = card.locator('.action-menu-body').getByRole('button', { name: /삽화 삭제/u });
  await expect(deletion).toBeVisible();
  const actionBox = (await deletion.boundingBox())!;
  const composerBox = (await page.locator('.composer-dock').boundingBox())!;
  expect(actionBox.y + actionBox.height).toBeGreaterThan(composerBox.y);
  expect(
    await deletion.evaluate((button) => {
      const rect = button.getBoundingClientRect();
      return button.contains(
        document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      );
    })
  ).toBe(true);
  await page.screenshot({ path: info.outputPath('illustration-mobile-sheet.png') });
  await deletion.click();
  await expect(page.getByRole('alertdialog', { name: '삭제 확인', exact: true })).toBeVisible();
});

for (const width of [360, DESKTOP_WIDTH]) {
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

test('ILUI-DIRECTION source edits rotate an uncertain reservation key while retaining direction', async ({
  page,
  request,
}) => {
  const { chat, source } = await seed(request);
  await settings(request, {
    generator: 'fixture',
    automatic: false,
    maxPerSource: 3,
    maxAutoRetries: 0,
  });
  const reservations: Record<string, unknown>[] = [];
  await page.route(`**/api/sources/${source.id}/illustrations`, async (route) => {
    reservations.push(route.request().postDataJSON());
    if (reservations.length === 1) {
      const accepted = await route.fetch();
      expect(accepted.ok()).toBe(true);
      return route.abort('failed');
    }
    return route.continue();
  });
  await page.goto(`/?chat=${chat.id}`);
  const scene = page.getByTestId('source').first();
  const openManual = async () => {
    await openSourceActions(scene);
    await page.getByTestId('illustrate').click();
  };
  await openManual();
  const dialog = page.getByRole('dialog', { name: '삽화 생성', exact: true });
  const direction = dialog.getByRole('textbox', {
    name: '이번 삽화 연출 (선택)',
    exact: true,
  });
  const directionText = '등불을 내려놓는 손을 가까이 보여 주세요.';
  await direction.fill(directionText);
  await dialog.getByRole('button', { name: '삽화 만들기', exact: true }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await expect(direction).toHaveValue(directionText);
  await expect
    .poll(async () =>
      (await illustrations(request, chat.id)).some(
        (item) => item.task === 'render' && item.status === 'completed'
      )
    )
    .toBe(true);
  await page.keyboard.press('Escape');
  const revisedText = '기록이 바뀐 강가에서 미라가 등불을 내려놓았다.';
  const edit = await request.put(`/api/sources/${source.id}/text`, {
    data: { text: revisedText, expectedRevision: source.editRevision ?? 0 },
  });
  expect(edit.ok()).toBe(true);
  const revised = (await edit.json()) as { hash: string };
  expect(revised.hash).not.toBe(source.hash);
  await expect(scene).toContainText(revisedText);
  await openManual();
  await expect(direction).toHaveValue(directionText);
  const [admitted] = await Promise.all([
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/api/sources/${source.id}/illustrations` &&
        response.request().method() === 'POST'
    ),
    dialog.getByRole('button', { name: '삽화 만들기', exact: true }).click(),
  ]);
  expect(reservations).toHaveLength(2);
  expect(reservations[0]).toMatchObject({
    expectedSourceHash: source.hash,
    direction: directionText,
  });
  expect(reservations[1]).toMatchObject({
    expectedSourceHash: revised.hash,
    direction: directionText,
  });
  expect(reservations[1].idempotencyKey).not.toBe(reservations[0].idempotencyKey);
  expect(admitted.ok()).toBe(true);
  await expect(dialog).toBeHidden();
});

test('ILUI-DIRECTION blocked illustration without an image opens the change request dialog', async ({
  page,
  request,
}, info) => {
  const { chat, source } = await seed(request);
  await settings(request, { generator: 'fixture', automatic: false, maxPerSource: 3 });
  const created = await request.post(`/api/sources/${source.id}/illustrations`, { data: {} });
  expect(created.ok()).toBe(true);
  await expect
    .poll(async () =>
      (await illustrations(request, chat.id)).some(
        (item) => item.task === 'render' && item.status === 'completed'
      )
    )
    .toBe(true);
  // A synthetic blocked read exercises the recovery control without a paid provider rejection.
  await page.route(
    (url) => url.pathname === `/api/chats/${chat.id}/reader`,
    async (route) => {
      const response = await route.fetch();
      const reader = (await response.json()) as ReaderDetail;
      return route.fulfill({
        json: {
          ...reader,
          illustrations: reader.illustrations?.map((item) =>
            item.task === 'render'
              ? {
                  ...item,
                  status: 'failed',
                  error: 'ILLUSTRATION_CODEX_CONTENT_BLOCKED',
                  images: [],
                }
              : item
          ),
        },
      });
    }
  );
  const changes: unknown[] = [];
  await page.route('**/api/illustrations/*/regenerate', async (route) => {
    changes.push(route.request().postDataJSON());
    return route.fulfill({ status: 400, json: { error: '합성 변경 요청 실패' } });
  });
  await page.setViewportSize({ width: 360, height: 900 });
  await page.goto(`/?chat=${chat.id}`);
  const card = page.getByTestId('illustration').first();
  await expect(card).toHaveAttribute('data-status', 'failed');
  await expect(card.locator('img')).toHaveCount(0);
  const recover = card.getByRole('button', { name: '현재 프리셋으로 다시 그리기', exact: true });
  await recover.click();
  const dialog = page.getByRole('dialog', { name: '현재 설정으로 다시 그리기', exact: true });
  const changeRequest = dialog.getByRole('textbox', { name: '변경 요청 (선택)', exact: true });
  await expect(changeRequest).toBeVisible();
  expect(changes).toEqual([]);
  await changeRequest.fill('장면을 인물의 표정 중심으로 바꿔 주세요.');
  await dialog.getByRole('button', { name: '현재 설정으로 다시 그리기', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveText('요청을 처리할 수 없어요. (400)');
  expect(changes).toEqual([{ changeRequest: '장면을 인물의 표정 중심으로 바꿔 주세요.' }]);
  await page.screenshot({ path: info.outputPath('illustration-blocked-redraw-mobile.png') });
  await page.keyboard.press('Escape');
  await expect(recover).toBeFocused();
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
  {
    const management = page.getByText('생성 환경', { exact: true });
    if ((await management.locator('..').getAttribute('open')) === null) await management.click();
  }
  {
    const management = page.getByText('프리셋', { exact: true });
    if ((await management.locator('..').getAttribute('open')) === null) await management.click();
  }
  const section = page.getByRole('region', { name: '삽화 설정', exact: true });
  await expect(section).toBeVisible();
  const generator = section.getByLabel('테스트 삽화 생성기', { exact: true });
  await expect(generator).toHaveValue('');
  await generator.selectOption('fixture');
  await expect(section.getByLabel('응답 완료 후 자동 삽화 생성', { exact: true })).toBeVisible();
  const limit = section.getByLabel('장면당 최대 삽화 수', { exact: true });
  await limit.fill('3');
  await section.getByLabel('응답 완료 후 자동 삽화 생성', { exact: true }).check();
  await section
    .getByRole('combobox', { name: '자동 생성 컷 수', exact: true })
    .selectOption('auto');
  await section.getByLabel('최소 컷 수', { exact: true }).fill('0');
  await section.getByLabel('자동으로 고를 최대 컷 수', { exact: true }).fill('3');
  await section.getByLabel('자동 재시도 횟수', { exact: true }).fill('2');
  await section.getByRole('button', { name: '삽화 설정 저장', exact: true }).click();
  await expect(
    page.locator('.transient-notice[role="status"]').filter({ hasText: '삽화 설정을 저장했어요' })
  ).toBeVisible();
  const saved = await request.get('/api/illustration-settings');
  expect((await saved.json()) as IllustrationSettings).toMatchObject({
    generator: 'fixture',
    maxPerSource: 3,
    automaticCountMode: 'auto',
    automaticMinTargets: 0,
    automaticMaxTargets: 3,
    maxAutoRetries: 2,
    revision: before.revision + 1,
  });
  // A concurrent save elsewhere is rejected by CAS; the stale draft stays until it reloads.
  await settings(request, { maxAutoRetries: 3 });
  await limit.fill('4');
  await section.getByRole('button', { name: '삽화 설정 저장', exact: true }).click();
  const conflictDialog = page.getByRole('alertdialog', { name: '삽화 설정 저장본 확인' });
  await expect(
    conflictDialog.getByRole('button', { name: '현재 입력 유지', exact: true })
  ).toBeFocused();
  await conflictDialog.getByRole('button', { name: '저장본 확인', exact: true }).click();
  await expect(conflictDialog.getByLabel('현재 저장본')).toContainText('자동 재시도 횟수');
  await expect(conflictDialog.getByLabel('현재 저장본')).toContainText('3');
  expect(await conflictDialog.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  await conflictDialog.press('Escape');
  await expect(section.getByRole('alert')).toContainText('최신 설정을 불러와 주세요');
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
  await expect(reloadDialog.getByRole('alert')).toContainText('설정을 불러오지 못했어요');
  await expect(limit).toHaveValue('4');
  await page.unroute('**/api/illustration-settings');
  await reloadDialog.getByRole('button', { name: '초안 버리고 불러오기' }).click();
  await expect(section.getByLabel('자동 재시도 횟수', { exact: true })).toHaveValue('3');
  await expect(page.locator('body')).not.toHaveCSS('overflow-x', 'scroll');
  await page.screenshot({ path: info.outputPath('illustration-settings-mobile.png') });
});

test('ILUI03 illustration editors use full width and seconds preserve stored milliseconds', async ({
  page,
  request,
}, info) => {
  await seed(request);
  const stored = await (await request.get('/api/illustration-settings')).json();
  await settings(request, {
    generator: 'none',
    comfyui: { ...stored.comfyui, pollIntervalMs: 250 },
  });
  await page.goto('/');
  await navigationAction(page, '설정');
  await selectSettingsSection(page, '삽화');
  {
    const management = page.getByText('생성 환경', { exact: true });
    if ((await management.locator('..').getAttribute('open')) === null) await management.click();
  }
  {
    const management = page.getByText('프리셋', { exact: true });
    if ((await management.locator('..').getAttribute('open')) === null) await management.click();
  }
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
    await section.getByLabel('시간 제한 (초)', { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`illustration-comfyui-${width}.png`) });
  }
  await section.getByLabel('시간 제한 (초)', { exact: true }).fill('60');
  await expect(section.getByLabel('확인 간격 (초)', { exact: true })).toHaveCount(0);
  await section.getByLabel('테스트 삽화 생성기', { exact: true }).selectOption('');
  await section.getByRole('button', { name: '삽화 설정 저장', exact: true }).click();
  await expect(
    page.locator('.transient-notice[role="status"]').filter({ hasText: '삽화 설정을 저장했어요' })
  ).toBeVisible();
  const saved = await (await request.get('/api/illustration-settings')).json();
  expect(saved.comfyui).toMatchObject({ timeoutMs: 60000, pollIntervalMs: 250 });
  await page.route('**/api/illustration-settings', (route) =>
    route.fulfill({ status: 503, body: 'unavailable' })
  );
  await section.getByRole('button', { name: '저장된 설정 다시 불러오기' }).click();
  await expect(section.getByRole('alert')).toContainText('설정을 불러오지 못했어요');
  await page.unroute('**/api/illustration-settings');
  await section.getByLabel('장면당 최대 삽화 수').fill('5');
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
  await expect(section.getByLabel('장면당 최대 삽화 수')).toHaveValue('5');
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
  await page.setViewportSize({ width: MOBILE_WIDTH, height: 844 });
  const cancel = scene.getByTestId('illustration-task').getByRole('button', { name: '취소' });
  await expect(cancel).toBeVisible();
  const cancelBox = (await cancel.boundingBox())!;
  expect(cancelBox.width).toBeGreaterThanOrEqual(44);
  expect(cancelBox.height).toBeGreaterThanOrEqual(44);
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: 1000 });
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
  // Reach the inline cut before opening its lazily loaded image.
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
  await page.setViewportSize({ width: MOBILE_WIDTH, height: 844 });
  for (const control of [
    scene.locator('[data-placement="hero"]').getByRole('button', { name: '접기', exact: true }),
    scene.getByRole('button', { name: '모두 접기', exact: true }),
  ]) {
    const box = (await control.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
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

test('ILUI06 Codex settings require a prompt model and persist separate or shared Codex selections', async ({
  page,
  request,
}, info) => {
  const created = await postFixtureChat(request, { data: { title: 'Codex 프롬프트 모델 선택' } });
  expect(created.ok()).toBe(true);
  const chat = (await created.json()) as Chat;
  const models: { id: string }[] = [];
  for (const entry of [
    {
      title: 'Codex 그림 담당',
      protocol: 'codex-app-server-v1',
      endpoint: 'codex://local',
      modelId: 'gpt-5.4',
    },
    {
      title: '별도 프롬프트 담당',
      protocol: 'fixture-sse-v1',
      endpoint: 'http://127.0.0.1:9/not-called',
      modelId: 'prompt-fixture',
    },
  ]) {
    const connected = await request.post('/api/connections', {
      data: {
        title: entry.title,
        protocol: entry.protocol,
        endpoint: entry.endpoint,
        enabled: true,
      },
    });
    expect(connected.ok(), await connected.text()).toBe(true);
    const connection = (await connected.json()) as { id: string };
    const modeled = await request.post('/api/model-presets', {
      data: {
        title: entry.title,
        connectionId: connection.id,
        modelId: entry.modelId,
        maxOutputTokens: 2048,
        temperature: null,
      },
    });
    expect(modeled.ok(), await modeled.text()).toBe(true);
    const model = (await modeled.json()) as { id: string };
    models.push({ id: model.id });
  }
  const current = (await (
    await request.get('/api/illustration-settings')
  ).json()) as IllustrationSettings;
  const baseline = await settings(request, {
    generator: 'none',
    codex: { ...current.codex, model: models[0], promptModel: null },
  });
  const generationRequests: string[] = [];
  page.on('request', (entry) => {
    if (entry.method() === 'POST' && /\/(runs|illustrations)$/.test(new URL(entry.url()).pathname))
      generationRequests.push(entry.url());
  });
  await page.setViewportSize({ width: MOBILE_WIDTH, height: 900 });
  const openSettings = async () => {
    await page.goto(`/?chat=${chat.id}`);
    await navigationAction(page, '설정');
    await selectSettingsSection(page, '삽화');
    for (const label of ['생성 환경', '프리셋']) {
      const management = page.getByText(label, { exact: true });
      if ((await management.locator('..').getAttribute('open')) === null) await management.click();
    }
  };
  await openSettings();
  const section = page.getByRole('region', { name: '삽화 설정', exact: true });
  const prompt = section.getByRole('combobox', { name: '프롬프트 모델', exact: true });
  await expect(prompt).toHaveValue('');
  await expect(prompt.locator('option[value=""]')).toHaveText('모델 미지정');
  await expect(page.locator('.illustration-preset-current')).toContainText('프롬프트 모델을 선택');
  await prompt.selectOption(models[1].id);
  await section.getByRole('button', { name: '삽화 설정 저장', exact: true }).click();
  await expect(section.getByRole('button', { name: '삽화 설정 저장', exact: true })).toBeDisabled();
  const selected = (await (
    await request.get('/api/illustration-settings')
  ).json()) as IllustrationSettings;
  expect(selected.codex).toEqual({ ...baseline.codex, promptModel: models[1] });
  expect(selected.comfyui).toEqual(baseline.comfyui);
  await openSettings();
  await expect(prompt).toHaveValue(models[1].id);
  await expect(section.getByLabel('Codex 삽화 모델', { exact: true })).toHaveValue(models[0].id);
  await prompt.scrollIntoViewIfNeeded();
  expect(await section.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(
    1
  );
  await page.screenshot({ path: info.outputPath('codex-separate-prompt-model-mobile.png') });
  await prompt.selectOption(models[0].id);
  await section.getByRole('button', { name: '삽화 설정 저장', exact: true }).click();
  await expect(section.getByRole('button', { name: '삽화 설정 저장', exact: true })).toBeDisabled();
  await openSettings();
  await expect(prompt).toHaveValue(models[0].id);
  const shared = (await (
    await request.get('/api/illustration-settings')
  ).json()) as IllustrationSettings;
  expect(shared.codex).toEqual({ ...baseline.codex, promptModel: models[0] });
  await expect(page.locator('.illustration-preset-current')).not.toContainText(
    '프롬프트 모델을 선택'
  );
  expect(generationRequests).toEqual([]);
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
  const slot = surface.locator('.illustration-slot').first();
  const originalAppFont = await page.evaluate(() =>
    document.documentElement.style.getPropertyValue('--app-font-family')
  );
  await page.evaluate(() =>
    document.documentElement.style.setProperty('--app-font-family', '"Courier New", monospace')
  );
  await expect(slot).toHaveCSS('font-family', /Courier New/u);
  await slot.evaluate((node) => node.style.setProperty('--font-ui', 'Georgia, serif'));
  await expect(slot).toHaveCSS('font-family', /Georgia/u);
  await slot.evaluate((node) => node.style.removeProperty('--font-ui'));
  await page.evaluate(
    (value) => document.documentElement.style.setProperty('--app-font-family', value),
    originalAppFont
  );
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

for (const width of DEFAULT_WIDTHS) {
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
      await page.getByRole('button', { name: `${title} 상세 보기`, exact: true }).click();
      await page.getByRole('button', { name: '편집', exact: true }).click();
      const navigation = page.getByLabel('자료 편집 영역', { exact: true });
      const titles = await navigation.locator('button').allTextContents();
      const appearanceIndex = titles.indexOf('기본 인물 외형');
      expect(appearanceIndex).toBeGreaterThan(0);
      expect(titles[appearanceIndex - 1]).toBe('번역 지침');
      expect(titles[appearanceIndex + 1]).toBe('고급 설정');
      await selectPackageSection(page, '기본 정보');
      await expect(page.getByRole('button', { name: '인물 추가', exact: true })).toBeHidden();
      await selectPackageSection(page, '기본 인물 외형');
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

for (const width of DEFAULT_WIDTHS) {
  test(`ILLUSTRATION-INHERIT chat appearance edit restore and own deletion at ${width}px`, async ({
    page,
    request,
  }, info) => {
    const input = fixtureBotInput(`상속 편집 ${width}`);
    input.package.nativeRisu!.card = withIllustrationAppearanceProfiles(
      input.package.nativeRisu!.card,
      [{ id: 'mira', name: '미라', appearance: '검은 머리와 녹색 눈' }]
    );
    const created = await request.post('/api/content', { data: input });
    expect(created.ok()).toBe(true);
    const bot = (await created.json()) as Content;
    const started = await request.post('/api/chats', {
      data: { title: `상속 ${width}`, botId: bot.id },
    });
    expect(started.ok()).toBe(true);
    const chat = (await started.json()) as Chat;
    const path = `/api/chats/${chat.id}/illustration-references`;
    await page.setViewportSize({ width, height: 1000 });
    const open = async () => {
      await page.goto(`/?chat=${chat.id}`);
      await openChatSettings(page);
      await selectChatSettingsSection(page, '이미지');
    };
    await open();
    const references = page.getByTestId('illustration-references');
    const row = references.locator('.illustration-character-profile').first();
    const appearance = row.getByRole('textbox', { name: '외형', exact: true });
    await expect(row.locator('.illustration-profile-summary')).toHaveText(
      '미라검은 머리와 녹색 눈'
    );
    await expect(appearance).toHaveCount(0);
    await expect(row.getByRole('button', { name: /삭제/ })).toHaveCount(0);
    await row.getByRole('button', { name: /편집/ }).click();
    await expect(appearance).toBeEditable();
    await appearance.fill('은발과 녹색 눈');
    await row.getByLabel('이름', { exact: true }).fill('미라 별명');
    const save = references.getByRole('button', { name: '삽화 참고 저장' });
    await save.click();
    await expect(save).toBeDisabled();
    const overridden = (await (await request.get(path)).json()) as IllustrationReferences;
    expect(overridden.chatCharacterProfiles).toEqual([
      {
        ...overridden.defaultCharacterProfiles[0],
        name: '미라 별명',
        appearance: '은발과 녹색 눈',
      },
    ]);
    const model = editableResource('content', bot);
    if (!('package' in model)) throw new Error('Expected content model');
    model.package.nativeRisu.card = withIllustrationAppearanceProfiles(
      model.package.nativeRisu.card,
      [{ id: 'mira', name: '미라', appearance: '갈색 머리와 녹색 눈' }]
    );
    const updated = await request.post('/api/resources/save', {
      data: { kind: 'content', id: bot.id, expectedRevision: bot.revision, model },
    });
    expect(updated.ok(), await updated.text()).toBe(true);
    await open();
    await expect(appearance).toHaveValue('은발과 녹색 눈');
    await row.getByRole('button', { name: /복원/ }).click();
    await expect(row.locator('.illustration-profile-summary')).toHaveText(
      '미라갈색 머리와 녹색 눈'
    );
    await expect(appearance).toHaveCount(0);
    await save.click();
    await expect(save).toBeDisabled();
    expect((await (await request.get(path)).json()).chatCharacterProfiles).toEqual([]);
    await references.getByRole('button', { name: '인물 추가', exact: true }).click();
    const own = references.locator('.illustration-character-profile').last();
    await own.getByLabel('이름', { exact: true }).fill('준');
    await own.getByRole('textbox', { name: '외형', exact: true }).fill('짧은 갈색 머리');
    await save.click();
    await expect(save).toBeDisabled();
    await own.getByRole('button', { name: /삭제/ }).click();
    await save.click();
    await expect(save).toBeDisabled();
    const restored = (await (await request.get(path)).json()) as IllustrationReferences;
    expect(restored.chatCharacterProfiles).toEqual([]);
    expect(restored.characterProfiles).toEqual(restored.defaultCharacterProfiles);
    expect(
      await references.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)
    ).toBe(true);
    await references.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: info.outputPath(`illustration-inheritance-${width}.png`),
      fullPage: true,
    });
  });
}
