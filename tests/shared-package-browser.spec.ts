import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import type { Content, Library } from '../core/product.js';
import type { ChatDetail } from '../core/types.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG1sAAAAASUVORK5CYII=',
  'base64'
);
async function libraryFor(page: Page, role: '페르소나' | '모듈') {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page
    .getByRole('navigation', { name: '자료 탐색', exact: true })
    .getByRole('button', { name: '봇', exact: true })
    .click();
  const library = page.getByTestId('library-panel');
  await library.getByRole('tab', { name: role, exact: true }).click();
  return library;
}
async function savedContent(request: APIRequestContext, title: string) {
  const listing: Library = await (await request.get('/api/library')).json();
  const summary = listing.contents.find((item) => item.title === title)!;
  expect(summary).toBeDefined();
  return (await (
    await request.get(`/api/revisions/content/${summary.id}/${summary.revision}`)
  ).json()) as Content;
}

test('shared persona draft uploads an image and starts as a bot with an exact authored opening and no automatic model jobs', async ({
  page,
  request,
}, info) => {
  test.setTimeout(60000);
  const title = `Shared authored persona ${info.workerIndex}`,
    text = 'The ego sword woke beside the window.\n\n“Good morning,” it said.';
  const pkg = {
    version: 1,
    id: 'shared-persona-draft',
    revision: 1,
    title,
    description: 'Synthetic reusable character',
    body: 'An ego sword with a voice.',
    lore: [],
    instructions: [],
    controls: [],
    transforms: [],
  };
  let chatPosts = 0;
  page.on('request', (item) => {
    if (item.method() === 'POST' && /\/api\/chats$/.test(item.url())) chatPosts++;
  });
  const library = await libraryFor(page, '페르소나');
  await library.getByRole('button', { name: '새로 만들기', exact: true }).first().click();
  await library.getByText('패키지 가져오기·내보내기와 역할 사본', { exact: true }).click();
  await library.getByLabel('패키지 JSON 가져오기', { exact: true }).setInputFiles({
    name: 'persona.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(pkg)),
  });
  await library.getByRole('button', { name: '가져온 패키지로 초안 바꾸기', exact: true }).click();
  const tabs = library.getByRole('group', { name: '패키지 편집 분류', exact: true });
  await tabs.getByRole('button', { name: '이미지', exact: true }).click();
  const images = library.getByRole('region', { name: '자료 이미지', exact: true });
  await images
    .getByLabel('자료 이미지 파일 추가', { exact: true })
    .setInputFiles({ name: 'sword-smile.png', mimeType: 'image/png', buffer: png });
  await expect(images.getByRole('status')).toContainText('1개 이미지를 자료에 추가했어요');
  await images.getByLabel('선택한 이미지 이름', { exact: true }).fill('창가의 검');
  await images.getByLabel('자료의 대표 이미지로 사용', { exact: true }).check();
  await images.screenshot({ path: info.outputPath('shared-persona-images-desktop.png') });
  await tabs.getByRole('button', { name: '시작', exact: true }).click();
  await library.locator('.package-start-editor > summary').click();
  await library.getByRole('button', { name: '시작 추가', exact: true }).click();
  await library.getByLabel('시작 이름', { exact: true }).fill('창가의 아침');
  await library.getByLabel('시작 방식', { exact: true }).selectOption('authored');
  await library.getByLabel('시작 본문', { exact: true }).fill(text);
  expect(chatPosts).toBe(0);
  await library.getByRole('button', { name: '자료 등록', exact: true }).click();
  await expect(library.getByText(`${title} · v1 저장됨`, { exact: true })).toBeVisible();
  const saved = await savedContent(request, title);
  expect(saved.kind).toBe('persona');
  expect(saved.package!.portraitImageId).toBe(saved.package!.images![0].id);
  const chats = await (await request.get('/api/chats')).json();
  expect(chats.filter((chat: any) => chat.botId === saved.id)).toHaveLength(0);
  await library.getByRole('button', { name: '이 자료를 봇으로 시작', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '새 채팅', exact: true });
  await dialog
    .getByLabel('사용할 시작', { exact: true })
    .selectOption(saved.package!.starts![0].id);
  await expect(dialog.getByLabel('시작 미리보기', { exact: true })).toHaveText(text);
  expect(chatPosts).toBe(0);
  const created = page.waitForResponse(
    (response) => response.request().method() === 'POST' && /\/api\/chats$/.test(response.url())
  );
  await dialog.getByRole('button', { name: '도입문 확정하고 채팅 만들기', exact: true }).click();
  const chat = await (await created).json();
  await expect(page.getByTestId('authored-start')).toContainText('작성된 도입문 · 창가의 아침');
  const detail: ChatDetail = await (await request.get(`/api/chats/${chat.id}`)).json();
  expect(detail.sources).toHaveLength(1);
  expect(detail.sources[0].text).toBe(text);
  expect(detail.attempts).toEqual([]);
  expect(detail.jobs).toEqual([]);
  expect(detail.runs[0].snapshot.packageStart).toMatchObject({
    mode: 'authored',
    packageId: saved.id,
    packageRevision: 1,
  });
  expect((await savedContent(request, title)).kind).toBe('persona');
  expect(chatPosts).toBe(1);
  const source = page.getByTestId('source').filter({ has: page.getByTestId('authored-start') });
  await source.getByRole('button', { name: '이미지 선택', exact: true }).click();
  await expect
    .poll(async () => {
      const current: ChatDetail = await (await request.get(`/api/chats/${chat.id}`)).json();
      return current.jobs.find((job) => job.kind === 'image')?.status;
    })
    .toBe('completed');
  const after: ChatDetail = await (await request.get(`/api/chats/${chat.id}`)).json();
  expect(after.sources[0].text).toBe(text);
  expect(after.jobs.some((job) => job.kind === 'translation')).toBe(false);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId('authored-start')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true
  );
  await page.screenshot({ path: info.outputPath('shared-authored-reader-mobile.png') });
});

