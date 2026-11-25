import { MOBILE_WIDTH, DESKTOP_WIDTH } from './fixtures/browser-viewports.js';
import { visualReview } from './fixtures/visual-review.js';
import { expect, test, type APIRequestContext } from '@playwright/test';
import type { Content } from '../core/product.js';

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

test('LCOM05 opening a bot from a scrolled mobile list starts its editor at the top', async ({
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
  const open = panel.getByRole('button', { name: `${last.title} 편집`, exact: true });
  await open.click({ trial: true });
  const scrollport = page.locator('.destination-scroll');
  expect(await scrollport.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  await open.click();
  const detail = panel.getByRole('region', { name: '자료 상세', exact: true });
  const title = detail.getByLabel('봇 이름', { exact: true });
  await expect(title).toHaveValue(last.title);
  expect(await scrollport.evaluate((node) => node.scrollTop)).toBe(0);
  await expect(title).toBeInViewport();
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
  await panel.getByRole('button', { name: '9:16 카드 비율', exact: true }).click();
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
});
