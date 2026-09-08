import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { Content } from '../core/product.js';

const sectionNames = [
  '로어',
  '이미지',
  '시작',
  '지침',
  '옵션',
  '연결과 기능',
  '표현',
  '역할별 지침',
  '상태와 행동',
];

async function seed(request: APIRequestContext, title: string) {
  const response = await request.post('/api/content', {
    data: {
      kind: 'bot',
      title,
      description: '패키지 분야 탐색을 확인하는 합성 자료예요.',
      text: 'Synthetic package navigation.',
      loading: 'pinned',
      relatedIds: [],
      package: {
        version: 1,
        id: 'package-navigation',
        revision: 1,
        title,
        description: '',
        body: 'Synthetic package navigation.',
        lore: [
          {
            id: 'morning',
            title: '아침 항구',
            description: '',
            text: '밝은 바다',
            loading: 'pinned',
          },
          {
            id: 'stars',
            title: '별빛 항구',
            description: '',
            text: '별빛 아래의 합성 항구',
            loading: 'discoverable',
          },
        ],
        instructions: [],
        controls: [],
        transforms: [],
      },
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<Content>;
}

async function openEditor(page: Page, title: string) {
  await page.goto('/');
  const library = page.getByTestId('library-panel');
  const menu = library.getByLabel(`${title} 메뉴`, { exact: true });
  await menu.click();
  await menu.locator('..').getByRole('button', { name: '편집', exact: true }).click();
  await expect(library.getByLabel('자료 이름', { exact: true })).toHaveValue(title);
  await library.getByText('고급 패키지 설정', { exact: true }).click();
  const fields = library.getByTestId('package-fields');
  await expect(fields).toBeVisible();
  return { library, fields };
}

async function mobileSection(fields: Locator, title: string) {
  const back = fields.getByRole('button', { name: '패키지 분야 목록', exact: true });
  if (await back.isVisible()) await back.click();
  await fields
    .getByRole('navigation', { name: '패키지 편집 분류', exact: true })
    .getByRole('button', { name: title, exact: true })
    .click();
}

async function expectNoOverflow(page: Page, fields: Locator) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
  ).toBeLessThanOrEqual(1);
  expect(await fields.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(
    1
  );
}

test('PNAV01 mobile section navigation preserves lore search, caret and unapplied drafts until explicit save', async ({
  page,
  request,
}, info) => {
  test.setTimeout(60000);
  const item = await seed(request, `PNAV01 ${Date.now()}`);
  await page.setViewportSize({ width: 360, height: 844 });
  const writes: string[] = [];
  page.on('request', (entry) => {
    if (
      entry.url().includes('/api/') &&
      ['POST', 'PUT', 'PATCH', 'DELETE'].includes(entry.method())
    )
      writes.push(`${entry.method()} ${new URL(entry.url()).pathname}`);
  });
  const { library, fields } = await openEditor(page, item.title);
  const navigation = fields.getByRole('navigation', { name: '패키지 편집 분류', exact: true });
  await expect(navigation.getByRole('button')).toHaveText(
    sectionNames.map((name) => new RegExp(name))
  );
  await expect(fields.locator('[data-package-section]')).toHaveCount(9);
  await expect(fields.locator('.package-section-content')).toBeHidden();
  for (const button of await navigation.getByRole('button').all()) {
    const box = await button.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }
  await navigation.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('package-navigation-mobile-list.png') });
  await mobileSection(fields, '로어');
  await expect(navigation).toBeHidden();
  const search = fields.getByLabel('로어 검색', { exact: true });
  await search.fill('별빛');
  const body = fields.getByLabel('로어 2 본문', { exact: true });
  const editedLore = '별빛 아래에서 이어 쓰는 합성 항구';
  await body.fill(editedLore);
  await body.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(2, 6));
  await mobileSection(fields, '지침');
  await fields.getByRole('button', { name: '지침 추가', exact: true }).click();
  const instruction = fields.getByLabel('지침 1 본문', { exact: true });
  const editedInstruction = '합성 지침의 미적용 초안을 유지해요.';
  await instruction.fill(editedInstruction);
  await expect(library.getByRole('button', { name: '변경사항 저장', exact: true })).toBeDisabled();
  await mobileSection(fields, '로어');
  await expect(search).toHaveValue('별빛');
  await expect(body).toHaveValue(editedLore);
  await expect(body).toBeFocused();
  expect(
    await body.evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd])
  ).toEqual([2, 6]);
  await expect(library.getByRole('button', { name: '변경사항 저장', exact: true })).toBeDisabled();
  await mobileSection(fields, '지침');
  await expect(instruction).toHaveValue(editedInstruction);
  await fields.getByRole('button', { name: '지침 검증 후 적용', exact: true }).click();
  expect(writes).toEqual([]);
  await expectNoOverflow(page, fields);
  await page.screenshot({ path: info.outputPath('package-navigation-mobile-draft.png') });
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/content/${item.id}`) && response.request().method() === 'PUT'
  );
  await library.getByRole('button', { name: '변경사항 저장', exact: true }).click();
  const response = await saved;
  expect(response.ok()).toBe(true);
  const current = (await response.json()) as Content;
  expect(current.package!.lore[1].text).toBe(editedLore);
  expect(current.package!.instructions[0].text).toBe(editedInstruction);
  expect(writes).toEqual([`PUT /api/content/${item.id}`]);
  expect(
    (await (
      await request.get(`/api/revisions/content/${item.id}/${item.revision}`)
    ).json()) as Content
  ).toEqual(item);
});

test('PNAV02 desktop keyboard navigation and mobile resizing retain fields, expanded details and visible focus', async ({
  page,
  request,
}, info) => {
  const item = await seed(request, `PNAV02 ${Date.now()}`);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const { fields } = await openEditor(page, item.title);
  let navigation = fields.getByRole('tablist', { name: '패키지 편집 분류', exact: true });
  await expect(navigation).toHaveAttribute('aria-orientation', 'vertical');
  await expect(navigation.getByRole('tab')).toHaveCount(9);
  await expect(navigation.locator('[tabindex="0"]')).toHaveCount(1);
  await navigation.getByRole('tab', { name: '역할별 지침', exact: true }).click();
  const role = fields.getByRole('textbox', { name: '봇으로 사용할 때', exact: true });
  await role.fill('창작할 때 참고하는 합성 역할 지침');
  await role.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(3, 5));
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(role).toBeVisible();
  await expect(role).toBeFocused();
  expect(
    await role.evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd])
  ).toEqual([3, 5]);
  await mobileSection(fields, '표현');
  await fields.getByText('상태창 표시 필드', { exact: true }).click();
  const stateTitle = fields.getByLabel('상태창 제목', { exact: true });
  await stateTitle.fill('합성 상태');
  await mobileSection(fields, '로어');
  await mobileSection(fields, '표현');
  await expect(stateTitle).toBeVisible();
  await expect(stateTitle).toHaveValue('합성 상태');
  await fields.getByRole('button', { name: '패키지 분야 목록', exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  navigation = fields.getByRole('tablist', { name: '패키지 편집 분류', exact: true });
  await navigation.getByRole('tab', { name: '표현', exact: true }).press('Home');
  await expect(navigation.getByRole('tab', { name: '로어', exact: true })).toBeFocused();
  await navigation.getByRole('tab', { name: '로어', exact: true }).press('ArrowDown');
  await expect(navigation.getByRole('tab', { name: '이미지', exact: true })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  await navigation.getByRole('tab', { name: '이미지', exact: true }).press('End');
  await expect(navigation.getByRole('tab', { name: '상태와 행동', exact: true })).toBeFocused();
  await page.setViewportSize({ width: 360, height: 844 });
  await expect(fields.locator('.package-section-heading h3')).toHaveText('상태와 행동');
  await expect(fields.locator('.package-section-heading h3')).toBeFocused();
  expect(await page.evaluate(() => (document.activeElement as HTMLElement).checkVisibility())).toBe(
    true
  );
  await expectNoOverflow(page, fields);
  await page.screenshot({ path: info.outputPath('package-navigation-resize-focus.png') });
});

test('PNAV03 package navigation uses one mobile column and desktop side-by-side panels without overflow', async ({
  page,
  request,
}, info) => {
  const item = await seed(request, `PNAV03 ${Date.now()}`);
  const { fields } = await openEditor(page, item.title);
  for (const width of [360, 390, 430, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    if (width <= 760) {
      await mobileSection(fields, '역할별 지침');
      await expect(
        fields.getByRole('navigation', { name: '패키지 편집 분류', exact: true })
      ).toBeHidden();
    } else {
      const navigation = fields.getByRole('tablist', { name: '패키지 편집 분류', exact: true });
      await navigation.getByRole('tab', { name: '역할별 지침', exact: true }).click();
      const navBox = await navigation.boundingBox();
      const detailBox = await fields.locator('.package-section-content').boundingBox();
      expect(navBox!.x + navBox!.width).toBeLessThan(detailBox!.x);
    }
    await expectNoOverflow(page, fields);
    await fields.locator('.package-section-heading').scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`package-navigation-${width}.png`) });
  }
});
