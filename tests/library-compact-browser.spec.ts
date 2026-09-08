import { reviewWidths, visualReview } from './fixtures/visual-review.js';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { Content, Library } from '../core/product.js';
import type { LibraryOrganization } from '../core/library-organization.js';

async function seed(request: APIRequestContext, title: string, kind: Content['kind'] = 'bot') {
  const response = await request.post('/api/content', {
    data: {
      kind,
      title,
      description: '긴 한글 이름과 설명을 가진 합성 자료예요. 전체 소개는 상세에서 확인해요.',
      text: 'Synthetic local content for compact UI verification.',
      loading: 'pinned',
      relatedIds: [],
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<Content>;
}

async function expectNoOverflow(page: Page) {
  const overflow = await page.evaluate(() => ({
    page: document.documentElement.scrollWidth - window.innerWidth,
    panel: (() => {
      const panel = document.querySelector<HTMLElement>('[data-testid="library-panel"]')!;
      return panel.scrollWidth - panel.clientWidth;
    })(),
  }));
  expect(overflow.page).toBeLessThanOrEqual(1);
  expect(overflow.panel).toBeLessThanOrEqual(1);
}

async function expectTouchTarget(locator: Locator) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThanOrEqual(44);
  expect(box!.height).toBeGreaterThanOrEqual(44);
}

test('LCOM01 compact library keeps row actions aligned across mobile and desktop widths', async ({
  page,
  request,
}, info) => {
  const stamp = `LCOM01 ${Date.now()}`;
  const item = await seed(request, `${stamp} 아주 긴 한글 이름의 여행 안내자`);
  await page.goto('/');
  const panel = page.getByTestId('library-panel');
  await panel.getByRole('searchbox', { name: '서재 검색', exact: true }).fill(stamp);
  for (const width of reviewWidths([360, 390, 430, 768, 1024, 1440])) {
    await page.setViewportSize({ width, height: 900 });
    const row = panel.locator('.library-list-item');
    await expect(row).toHaveCount(1);
    const open = row.getByRole('button', { name: `${item.title} 상세 보기`, exact: true });
    const chat = row.getByRole('button', { name: `${item.title} 새 채팅`, exact: true });
    const menu = row.getByLabel(`${item.title} 메뉴`, { exact: true });
    await expect(open).toBeInViewport();
    await expectTouchTarget(chat);
    await expectTouchTarget(menu);
    await expectTouchTarget(panel.getByLabel('목록 관리', { exact: true }));
    if (visualReview) {
      const boxes = await Promise.all([open.boundingBox(), chat.boundingBox(), menu.boundingBox()]);
      const centers = boxes.map((box) => box!.y + box!.height / 2);
      expect(Math.max(...centers) - Math.min(...centers)).toBeLessThanOrEqual(1);
      const input = await panel.getByRole('searchbox').boundingBox();
      const icon = await panel.locator('.library-search-field > svg').boundingBox();
      expect(Math.abs(input!.y + input!.height / 2 - icon!.y - icon!.height / 2)).toBeLessThan(1);
    }
    if (width <= 760) {
      await expect(panel.locator('.library-folder-list')).toBeHidden();
      if (visualReview) expect((await row.boundingBox())!.y).toBeLessThan(285);
    }
    await expectNoOverflow(page);
    if (visualReview)
      await page.screenshot({ path: info.outputPath(`library-compact-${width}.png`) });
  }
  await page.setViewportSize({ width: 390, height: 900 });
  await panel.getByRole('searchbox').fill('');
  if (visualReview)
    expect((await panel.locator('.library-list-item').first().boundingBox())!.y).toBeLessThan(245);
});

test('LCOM02 empty categories hide unused tools while empty folders and searches retain recovery', async ({
  page,
  request,
}, info) => {
  const title = `LCOM02 ${Date.now()}`;
  const item = await seed(request, title, 'module');
  await page.route('**/api/library?view=summary', async (route) => {
    const response = await route.fetch();
    const library = (await response.json()) as Library;
    await route.fulfill({ response, json: { ...library, contents: [] } });
  });
  await page.goto('/');
  const panel = page.getByTestId('library-panel');
  await panel.getByRole('tab', { name: '모듈', exact: true }).click();
  await expect(panel.getByRole('heading', { name: '새 모듈 만들기', exact: true })).toBeVisible();
  await expect(panel.getByRole('searchbox', { name: '서재 검색', exact: true })).toHaveCount(0);
  await expect(panel.getByLabel('목록 관리', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '새로 만들기', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: '모듈 만들기', exact: true })).toBeInViewport();
  if (visualReview) await page.screenshot({ path: info.outputPath('library-compact-empty.png') });

  await page.unroute('**/api/library?view=summary');
  const before = (await (
    await request.get('/api/library/organization')
  ).json()) as LibraryOrganization;
  const response = await request.post('/api/library/folders', {
    data: { expectedRevision: before.revision, category: 'module', title: `${title} 빈 폴더` },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const updated = (await response.json()) as LibraryOrganization;
  const folder = updated.folders.find((entry) => entry.title === `${title} 빈 폴더`)!;
  await page.reload();
  await panel.getByRole('tab', { name: '모듈', exact: true }).click();
  await panel.getByRole('combobox', { name: '폴더 선택', exact: true }).selectOption(folder.id);
  await expect(
    panel.getByRole('heading', { name: '이 폴더는 비어 있어요', exact: true })
  ).toBeVisible();
  await expect(panel.getByRole('searchbox', { name: '서재 검색', exact: true })).toBeVisible();
  await expect(panel.getByLabel('목록 관리', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: '이 탭 전체에서 찾기', exact: true }).click();
  const search = panel.getByRole('searchbox', { name: '서재 검색', exact: true });
  await search.fill(`${title} 없는 자료`);
  await expect(
    panel.getByRole('heading', { name: '찾는 자료가 없어요', exact: true })
  ).toBeVisible();
  await expect(search).toHaveValue(`${title} 없는 자료`);
  await panel.getByRole('button', { name: '검색 지우기', exact: true }).click();
  await expect(search).toHaveValue('');
  await expect(
    panel.getByRole('button', { name: `${item.title} 상세 보기`, exact: true })
  ).toBeVisible();
  await expectNoOverflow(page);
});

test('LCOM03 selection replaces list tools and retains search and saved view across resizing', async ({
  page,
  request,
}, info) => {
  const title = `LCOM03 ${Date.now()}`;
  const item = await seed(request, title);
  await page.goto('/');
  const panel = page.getByTestId('library-panel');
  const search = panel.getByRole('searchbox', { name: '서재 검색', exact: true });
  await search.fill(title);
  const options = panel.getByLabel('목록 관리', { exact: true });
  await options.click();
  await panel.getByRole('button', { name: '선택', exact: true }).click();
  await expect(search).toHaveCount(0);
  await expect(options).toHaveCount(0);
  await expect(panel.getByRole('button', { name: '선택 취소', exact: true })).toBeFocused();
  await panel.getByLabel(`${item.title} 선택`, { exact: true }).check();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(panel.getByLabel(`${item.title} 선택`, { exact: true })).toBeChecked();
  await expect(panel.getByRole('group', { name: '자료 선택 작업', exact: true })).toContainText(
    '1개 선택'
  );
  if (visualReview)
    await page.screenshot({ path: info.outputPath('library-compact-selection.png') });
  await panel.getByRole('button', { name: '선택 취소', exact: true }).click();
  await expect(search).toHaveValue(title);
  await expect(options).toBeFocused();
  await options.press('Enter');
  await panel.getByRole('button', { name: '카드', exact: true }).click();
  await options.press('Escape');
  await expect(options).toBeFocused();
  await expect(panel.locator('.library-list-options')).not.toHaveAttribute('open');
  await page.reload();
  await search.fill(title);
  await expect(panel.locator('.library-portrait-card')).toHaveCount(1);
  await page.setViewportSize({ width: 390, height: 800 });
  await expect(panel.locator('.library-portrait-card')).toHaveCount(1);
  await expectNoOverflow(page);
});
