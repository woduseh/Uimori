import { test, expect } from '@playwright/test';
import type { Content, Library } from '../core/product.js';

test('PKUI04 hundreds of lore entries support folders, search, bulk move and persistent compact editing', async ({
  page,
  request,
}, info) => {
  test.setTimeout(60000);
  const pkg = {
    version: 1,
    id: 'many-lore',
    revision: 1,
    title: '폴더 관리 합성 자료',
    description: '',
    body: 'Synthetic world',
    loreFolders: [{ id: 'places', name: '장소' }],
    lore: Array.from({ length: 240 }, (_, index) => ({
      id: `lore-${index}`,
      title: `로어 항목 ${String(index).padStart(3, '0')}`,
      description: `설명 ${index}`,
      text: `합성 본문 ${index}`,
      loading: index % 2 ? 'pinned' : 'discoverable',
      ...(index < 120 ? { folderId: 'places' } : {}),
    })),
    instructions: [],
    controls: [],
    transforms: [],
  };
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page
    .getByRole('navigation', { name: '자료 탐색', exact: true })
    .getByRole('button', { name: '봇', exact: true })
    .click();
  const library = page.getByTestId('library-panel');
  await library.getByRole('button', { name: '새로 만들기', exact: true }).first().click();
  await library.getByText('패키지 가져오기·내보내기와 역할 사본', { exact: true }).click();
  await library.getByLabel('패키지 JSON 가져오기', { exact: true }).setInputFiles({
    name: 'many.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(pkg)),
  });
  await library.getByRole('button', { name: '가져온 패키지로 초안 바꾸기', exact: true }).click();
  const manager = library.locator('.lore-manager');
  await expect(manager.locator('.lore-row')).toHaveCount(50);
  await expect(manager.locator('textarea')).toHaveCount(1);
  expect(
    await manager
      .locator('.lore-search')
      .evaluate((element) => getComputedStyle(element).flexDirection)
  ).toBe('row');
  expect(
    await manager
      .locator('.lore-list-summary label')
      .evaluate((element) => getComputedStyle(element).flexDirection)
  ).toBe('row');
  await manager.getByRole('button', { name: '다음', exact: true }).click();
  await expect(manager.locator('.lore-row').first()).toContainText('로어 항목 050');
  await manager.getByLabel('로어 검색', { exact: true }).fill('합성 본문 239');
  await expect(manager.locator('.lore-row')).toHaveCount(1);
  await expect(manager.getByLabel('로어 240 본문', { exact: true })).toHaveValue('합성 본문 239');
  await manager.getByLabel('로어 240 본문', { exact: true }).fill('수정된 합성 본문 239');
  await manager.getByLabel('로어 검색', { exact: true }).fill('로어 항목 23');
  await manager
    .locator('.lore-row')
    .filter({ hasText: '로어 항목 239' })
    .getByRole('button')
    .click();
  await manager.getByLabel('로어 240 이름', { exact: true }).fill('검색에서 사라지는 이름');
  await expect(manager.getByLabel('로어 240 이름', { exact: true })).toHaveValue(
    '검색에서 사라지는 이름'
  );
  await expect(manager.getByLabel('로어 240 본문', { exact: true })).toHaveValue(
    '수정된 합성 본문 239'
  );
  await manager.getByLabel('로어 검색', { exact: true }).fill('');
  await manager.getByRole('button', { name: '폴더 추가', exact: true }).click();
  let dialog = manager.getByRole('dialog', { name: '로어 폴더 추가', exact: true });
  await dialog.getByLabel('폴더 이름', { exact: true }).fill('인물');
  await dialog.getByRole('button', { name: '폴더 만들기', exact: true }).click();
  await manager.getByLabel('로어 폴더 필터', { exact: true }).selectOption('places');
  await manager.getByLabel('현재 페이지 로어 모두 선택', { exact: true }).check();
  await manager.getByLabel('선택한 로어 이동', { exact: true }).selectOption({ label: '인물' });
  await expect(manager.getByRole('region', { name: '로어 목록', exact: true })).toContainText(
    '70개'
  );
  await manager.getByLabel('로어 폴더 필터', { exact: true }).selectOption({ label: '인물 · 50' });
  await manager.getByRole('button', { name: '폴더 관리', exact: true }).click();
  dialog = manager.getByRole('dialog', { name: '로어 폴더 관리', exact: true });
  await dialog.getByLabel('폴더 이름', { exact: true }).fill('등장인물');
  await dialog.getByRole('button', { name: '이름 저장', exact: true }).click();
  await manager.getByLabel('로어 사용 방법 필터', { exact: true }).selectOption('pinned');
  await expect(manager.locator('.lore-row')).toHaveCount(25);
  await manager.getByLabel('로어 사용 방법 필터', { exact: true }).selectOption('*');
  await manager.screenshot({ path: info.outputPath('lore-folders-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(manager.locator('textarea')).toHaveCount(1);
  const bounds = await manager.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true
  );
  await manager.locator('.lore-heading').scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('lore-folders-mobile.png') });
  await manager.locator('textarea').scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('lore-editor-mobile.png') });
  await library.getByRole('button', { name: '자료 등록', exact: true }).click();
  await expect(library.getByRole('status')).toContainText('v1 저장됨');
  const listing: Library = await (await request.get('/api/library')).json();
  const saved = listing.contents.find((row) => row.title === pkg.title)!;
  const content: Content = await (
    await request.get(`/api/revisions/content/${saved.id}/${saved.revision}`)
  ).json();
  expect(content.package!.lore).toHaveLength(240);
  expect(content.package!.lore[239].text).toBe('수정된 합성 본문 239');
  expect(content.package!.lore[239].title).toBe('검색에서 사라지는 이름');
  expect(content.package!.lore[230].title).toBe('로어 항목 230');
  const folderId = content.package!.loreFolders!.find((row) => row.name === '등장인물')!.id;
  expect(content.package!.lore.filter((row) => row.folderId === folderId)).toHaveLength(50);
  const downloadWait = page.waitForEvent('download');
  await library.getByRole('button', { name: '패키지 JSON 내보내기', exact: true }).click();
  const download = await downloadWait;
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  const exported = JSON.parse(Buffer.concat(chunks).toString());
  expect(exported.loreFolders).toEqual(content.package!.loreFolders);
  expect(exported.lore).toEqual(content.package!.lore);
  await manager.getByLabel('로어 폴더 필터', { exact: true }).selectOption(folderId);
  await manager.getByRole('button', { name: '폴더 관리', exact: true }).click();
  await manager.getByRole('button', { name: '폴더 삭제 · 로어 유지', exact: true }).click();
  await expect(manager.getByRole('region', { name: '로어 목록', exact: true })).toContainText(
    '170개'
  );
  await library.getByRole('button', { name: '새 revision 저장', exact: true }).click();
  await expect(library.getByRole('status')).toContainText('v2 저장됨');
  await library.getByRole('button', { name: '← 서재 목록', exact: true }).click();
  await library.getByRole('button', { name: `${pkg.title} 자료 편집`, exact: true }).click();
  await expect(manager.getByLabel('로어 폴더 필터', { exact: true })).toContainText('미분류 · 170');
  await expect(manager.getByLabel('로어 폴더 필터', { exact: true })).not.toContainText('등장인물');
});

