import { MOBILE_WIDTH, DESKTOP_WIDTH, DEFAULT_WIDTHS } from './fixtures/browser-viewports.js';
import { reviewWidths, visualReview } from './fixtures/visual-review.js';
import { nativeContent } from './fixtures/native-content.js';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { Content, Library } from '../core/product.js';
import type { PackageImage } from '../core/package-images.js';
import type { LibraryOrganization } from '../core/library-organization.js';

async function seed(
  request: APIRequestContext,
  title: string,
  kind: Content['kind'] = 'bot',
  pkg?: Content['package']
) {
  const response = await request.post('/api/content', {
    data: {
      kind,
      title,
      description:
        pkg?.description ??
        '긴 한글 이름과 설명을 가진 합성 자료예요. 전체 소개는 상세에서 확인해요.',
      text: pkg?.body ?? 'Synthetic local content for compact UI verification.',
      loading: 'pinned',
      relatedIds: [],
      package: pkg,
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

test('LCOM05 opening a bot from a scrolled mobile list starts its detail at the top', async ({
  page,
  request,
}) => {
  const prefix = `LCOM05 ${Date.now()}`;
  const items = await Promise.all(
    Array.from({ length: 18 }, (_, index) =>
      seed(request, `${prefix} ${String(index).padStart(2, '0')}`)
    )
  );
  await page.setViewportSize({ width: MOBILE_WIDTH, height: 760 });
  await page.goto('/');
  const panel = page.getByTestId('library-panel');
  await panel.getByLabel('서재 검색', { exact: true }).fill(prefix);
  await panel.getByRole('button', { name: '목록', exact: true }).click();
  const last = items.at(-1)!;
  const open = panel.getByRole('button', { name: `${last.title} 상세 보기`, exact: true });
  await open.click({ trial: true });
  const scrollport = page.locator('.destination-scroll');
  expect(await scrollport.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  await open.click();
  const detail = panel.getByRole('region', { name: '자료 상세', exact: true });
  await expect(detail.locator('.library-detail-title > h2')).toHaveText(last.title);
  expect(await scrollport.evaluate((node) => node.scrollTop)).toBe(0);
  await expect(detail.locator('.library-detail-title')).toBeInViewport();
});

test('LCOM01 compact library keeps row actions aligned across mobile and desktop widths', async ({
  page,
  request,
}, info) => {
  const stamp = `LCOM01 ${Date.now()}`;
  const item = await seed(request, `${stamp} 아주 긴 한글 이름의 여행 안내자`);
  await page.goto('/');
  const panel = page.getByTestId('library-panel');
  await panel.getByRole('searchbox', { name: '서재 검색', exact: true }).fill(stamp);
  await panel.getByRole('button', { name: '목록', exact: true }).click();
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
  await page.setViewportSize({ width: MOBILE_WIDTH, height: 900 });
  await panel.getByRole('searchbox').fill('');
  if (visualReview) {
    const folders = panel.locator('.library-folder-section');
    if (await folders.count()) {
      const section = (await folders.boundingBox())!;
      expect((await panel.locator('.library-list-item').first().boundingBox())!.y).toBeGreaterThan(
        section.y + section.height
      );
    } else
      expect((await panel.locator('.library-list-item').first().boundingBox())!.y).toBeLessThan(
        245
      );
  }
});

test('LCOM04 mobile cards keep image-less characters compact and portrait cards intact', async ({
  page,
  request,
}, info) => {
  const stamp = `LCOM04 ${Date.now()}`;
  const bot = await seed(request, `${stamp} 골목 서점의 주인 하윤과 비 오는 날에만 문을 여는 서점`);
  const persona = await seed(
    request,
    `${stamp} 오래된 이야기를 모으러 골목을 찾아온 여행자 소윤`,
    'persona'
  );
  const image = await request.post('/api/package-image-blobs', {
    data: {
      mime: 'image/png',
      base64:
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWNIK1/1HwAFVQKH+f6iOwAAAABJRU5ErkJggg==',
    },
  });
  expect(image.ok(), await image.text()).toBe(true);
  const { hash, mime } = (await image.json()) as { hash: string; mime: PackageImage['mime'] };
  const title = `${stamp} 대표 이미지가 있는 봇`;
  const portrait = await seed(
    request,
    title,
    'bot',
    nativeContent(
      { name: title },
      {
        images: [
          {
            id: 'portrait',
            title: '합성 이미지',
            description: '',
            blobHash: hash,
            mime,
            allowedUse: 'profile',
          },
        ],
        portraitImageId: 'portrait',
      }
    )
  );
  await page.setViewportSize({ width: 412, height: 900 });
  await page.goto('/');
  const panel = page.getByTestId('library-panel');
  for (const item of [bot, persona]) {
    await panel
      .getByRole('tab', { name: item.kind === 'bot' ? '봇' : '페르소나', exact: true })
      .click();
    await panel.getByRole('searchbox', { name: '서재 검색', exact: true }).fill(stamp);
    await panel.getByRole('button', { name: '카드', exact: true }).click();
    const card = panel.locator(`[data-library-item-id="${item.id}"]`);
    for (const width of [360, 412]) {
      await page.setViewportSize({ width, height: 900 });
      const avatar = (await card.locator('.library-item-avatar').boundingBox())!;
      const copy = (await card.locator('.library-item-copy').boundingBox())!;
      expect(avatar.width).toBeLessThanOrEqual(44);
      expect(avatar.height).toBeLessThanOrEqual(44);
      expect(copy.x).toBeGreaterThanOrEqual(avatar.x + avatar.width);
      expect((await card.boundingBox())!.height).toBeLessThan(200);
      await expect(card.locator('strong')).toHaveText(item.title);
      await expectTouchTarget(card.getByLabel(`${item.title} 메뉴`, { exact: true }));
      if (item.kind === 'bot') {
        const chat = card.getByRole('button', { name: `${item.title} 새 채팅`, exact: true });
        await expect(chat.locator('span')).toBeVisible();
        await expectTouchTarget(chat);
        const portraitAvatar = panel.locator(
          `[data-library-item-id="${portrait.id}"] .library-item-avatar`
        );
        await expect(portraitAvatar.locator('img')).toHaveAttribute(
          'src',
          `/api/package-image-blobs/${hash}`
        );
        expect((await portraitAvatar.boundingBox())!.height).toBeGreaterThan(200);
      }
      await expectNoOverflow(page);
      if (visualReview)
        await page.screenshot({ path: info.outputPath(`library-text-${item.kind}-${width}.png`) });
    }
    await card.getByLabel(`${item.title} 메뉴`, { exact: true }).click();
    await expect(card.getByRole('button', { name: '편집', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    const options = panel.getByLabel('목록 관리', { exact: true });
    await options.click();
    await panel.getByRole('button', { name: '선택', exact: true }).click();
    await card.getByRole('button', { name: `${item.title} 선택`, exact: true }).click();
    await expect(
      card.getByRole('checkbox', { name: `${item.title} 선택`, exact: true })
    ).toBeChecked();
    await expectNoOverflow(page);
    await panel.getByRole('button', { name: '완료', exact: true }).click();
    if (item.kind === 'bot') {
      await card.getByRole('button', { name: `${item.title} 새 채팅`, exact: true }).click();
      await expect(page.getByRole('dialog', { name: '새 채팅', exact: true })).toBeVisible();
      await page.keyboard.press('Escape');
    }
  }
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
    await route.fulfill({
      response,
      json: {
        ...library,
        contents: [],
        organization: { ...library.organization, folders: [], items: [] },
      },
    });
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
  await panel.getByRole('button', { name: `${folder.title} 폴더 열기`, exact: true }).click();
  await expect(
    panel.getByRole('heading', { name: '이 폴더는 비어 있어요', exact: true })
  ).toBeVisible();
  await expect(panel.getByRole('searchbox', { name: '서재 검색', exact: true })).toBeVisible();
  await expect(panel.getByLabel('목록 관리', { exact: true })).toBeVisible();
  for (const width of DEFAULT_WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    const back = await panel.getByRole('button', { name: '전체 보기', exact: true }).boundingBox();
    const create = await panel
      .getByRole('button', { name: '모듈 만들기', exact: true })
      .boundingBox();
    expect(back).not.toBeNull();
    expect(create).not.toBeNull();
    expect(Math.abs(back!.height - create!.height)).toBeLessThanOrEqual(1);
    if (Math.abs(back!.y - create!.y) < 10)
      expect(Math.abs(back!.y - create!.y)).toBeLessThanOrEqual(1);
    await expectNoOverflow(page);
    if (visualReview)
      await page.screenshot({ path: info.outputPath(`library-empty-folder-${width}.png`) });
  }
  await panel.getByRole('button', { name: '전체 보기', exact: true }).click();
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

test('LCOM03 selection replaces list tools and retains search, view and card ratio', async ({
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
  const views = panel.getByRole('group', { name: '자료 보기', exact: true });
  await expect(views).toBeVisible();
  await expect(views.getByRole('button', { name: '카드', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await expect(views.getByRole('button', { name: '카드', exact: true })).toHaveAttribute(
    'title',
    '카드 보기'
  );
  await expect(views.getByRole('button', { name: '목록', exact: true })).toHaveAttribute(
    'title',
    '목록 보기'
  );
  await options.click();
  const ratioOptions = panel.getByRole('group', { name: '카드 비율', exact: true });
  await expect(ratioOptions).toBeVisible();
  await expect(ratioOptions.getByRole('button')).toHaveText(['1:1', '2:3', '3:4', '9:16']);
  await expect(panel.getByRole('button', { name: '1:1 카드 비율', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await options.press('Escape');
  const listView = views.getByRole('button', { name: '목록', exact: true });
  await listView.focus();
  await listView.press('Enter');
  await expect(listView).toBeFocused();
  await expect(listView).toHaveAttribute('aria-pressed', 'true');
  await options.click();
  await expect(panel.getByRole('group', { name: '카드 비율', exact: true })).toHaveCount(0);
  await options.press('Escape');
  await page.reload();
  await search.fill(title);
  await expect(panel.locator('.library-list-item')).toHaveCount(1);
  await options.click();
  await panel.getByRole('button', { name: '선택', exact: true }).click();
  await expect(search).toHaveCount(0);
  await expect(options).toHaveCount(0);
  await expect(views).toHaveCount(0);
  await expect(panel.getByRole('button', { name: '완료', exact: true })).toBeFocused();
  await panel.getByRole('checkbox', { name: `${item.title} 선택`, exact: true }).check();
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
  await expect(
    panel.getByRole('checkbox', { name: `${item.title} 선택`, exact: true })
  ).toBeChecked();
  await expect(panel.getByRole('group', { name: '자료 선택 작업', exact: true })).toContainText(
    '1개 선택'
  );
  if (visualReview)
    await page.screenshot({ path: info.outputPath('library-compact-selection.png') });
  await panel.getByRole('button', { name: '완료', exact: true }).click();
  await expect(search).toHaveValue(title);
  await expect(options).toBeFocused();
  await panel.getByRole('button', { name: '카드', exact: true }).click();
  await options.press('Enter');
  for (const [ratio, expected] of [
    ['1:1', 1],
    ['2:3', 2 / 3],
    ['3:4', 3 / 4],
    ['9:16', 9 / 16],
  ] as const) {
    await panel.getByRole('button', { name: `${ratio} 카드 비율`, exact: true }).click();
    await expect
      .poll(() =>
        panel.locator('.library-item-avatar').evaluate((node) => {
          const box = node.getBoundingClientRect();
          return box.width / box.height;
        })
      )
      .toBeCloseTo(expected, 2);
  }
  await expect(panel.locator('.library-portrait-cards')).toHaveAttribute('data-card-ratio', '9:16');
  await options.press('Escape');
  await expect(options).toBeFocused();
  await expect(panel.locator('.library-list-options')).not.toHaveAttribute('open');
  await page.reload();
  await search.fill(title);
  await expect(panel.locator('.library-portrait-card')).toHaveCount(1);
  await expect(panel.locator('.library-portrait-cards')).toHaveAttribute('data-card-ratio', '9:16');
  await options.click();
  await expect(panel.getByRole('button', { name: '9:16 카드 비율', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  if (visualReview)
    await page.screenshot({ path: info.outputPath('library-card-ratio-options.png') });
  await options.press('Escape');
  await page.setViewportSize({ width: MOBILE_WIDTH, height: 800 });
  await expect(panel.locator('.library-portrait-card')).toHaveCount(1);
  expect(
    await panel
      .locator('.library-portrait-cards')
      .evaluate(
        (node) => getComputedStyle(node).gridTemplateColumns.split(' ').filter(Boolean).length
      )
  ).toBe(2);
  await expectNoOverflow(page);
  if (visualReview)
    await page.screenshot({ path: info.outputPath('library-card-ratio-9-16-mobile.png') });
});
