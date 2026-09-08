import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { Content } from '../core/product.js';
import type { LibraryOrganization } from '../core/library-organization.js';

async function seedBot(request: APIRequestContext, title: string) {
  const response = await request.post('/api/content', {
    data: {
      kind: 'bot',
      title,
      description: '낯선 도시를 함께 탐험할 합성 안내자예요.',
      text: 'Synthetic guide for local browser verification.',
      loading: 'pinned',
      relatedIds: [],
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<Content>;
}

async function noHorizontalOverflow(page: Page) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  ).toBeLessThanOrEqual(1);
}

for (const [index, width] of [390, 360].entries()) {
  test(`LUSE0${index + 1} mobile ${width}px library starts with readable rows and creates a bot into a chat`, async ({
    page,
    request,
  }, info) => {
    const title = `LUSE ${width} ${Date.now()}`;
    const seed = await seedBot(request, `${title} 안내자`);
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/');
    const panel = page.getByTestId('library-panel');
    await panel.getByLabel('서재 검색', { exact: true }).fill(title);
    const row = panel.locator('.library-list-item');
    await expect(row).toHaveCount(1);
    await expect(
      row.getByRole('button', { name: `${seed.title} 상세 보기`, exact: true })
    ).toBeInViewport();
    await expect(
      row.getByRole('button', { name: `${seed.title} 새 채팅`, exact: true })
    ).toBeInViewport();
    const results = await panel.locator('#library-results').boundingBox();
    expect((await row.boundingBox())!.width).toBeGreaterThanOrEqual(results!.width - 2);
    await expect(panel.locator('.library-folder-list')).toBeHidden();
    await expect(panel.getByRole('button', { name: '선택', exact: true })).toBeHidden();
    await noHorizontalOverflow(page);
    await page.screenshot({ path: info.outputPath(`library-readable-${width}.png`) });

    await panel.getByText('목록 관리', { exact: true }).click();
    await panel.getByRole('button', { name: '선택', exact: true }).click();
    await panel.getByLabel(`${seed.title} 선택`, { exact: true }).check();
    await panel.getByText('목록 관리', { exact: true }).click();
    await expect(panel.getByLabel('서재 검색', { exact: true })).toHaveValue(title);
    await expect(panel.getByLabel(`${seed.title} 선택`, { exact: true })).toBeChecked();
    await panel.getByRole('button', { name: '선택 취소', exact: true }).click();
    await panel.getByRole('button', { name: '새로 만들기', exact: true }).click();
    await expect(panel.getByLabel('자료 이름', { exact: true })).toBeInViewport();
    await expect(panel.getByLabel('자료 본문', { exact: true })).toBeInViewport();
    await expect(panel.getByRole('region', { name: '대표 이미지 설정', exact: true })).toBeHidden();
    await expect(panel.getByRole('group', { name: '패키지 편집 분류', exact: true })).toBeHidden();
    await noHorizontalOverflow(page);
    await page.screenshot({ path: info.outputPath(`library-create-${width}.png`) });
    const createdTitle = `${title} 새 친구`,
      body = '친절한 안내자예요. 내가 고른 길을 존중하며 짧게 대답해요.';
    await panel.getByLabel('자료 이름', { exact: true }).fill(createdTitle);
    await panel.getByLabel('자료 본문', { exact: true }).fill(body);
    const savedResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/content') && response.request().method() === 'POST'
    );
    await panel.getByRole('button', { name: '자료 등록', exact: true }).click();
    const response = await savedResponse;
    expect(response.ok(), await response.text()).toBe(true);
    const saved = (await response.json()) as Content;
    expect(saved.text).toBe(body);
    expect(saved.package?.body).toBe(body);
    const start = panel.getByRole('button', { name: '채팅 시작', exact: true });
    await expect(start).toBeEnabled();
    await expect(start).toBeInViewport();
    await expect(panel.getByRole('status')).toContainText(
      `${createdTitle} 저장됨 · 다음 실행부터 사용해요.`
    );
    await page.screenshot({ path: info.outputPath(`library-saved-${width}.png`) });
    await start.click();
    const dialog = page.getByRole('dialog', { name: '새 채팅', exact: true });
    const createdResponse = page.waitForResponse(
      (reply) => reply.url().endsWith('/api/chats') && reply.request().method() === 'POST'
    );
    await dialog.getByRole('button', { name: '채팅 만들기', exact: true }).click();
    const created = await createdResponse;
    expect(created.ok(), await created.text()).toBe(true);
    const chat = await created.json();
    await expect(dialog).toBeHidden();
    const detail = await (await request.get(`/api/chats/${chat.id}`)).json();
    expect(detail.chat.botId).toBe(saved.id);
    expect(detail.runs).toHaveLength(0);
    await noHorizontalOverflow(page);
  });
}

test('LUSE03 empty persona and module folders explain their roles and offer the matching creation action', async ({
  page,
  request,
}, info) => {
  const folders: Record<string, string> = {};
  for (const category of ['persona', 'module']) {
    const organization = (await (
      await request.get('/api/library/organization')
    ).json()) as LibraryOrganization;
    const response = await request.post('/api/library/folders', {
      data: {
        expectedRevision: organization.revision,
        category,
        title: `LUSE03 ${category} ${Date.now()}`,
      },
    });
    expect(response.ok(), await response.text()).toBe(true);
    const updated = (await response.json()) as LibraryOrganization;
    folders[category] = updated.folders.find(
      (folder) => !organization.folders.some((item) => item.id === folder.id)
    )!.id;
  }
  await page.setViewportSize({ width: 360, height: 800 });
  let contentWrites = 0;
  page.on('request', (item) => {
    if (item.method() === 'POST' && item.url().endsWith('/api/content')) contentWrites++;
  });
  await page.goto('/');
  const panel = page.getByTestId('library-panel');
  for (const [category, name, meaning] of [
    ['persona', '페르소나', '페르소나는 내가 맡을 인물이에요.'],
    ['module', '모듈', '모듈은 대화에 더할 설정·지침이에요.'],
  ]) {
    await panel.getByRole('tab', { name, exact: true }).click();
    await panel
      .getByRole('combobox', { name: '폴더 선택', exact: true })
      .selectOption(folders[category]);
    await expect(panel.locator('.library-role-guide')).toHaveText(meaning);
    await expect(
      panel.getByRole('heading', { name: `새 ${name} 만들기`, exact: true })
    ).toBeVisible();
    await panel.getByRole('button', { name: `${name} 만들기`, exact: true }).click();
    await expect(panel.getByRole('heading', { name: `새 ${name}`, exact: true })).toBeVisible();
    await expect(panel.locator('.library-editor-guide')).toContainText(meaning);
    await panel.getByText('분류·읽기 설정', { exact: true }).click();
    await expect(panel.getByLabel('자료 종류', { exact: true })).toHaveValue(category);
    await noHorizontalOverflow(page);
    await page.screenshot({ path: info.outputPath(`library-role-${category}-360.png`) });
    await panel.getByRole('button', { name: '← 서재 목록', exact: true }).click();
  }
  expect(contentWrites).toBe(0);
});