test('shared package image editing pages large lists and preserves old revisions and a portable image bundle', async ({
  page,
  request,
}, info) => {
  test.setTimeout(60000);
  const blobResponse = await request.post('/api/package-image-blobs', {
    data: { mime: 'image/png', base64: png.toString('base64') },
  });
  expect(blobResponse.ok()).toBe(true);
  const blob = await blobResponse.json();
  const title = `Shared image library ${info.workerIndex}`;
  const pkg = {
    version: 1,
    id: 'image-library',
    revision: 1,
    title,
    description: 'Synthetic catalog',
    body: 'Reusable images.',
    lore: [],
    instructions: [],
    controls: [],
    transforms: [],
    images: Array.from({ length: 60 }, (_, i) => ({
      id: `image-${i}`,
      title: `이미지 ${String(i).padStart(2, '0')}`,
      description: '',
      blobHash: blob.hash,
      mime: blob.mime,
      allowedUse: 'both',
    })),
  };
  const response = await request.post('/api/content', {
    data: {
      kind: 'module',
      title,
      description: pkg.description,
      text: pkg.body,
      loading: 'pinned',
      relatedIds: [],
      package: pkg,
    },
  });
  expect(response.ok()).toBe(true);
  const first: Content = await response.json();
  const library = await libraryFor(page, '모듈');
  await library.getByRole('button', { name: `${title} 자료 편집`, exact: true }).click();
  await library
    .getByRole('group', { name: '패키지 편집 분류', exact: true })
    .getByRole('button', { name: '이미지', exact: true })
    .click();
  const images = library.getByRole('region', { name: '자료 이미지', exact: true });
  await expect(images.getByRole('listitem')).toHaveCount(50);
  await images.getByRole('button', { name: '다음', exact: true }).click();
  await expect(images.getByRole('listitem')).toHaveCount(10);
  await images.getByRole('button', { name: '이전', exact: true }).click();
  await images.getByRole('listitem').first().getByRole('button').click();
  await images.getByLabel('선택한 이미지 이름', { exact: true }).fill('새 이미지 이름');
  await images.getByLabel('선택한 이미지 설명', { exact: true }).fill('창가에서 기다리는 검');
  await images.getByRole('listitem').nth(1).getByRole('button').click();
  await images.getByRole('button', { name: '이 자료에서 이미지 제거', exact: true }).click();
  await expect(images.getByRole('alertdialog')).toContainText('과거 장면');
  await images.getByRole('button', { name: '이미지 참조 제거', exact: true }).click();
  await library.getByRole('button', { name: '새 revision 저장', exact: true }).click();
  await expect(library.getByText(`${title} · v2 저장됨`, { exact: true })).toBeVisible();
  const second = await savedContent(request, title);
  expect(second.package!.images).toHaveLength(59);
  expect(second.package!.images![0]).toMatchObject({
    title: '새 이미지 이름',
    description: '창가에서 기다리는 검',
  });
  const old: Content = await (await request.get(`/api/revisions/content/${first.id}/1`)).json();
  expect(old.package!.images).toEqual(first.package!.images);
  await images.getByRole('listitem').first().getByRole('button').click();
  await images.screenshot({ path: info.outputPath('shared-image-editor-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await images.scrollIntoViewIfNeeded();
  const bounds = await images.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true
  );
  await page.screenshot({ path: info.outputPath('shared-image-editor-mobile.png') });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await library.getByText('패키지 가져오기·내보내기와 역할 사본', { exact: true }).click();
  const downloadWait = page.waitForEvent('download');
  await library.getByRole('button', { name: '패키지 JSON 내보내기', exact: true }).click();
  const download = await downloadWait,
    stream = await download.createReadStream(),
    chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  const bundle = JSON.parse(Buffer.concat(chunks).toString());
  expect(bundle.format).toBe('uimori-package-bundle');
  expect(bundle.package.images).toEqual(second.package!.images);
  expect(bundle.images).toHaveLength(1);
  expect(bundle.images[0]).toMatchObject({ hash: blob.hash, base64: png.toString('base64') });
});