test('PKUI03 native JSON import remains a reviewed persona draft and preserves long content on save', async ({
  page,
  request,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page
    .getByRole('navigation', { name: '자료 탐색', exact: true })
    .getByRole('button', { name: '봇', exact: true })
    .click();
  await expect(page.getByRole('button', { name: '자료 가져오기', exact: true })).toHaveCount(0);
  const library = page.getByTestId('library-panel');
  await library.getByRole('tab', { name: '페르소나', exact: true }).click();
  await library.getByRole('button', { name: '새로 만들기', exact: true }).first().click();
  await library.getByLabel('자료 이름', { exact: true }).fill('Unsaved native draft');
  await library.getByText('패키지 가져오기·내보내기와 역할 사본', { exact: true }).click();
  const transfers = library.locator('.library-package-tools');
  const cards = transfers.locator('.library-transfer-card');
  const desktopCards = await cards.evaluateAll((items) =>
    items.map((item) => ({
      top: item.getBoundingClientRect().top,
      bottom: item.getBoundingClientRect().bottom,
    }))
  );
  expect(desktopCards[0].top).toBe(desktopCards[1].top);
  expect(desktopCards[0].bottom).toBe(desktopCards[1].bottom);
  await transfers.screenshot({ path: info.outputPath('library-package-tools-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileCards = await cards.evaluateAll((items) =>
    items.map((item) => ({
      top: item.getBoundingClientRect().top,
      bottom: item.getBoundingClientRect().bottom,
      right: item.getBoundingClientRect().right,
    }))
  );
  expect(mobileCards[1].top).toBeGreaterThan(mobileCards[0].bottom);
  expect(mobileCards.every((item) => item.right <= 390)).toBe(true);
  await transfers.screenshot({ path: info.outputPath('library-package-tools-mobile.png') });
  await page.setViewportSize({ width: 1440, height: 1000 });
  const input = library.getByLabel('패키지 JSON 가져오기', { exact: true });
  await input.setInputFiles({
    name: 'invalid.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{"version":999}'),
  });
  await expect(library.getByLabel('자료 이름', { exact: true })).toHaveValue(
    'Unsaved native draft'
  );
  await expect(
    library.getByRole('button', { name: '가져온 패키지로 초안 바꾸기', exact: true })
  ).toHaveCount(0);
  const pkg = {
    version: 1,
    id: 'synthetic-native-persona',
    revision: 1,
    title: 'Synthetic imported persona',
    description: 'Native JSON import',
    body: 'Synthetic text. '.repeat(10000),
    lore: [],
    instructions: [],
    controls: [],
    transforms: [],
  };
  await input.setInputFiles({
    name: 'native.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(pkg)),
  });
  await expect(library.getByRole('button', { name: '자료 등록', exact: true })).toBeDisabled();
  await expect(library.getByLabel('자료 이름', { exact: true })).toHaveValue(
    'Unsaved native draft'
  );
  await library.getByRole('button', { name: '가져온 패키지로 초안 바꾸기', exact: true }).click();
  await expect(library.getByLabel('자료 종류', { exact: true })).toHaveValue('persona');
  const before: Library = await (await request.get('/api/library')).json();
  expect(before.contents.some((item) => item.title === pkg.title)).toBe(false);
  await library.getByRole('button', { name: '자료 등록', exact: true }).click();
  await expect(library.getByRole('status')).toContainText('v1 저장됨');
  const after: Library = await (await request.get('/api/library')).json();
  const saved = after.contents.find((item) => item.title === pkg.title)!;
  expect(saved.kind).toBe('persona');
  const content: Content = await (
    await request.get(`/api/revisions/content/${saved.id}/${saved.revision}`)
  ).json();
  expect(content.text).toBe(pkg.body);
  expect(content.package?.body).toBe(pkg.body);
  expect((await request.post('/api/imports/risu/inspect', { data: {} })).status()).toBe(404);
});

test('PKUI01 package editing preserves internal lore, instructions, unsaved work and cross-role copies', async ({
  page,
  request,
}, info) => {
  test.setTimeout(60000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page
    .getByRole('navigation', { name: '자료 탐색', exact: true })
    .getByRole('button', { name: '봇', exact: true })
    .click();
  const library = page.getByTestId('library-panel');
  await expect(library.getByRole('tab')).toHaveText([
    '봇',
    '페르소나',
    '모듈',
    '프롬프트',
    '기타 자료',
  ]);
  await library.getByRole('button', { name: '새로 만들기', exact: true }).first().click();
  await library.getByLabel('자료 이름', { exact: true }).fill('Synthetic package editor bot');
  await library.getByLabel('자료 본문', { exact: true }).fill('Synthetic common body.');
  const fields = library.getByRole('region', { name: '패키지 구성', exact: true });
  await fields.getByRole('button', { name: '로어 추가', exact: true }).click();
  await fields.getByLabel('로어 1 이름', { exact: true }).fill('Synthetic harbor');
  await fields
    .getByLabel('로어 1 본문', { exact: true })
    .fill('A blue bell hangs by the synthetic harbor.');
  await fields.getByLabel('사용 방법', { exact: true }).selectOption('pinned');
  await fields.getByRole('button', { name: '지침', exact: true }).click();
  await fields.getByRole('button', { name: '지침 추가', exact: true }).click();
  await fields
    .getByLabel('지침 1 본문', { exact: true })
    .fill('Mention visible actions before interpretation.');
  await library.getByRole('button', { name: '← 서재 목록', exact: true }).click();
  const guard = library.getByRole('alertdialog', { name: '미저장 자료 확인', exact: true });
  await expect(guard).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await guard.evaluate(
      (element) => element instanceof HTMLDialogElement && element.matches(':modal')
    )
  ).toBe(true);
  const bounds = await guard.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(16);
  expect(bounds!.width).toBeLessThanOrEqual(358);
  expect(bounds!.height).toBeLessThan(400);
  await expect(guard.getByRole('button', { name: '계속 편집', exact: true })).toBeFocused();
  await page.screenshot({ path: info.outputPath('library-unsaved-confirmation-mobile.png') });
  await page.keyboard.press('Escape');
  await expect(guard).toBeHidden();
  await expect(library.getByLabel('자료 이름', { exact: true })).toHaveValue(
    'Synthetic package editor bot'
  );
  await library.getByRole('button', { name: '← 서재 목록', exact: true }).click();
  await expect(guard).toBeVisible();
  await guard.getByRole('button', { name: '계속 편집', exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(fields.getByLabel('지침 1 본문', { exact: true })).toHaveValue(
    'Mention visible actions before interpretation.'
  );
  await fields.getByRole('button', { name: '지침 검증 후 적용', exact: true }).click();
  await library.getByRole('button', { name: '자료 등록', exact: true }).click();
  await expect(library.locator('.library-savebar [role="status"]')).toContainText('v1 저장됨');
  const listingResponse = await request.get('/api/library');
  expect(listingResponse.ok()).toBe(true);
  const listing: Library = await listingResponse.json();
  const summary = listing.contents.find((item) => item.title === 'Synthetic package editor bot')!;
  expect(summary).toBeTruthy();
  const fullResponse = await request.get(
    `/api/revisions/content/${summary.id}/${summary.revision}`
  );
  expect(fullResponse.ok()).toBe(true);
  const original: Content = await fullResponse.json();
  expect(original.package?.lore[0]).toMatchObject({
    title: 'Synthetic harbor',
    text: 'A blue bell hangs by the synthetic harbor.',
    loading: 'pinned',
  });
  expect(original.package?.instructions[0]).toMatchObject({
    target: 'main',
    text: 'Mention visible actions before interpretation.',
  });
  await library.getByRole('button', { name: '← 서재 목록', exact: true }).click();
  await library
    .getByRole('button', { name: 'Synthetic package editor bot 자료 편집', exact: true })
    .click();
  await expect(fields.getByLabel('로어 1 본문', { exact: true })).toHaveValue(
    'A blue bell hangs by the synthetic harbor.'
  );
  await fields.getByRole('button', { name: '지침', exact: true }).click();
  await expect(fields.getByLabel('지침 1 본문', { exact: true })).toHaveValue(
    'Mention visible actions before interpretation.'
  );
  await library.getByText('패키지 가져오기·내보내기와 역할 사본', { exact: true }).click();
  await library.getByRole('button', { name: '페르소나로 사본 만들기', exact: true }).click();
  await expect(library.getByLabel('자료 종류', { exact: true })).toHaveValue('persona');
  await expect(library.getByLabel('자료 이름', { exact: true })).toHaveValue(
    'Synthetic package editor bot 사본'
  );
  const afterResponse = await request.get('/api/library');
  const after: Library = await afterResponse.json();
  const copy = after.contents.find(
    (item) => item.kind === 'persona' && item.title === 'Synthetic package editor bot 사본'
  )!;
  expect(copy.id).not.toBe(original.id);
  const copyResponse = await request.get(`/api/revisions/content/${copy.id}/${copy.revision}`);
  const copied: Content = await copyResponse.json();
  expect(copied.package?.lore).toEqual(original.package?.lore);
  expect(copied.package?.instructions).toEqual(original.package?.instructions);
  expect(copied.package?.id).toBe(copy.id);
  const unchangedResponse = await request.get(
    `/api/revisions/content/${original.id}/${original.revision}`
  );
  expect(await unchangedResponse.json()).toEqual(original);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true
  );
  await page.screenshot({ path: info.outputPath('package-editor-mobile.png') });
  expect(errors).toEqual([]);
});

test('PKUI02 library exposes package roles and prompts with direct internal lore authoring', async ({
  page,
  request,
}, info) => {
  const title = `Synthetic current library ${Date.now()}`;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const menu = page.getByRole('button', { name: '탐색 메뉴', exact: true });
  if (await menu.isVisible()) await menu.click();
  await page
    .getByRole('navigation', { name: '자료 탐색', exact: true })
    .getByRole('button', { name: '봇', exact: true })
    .click();
  const library = page.getByTestId('library-panel');
  await expect(library.getByRole('tab')).toHaveText([
    '봇',
    '페르소나',
    '모듈',
    '프롬프트',
    '기타 자료',
  ]);
  await expect(library.getByText('이전 자료', { exact: true })).toHaveCount(0);
  for (const name of ['로어', '창작 프리셋', '작가 설정', '창작 스킬', '명칭집'])
    await expect(library.getByRole('button', { name, exact: true })).toHaveCount(0);
  await library.getByRole('tab', { name: '프롬프트', exact: true }).click();
  await expect(library.getByTestId('prompt-editor')).toBeVisible();
  await library.getByRole('tab', { name: '봇', exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true
  );
  await page.screenshot({ path: info.outputPath('package-library-mobile.png') });
  await library.getByRole('button', { name: '새로 만들기', exact: true }).first().click();
  await expect(library.getByLabel('자료 종류', { exact: true }).locator('option')).toHaveText([
    '봇',
    '페르소나',
    '모듈',
    '로어',
    '작가 설정',
    '창작 스킬',
    '명칭집',
  ]);
  await expect(library.getByLabel('관련 자료 검색', { exact: true })).toHaveCount(0);
  await library.getByLabel('자료 이름', { exact: true }).fill(title);
  const fields = library.getByRole('region', { name: '패키지 구성', exact: true });
  await expect(fields.getByText('이전 자료에서 가져오기', { exact: true })).toHaveCount(0);
  await fields.getByRole('button', { name: '로어 추가', exact: true }).click();
  await fields.getByLabel('로어 1 이름', { exact: true }).fill('Direct authored lore');
  await fields.getByLabel('로어 1 본문', { exact: true }).fill('Synthetic direct lore text');
  await fields.getByRole('button', { name: '지침', exact: true }).click();
  await fields.getByRole('button', { name: '지침 추가', exact: true }).click();
  await fields.getByLabel('지침 1 본문', { exact: true }).fill('Synthetic package instruction');
  await fields.getByRole('button', { name: '지침 검증 후 적용', exact: true }).click();
  await library.getByRole('button', { name: '자료 등록', exact: true }).click();
  await expect(library.locator('.library-savebar [role="status"]')).toContainText('v1 저장됨');
  const listing: Library = await (await request.get('/api/library')).json();
  const item = listing.contents.find((item) => item.title === title)!;
  expect(item).toBeTruthy();
  const saved: Content = await (
    await request.get(`/api/revisions/content/${item.id}/${item.revision}`)
  ).json();
  expect(saved.package?.lore[0].text).toBe('Synthetic direct lore text');
  expect(saved.package?.instructions[0].text).toBe('Synthetic package instruction');
  expect(saved.relatedIds).toEqual([]);
});
