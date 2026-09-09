import { navigationAction } from './ui-navigation.js';
import { waitForContentDraftSave } from './fixtures/edit-draft-save.js';
import { visualReview } from './fixtures/visual-review.js';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { ContentPackage } from '../core/content-package.js';
import type { LibraryOrganization } from '../core/library-organization.js';
import type { Content } from '../core/product.js';
import type { ChatDetail } from '../core/types.js';
import { revealLibraryEditor, selectPackageSection } from './ui-navigation.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG1sAAAAASUVORK5CYII=',
  'base64'
);
const otherPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=',
  'base64'
);
async function blob(request: APIRequestContext, bytes = png): Promise<string> {
  const response = await request.post('/api/package-image-blobs', {
    data: { mime: 'image/png', base64: bytes.toString('base64') },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).hash;
}
async function seed(
  request: APIRequestContext,
  kind: Content['kind'],
  title: string,
  part: Partial<ContentPackage> = {}
): Promise<Content> {
  const pkg: ContentPackage = {
    version: 1,
    id: 'synthetic-library-portrait',
    revision: 1,
    title,
    description: '합성 자료 · 이미지와 선택 동작 검사',
    body: 'Synthetic content only.',
    lore: [],
    instructions: [],
    controls: [],
    transforms: [],
    ...part,
  };
  const response = await request.post('/api/content', {
    data: {
      kind,
      title,
      description: pkg.description,
      text: pkg.body,
      loading: 'pinned',
      relatedIds: [],
      package: pkg,
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
async function openLibrary(page: Page, kind: Content['kind']) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await navigationAction(page, '서재');
  const library = page.getByTestId('library-panel');
  await library
    .getByRole('tab', {
      name: { bot: '봇', persona: '페르소나', module: '모듈' }[kind],
      exact: true,
    })
    .click();
  return library;
}
async function edit(page: Page, content: Content) {
  const library = await openLibrary(page, content.kind);
  await library.getByRole('searchbox', { name: '서재 검색', exact: true }).fill(content.title);
  await library.getByRole('button', { name: `${content.title} 상세 보기`, exact: true }).click();
  await library
    .locator('.library-detail-actions > button')
    .filter({ hasText: /^편집$/ })
    .click();
  await revealLibraryEditor(page);
  return library;
}
async function save(page: Page, library: Locator, content: Content): Promise<Content> {
  const pending = waitForContentDraftSave(page, content.id);
  await library.getByRole('button', { name: '변경사항 저장', exact: true }).click();
  return pending;
}
const portraitPart = (hash: string, id = 'portrait'): Partial<ContentPackage> => ({
  images: [
    {
      id,
      title: '합성 대표 이미지',
      description: '',
      blobHash: hash,
      mime: 'image/png',
      allowedUse: 'profile',
    },
  ],
  portraitImageId: id,
});

test('LIMG01 representative image upload, unset and existing inline selection preserve immutable revisions', async ({
  page,
  request,
}, info) => {
  test.setTimeout(60000);
  const originalHash = await blob(request),
    original = await seed(request, 'persona', `대표 이미지 합성 ${Date.now()}`, {
      images: [
        {
          id: 'inline',
          title: '본문 그림',
          description: '',
          blobHash: originalHash,
          mime: 'image/png',
          allowedUse: 'inline',
        },
      ],
    });
  const library = await edit(page, original),
    portrait = library.getByRole('region', { name: '대표 이미지 설정', exact: true });
  await portrait
    .getByLabel('대표 이미지 업로드', { exact: true })
    .setInputFiles({ name: 'portrait.png', mimeType: 'image/png', buffer: otherPng });
  await expect(portrait.getByRole('status')).toContainText('대표 이미지 전용으로 추가했어요');
  const uploaded = await save(page, library, original),
    profile = uploaded.package!.images!.find(
      (image) => image.id === uploaded.package!.portraitImageId
    )!;
  expect(profile.allowedUse).toBe('profile');
  expect(profile.blobHash).not.toBe(originalHash);
  expect(uploaded.package!.images).toHaveLength(2);
  await expect(portrait.locator('img')).toHaveAttribute(
    'src',
    `/api/package-image-blobs/${profile.blobHash}`
  );
  await library.getByRole('button', { name: '← 서재 목록', exact: true }).click();
  const card = library.getByRole('button', { name: `${original.title} 상세 보기`, exact: true });
  await expect(card.locator('img')).toHaveAttribute(
    'src',
    `/api/package-image-blobs/${profile.blobHash}`
  );
  await card.click();
  await library
    .locator('.library-detail-actions > button')
    .filter({ hasText: /^편집$/ })
    .click();
  await revealLibraryEditor(page);
  await portrait.getByRole('button', { name: '대표 이미지 해제', exact: true }).click();
  const unset = await save(page, library, uploaded);
  expect(unset.package!.portraitImageId).toBeUndefined();
  expect(unset.package!.images).toEqual(uploaded.package!.images);
  await expect(portrait.locator('img')).toHaveCount(0);
  await portrait.getByRole('button', { name: '기존 이미지에서 선택', exact: true }).click();
  const picker = page.getByRole('dialog', { name: '대표 이미지 선택', exact: true });
  await picker
    .getByRole('button')
    .filter({ has: page.getByText('본문 그림', { exact: true }) })
    .click();
  await expect(portrait.getByRole('status')).toContainText('대표 이미지와 본문으로 바꿨어요');
  const reused = await save(page, library, unset);
  expect(reused.package!.portraitImageId).toBe('inline');
  expect(reused.package!.images![0].allowedUse).toBe('both');
  await selectPackageSection(page, '이미지');
  const images = library.getByRole('region', { name: '자료 이미지', exact: true });
  await images
    .getByRole('listitem')
    .filter({ has: page.locator(`img[src="/api/package-image-blobs/${profile.blobHash}"]`) })
    .getByRole('button')
    .click();
  await images.getByRole('button', { name: '이 자료에서 이미지 제거', exact: true }).click();
  await images.getByRole('button', { name: '이미지 참조 제거', exact: true }).click();
  const removed = await save(page, library, reused);
  expect(removed.package!.images).toHaveLength(1);
  expect(removed.package!.portraitImageId).toBe('inline');
  for (const previous of [original, uploaded, unset, reused]) {
    const old: Content = await (
      await request.get(`/api/revisions/content/${previous.id}/${previous.revision}`)
    ).json();
    expect(old.package).toEqual(previous.package);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await portrait.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true
  );
  if (visualReview)
    await page.screenshot({ path: info.outputPath('portrait-authoring-mobile.png') });
});

test('LIMG02 persona folder picker supports keyboard selection and nested Escape without creating a chat', async ({
  page,
  request,
}, info) => {
  test.setTimeout(60000);
  const stamp = Date.now(),
    hash = await blob(request),
    bot = await seed(request, 'bot', `선택기 봇 ${stamp}`, portraitPart(hash)),
    persona = await seed(request, 'persona', `선택기 인물 ${stamp}`, portraitPart(hash)),
    module = await seed(
      request,
      'module',
      `선택기 모듈 ${stamp} 아주 긴 인물 이름과 세계관 소개`,
      portraitPart(hash)
    );
  let organization: LibraryOrganization = await (
    await request.get('/api/library/organization')
  ).json();
  const createdFolder = await request.post('/api/library/folders', {
    data: {
      expectedRevision: organization.revision,
      category: 'persona',
      title: `인물 폴더 ${stamp}`,
    },
  });
  expect(createdFolder.ok()).toBe(true);
  organization = await createdFolder.json();
  const folder = organization.folders.find((item) => item.title === `인물 폴더 ${stamp}`)!;
  const moved = await request.post('/api/library/organization/move', {
    data: {
      expectedRevision: organization.revision,
      category: 'persona',
      folderId: folder.id,
      items: [{ kind: 'content', id: persona.id }],
    },
  });
  expect(moved.ok()).toBe(true);
  let chatPosts = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/api/chats')) chatPosts++;
  });
  const library = await openLibrary(page, 'bot');
  await library.getByRole('searchbox', { name: '서재 검색', exact: true }).fill(bot.title);
  await library.getByRole('button', { name: `${bot.title} 새 채팅`, exact: true }).click();
  const newChat = page.getByRole('dialog', { name: '새 채팅', exact: true });
  await newChat.locator('.new-story-options > summary').click();
  const trigger = newChat.getByRole('button', { name: '시작 페르소나', exact: true });
  await trigger.click();
  const picker = page.getByRole('dialog', { name: '시작 페르소나', exact: true });
  await picker.getByRole('searchbox').fill('선택기');
  await expect(picker.getByText(persona.title, { exact: true })).toBeVisible();
  await expect(picker.getByText(bot.title, { exact: true })).toHaveCount(0);
  await expect(picker.getByText(module.title, { exact: true })).toHaveCount(0);
  await picker
    .getByRole('combobox', { name: '시작 페르소나 폴더', exact: true })
    .selectOption(folder.id);
  await expect(
    picker.locator('[data-content-choice]').filter({ hasText: persona.title })
  ).toHaveCount(1);
  const search = picker.getByRole('searchbox');
  await search.press('Enter');
  await expect(newChat).toBeVisible();
  expect(chatPosts).toBe(0);
  await search.focus();
  await search.press('ArrowDown');
  await expect(picker.getByRole('button', { name: '페르소나 없음', exact: true })).toBeFocused();
  await page.keyboard.press('End');
  const choice = picker
    .getByRole('button')
    .filter({ has: page.getByText(persona.title, { exact: true }) });
  await expect(choice).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(picker).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await expect(trigger).toContainText(persona.title);
  await trigger.click();
  await expect(picker.getByRole('button', { name: '모든 자료', exact: true })).toHaveCount(0);
  await picker.getByRole('searchbox').fill(module.title);
  await expect(picker.getByText(module.title, { exact: true })).toHaveCount(0);
  await picker.getByRole('searchbox').fill(persona.title);
  await expect(choice.locator('img')).toHaveAttribute('src', `/api/package-image-blobs/${hash}`);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await picker.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
    true
  );
  if (visualReview) await page.screenshot({ path: info.outputPath('persona-picker-mobile.png') });
  await picker.getByRole('button', { name: '페르소나 없음', exact: true }).click();
  await expect(trigger).toContainText('페르소나 없음');
  await trigger.click();
  await page.keyboard.press('Escape');
  await expect(picker).not.toBeVisible();
  await expect(newChat).toBeVisible();
  await expect(trigger).toBeFocused();
  expect(chatPosts).toBe(0);
  const original: Content = await (
    await request.get(`/api/revisions/content/${module.id}/${module.revision}`)
  ).json();
  expect(original.kind).toBe('module');
  expect(original.package).toEqual(module.package);
});

test('LIMG03 cancelled and failed portrait uploads cannot change a saved draft or leave saving blocked', async ({
  page,
  request,
}) => {
  const original = await seed(request, 'bot', `업로드 취소 합성 ${Date.now()}`);
  const library = await edit(page, original),
    portrait = library.getByRole('region', { name: '대표 이미지 설정', exact: true }),
    saveButton = library.getByRole('button', { name: '변경사항 저장', exact: true });
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/package-image-blobs', async (route) => {
    await waiting;
    await route
      .fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ hash: 'c'.repeat(64), mime: 'image/png' }),
      })
      .catch(() => {});
  });
  await portrait
    .getByLabel('대표 이미지 업로드', { exact: true })
    .setInputFiles({ name: 'pending.png', mimeType: 'image/png', buffer: png });
  await expect(portrait.getByRole('button', { name: '업로드 취소', exact: true })).toBeVisible();
  await expect(saveButton).toBeDisabled();
  await portrait.getByRole('button', { name: '업로드 취소', exact: true }).click();
  release();
  await expect(saveButton).toBeEnabled();
  await expect(portrait.locator('img')).toHaveCount(0);
  await page.unroute('**/api/package-image-blobs');
  await page.route('**/api/package-image-blobs', (route) =>
    route.fulfill({ status: 503, body: 'synthetic failure' })
  );
  await portrait
    .getByLabel('대표 이미지 업로드', { exact: true })
    .setInputFiles({ name: 'failed.png', mimeType: 'image/png', buffer: png });
  await expect(portrait.getByRole('alert')).toContainText('503');
  await expect(saveButton).toBeEnabled();
  await expect(portrait.locator('img')).toHaveCount(0);
  const saved: Content = await (
    await request.get(`/api/revisions/content/${original.id}/${original.revision}`)
  ).json();
  expect(saved.package).toEqual(original.package);
  const after = await save(page, library, original);
  expect(after.package?.images ?? []).toEqual([]);
  expect(after.package?.portraitImageId).toBeUndefined();
});

test('LIMG04 shared module references show current names and portraits while preserving archived evidence', async ({
  page,
  request,
}) => {
  const oldHash = await blob(request),
    newHash = await blob(request, otherPng),
    child = await seed(request, 'module', `고정 모듈 이미지 ${Date.now()}`, portraitPart(oldHash)),
    parent = await seed(request, 'bot', `고정 연결 봇 ${Date.now()}`, {
      modules: [{ id: child.id, revision: child.revision }],
    });
  const changed = await request.put(`/api/content/${child.id}`, {
    data: {
      kind: child.kind,
      title: `${child.title} 새 이름`,
      description: child.description,
      text: child.text,
      loading: child.loading,
      relatedIds: [],
      package: { ...child.package!, title: `${child.title} 새 이름`, ...portraitPart(newHash) },
      expectedRevision: child.revision,
    },
  });
  expect(changed.ok(), await changed.text()).toBe(true);
  const library = await edit(page, parent);
  await selectPackageSection(page, '연결과 기능');
  const features = library.getByLabel('패키지 모듈과 기능 편집', { exact: true });
  const current = features.getByRole('group', { name: `${child.title} 새 이름`, exact: true });
  await expect(current).toBeVisible();
  await expect(current.locator('img')).toHaveAttribute(
    'src',
    `/api/package-image-blobs/${newHash}`
  );
  await expect(features.getByText(child.title, { exact: true })).toHaveCount(0);
  const original: Content = await (
    await request.get(`/api/revisions/content/${child.id}/${child.revision}`)
  ).json();
  expect(original.package).toEqual(child.package);
});

test('LIMG05 quick persona selection shows one current selection after its image changes', async ({
  page,
  request,
}) => {
  const oldHash = await blob(request),
    newHash = await blob(request, otherPng),
    persona = await seed(
      request,
      'persona',
      `이전 인물 이미지 ${Date.now()}`,
      portraitPart(oldHash)
    ),
    bot = await seed(request, 'bot', `이전 인물 대화 ${Date.now()}`);
  const created = await request.post('/api/chats', {
    data: { title: '합성 고정 이미지 채팅', botId: bot.id },
  });
  expect(created.ok()).toBe(true);
  const chat = await created.json();
  const detail: ChatDetail = await (await request.get(`/api/chats/${chat.id}`)).json();
  const originalProfile = detail.profile!;
  const attached = await request.put(`/api/chats/${chat.id}/profile`, {
    data: {
      expectedRevision: originalProfile.revision,
      attachments: originalProfile.attachments,
      packageAttachments: [
        ...(originalProfile.packageAttachments ?? []),
        { id: persona.id, revision: persona.revision, role: 'persona' },
      ],

      image: originalProfile.image,
    },
  });
  expect(attached.ok(), await attached.text()).toBe(true);
  const changed = await request.put(`/api/content/${persona.id}`, {
    data: {
      kind: persona.kind,
      title: `${persona.title} 최신`,
      description: persona.description,
      text: persona.text,
      loading: persona.loading,
      relatedIds: [],
      package: { ...persona.package!, title: `${persona.title} 최신`, ...portraitPart(newHash) },
      expectedRevision: persona.revision,
    },
  });
  expect(changed.ok(), await changed.text()).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/?chat=${chat.id}`);
  await page.getByRole('button', { name: '입력창 더보기', exact: true }).click();
  const trigger = page.getByRole('button', { name: '빠른 페르소나', exact: true });
  await expect(trigger).toContainText(persona.title);
  await expect(trigger.locator('img')).toHaveAttribute(
    'src',
    `/api/package-image-blobs/${newHash}`
  );
  await trigger.click();
  const picker = page.getByRole('dialog', { name: '빠른 페르소나', exact: true });
  await picker.getByRole('searchbox').fill(persona.title);
  const current = picker
    .getByRole('button')
    .filter({ has: page.getByText(`${persona.title} 최신`, { exact: true }) });
  await expect(current).toHaveCount(1);
  await expect(current).toHaveAttribute('aria-pressed', 'true');
  await expect(current.locator('img')).toHaveAttribute(
    'src',
    `/api/package-image-blobs/${newHash}`
  );
  await expect(picker.getByText(persona.title, { exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  const after: ChatDetail = await (await request.get(`/api/chats/${chat.id}`)).json();
  expect(after.profile!.packageAttachments).toContainEqual({
    id: persona.id,
    revision: persona.revision + 1,
    role: 'persona',
  });
  expect(after.runs).toHaveLength(0);
});
