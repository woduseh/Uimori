import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { Content } from '../core/product.js';
import {
  DESKTOP_HEIGHT,
  DESKTOP_WIDTH,
  MOBILE_HEIGHT,
  MOBILE_WIDTH,
} from './fixtures/browser-viewports.js';
import { nativeContent } from './fixtures/native-content.js';
import { editLibraryContent, navigationAction } from './ui-navigation.js';

const FOLDER_KEY = '\uf000folder:world';

async function post<T>(request: APIRequestContext, path: string, data: unknown): Promise<T> {
  const response = await request.post(path, { data });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

function nextSave(page: Page) {
  return page.waitForResponse(
    (response) =>
      /\/api\/resources\/save$/.test(new URL(response.url()).pathname) &&
      response.request().method() === 'POST'
  );
}

async function seedFolderBot(request: APIRequestContext, title: string) {
  const pkg = nativeContent({
    name: title,
    description: '폴더 로어 편집 브라우저 검증용 봇',
    first_mes: '폴더 로어를 확인해요.',
  });
  pkg.nativeRisu.module = {
    name: `${title} module`,
    lorebook: [
      {
        mode: 'folder',
        key: FOLDER_KEY,
        comment: '세계관',
        content: '',
        folder: '',
        preservedFolderValue: 'folder-source',
      },
      {
        mode: 'normal',
        key: 'city, capital',
        comment: '도시',
        content: '높은 성벽 안에 오래된 도시가 있어요.',
        folder: FOLDER_KEY,
        alwaysActive: false,
        enabled: true,
        preservedLoreValue: 'city-source',
      },
      {
        mode: 'normal',
        key: 'road',
        comment: '미분류 길',
        content: '도시 밖 길은 숲으로 이어져요.',
        folder: '',
        alwaysActive: true,
        enabled: true,
        preservedLoreValue: 'road-source',
      },
    ],
  };
  return post<Content>(request, '/api/content', {
    kind: 'bot',
    title,
    description: pkg.description,
    text: pkg.body,
    loading: 'pinned',
    relatedIds: [],
    package: pkg,
  });
}

async function openLoreEditor(page: Page, title: string) {
  await page.goto('/');
  await navigationAction(page, '봇');
  await page.getByLabel('서재 검색', { exact: true }).fill(title);
  await editLibraryContent(page, title);
  const editor = page.getByRole('region', { name: '자료 상세', exact: true });
  await editor.getByRole('tab', { name: '로어북', exact: true }).click();
  return editor;
}

async function loreNavigation(editor: Locator) {
  const navigation = editor.getByRole('complementary', { name: '로어 목록', exact: true });
  if (!(await navigation.isVisible())) {
    await editor.getByRole('button', { name: '로어 목록 보기', exact: true }).click();
  }
  await expect(navigation).toBeVisible();
  return navigation;
}

async function selectLore(editor: Locator, name: string) {
  const navigation = await loreNavigation(editor);
  await navigation.getByRole('button', { name, exact: true }).click();
}

const viewports = [
  { name: 'desktop', width: DESKTOP_WIDTH, height: DESKTOP_HEIGHT },
  { name: 'mobile', width: MOBILE_WIDTH, height: MOBILE_HEIGHT },
];

test.describe('Native lore drag and drop', () => {
  test.use({ viewport: { width: DESKTOP_WIDTH, height: DESKTOP_HEIGHT } });

  test('NATIVELOREDND01 moves lore into a folder and preserves it after save', async ({
    page,
    request,
  }) => {
    const title = `NATIVELOREDND01 ${randomUUID().slice(0, 8)}`;
    await seedFolderBot(request, title);
    const editor = await openLoreEditor(page, title);
    const navigation = await loreNavigation(editor);
    const row = (name: string) =>
      navigation.getByRole('button', { name, exact: true }).locator('..');

    const target = row('세계관');
    const targetBounds = await target.boundingBox();
    expect(targetBounds).not.toBeNull();
    await row('미분류 길')
      .getByTitle('끌어서 순서 또는 폴더 변경')
      .dragTo(target, {
        targetPosition: {
          x: Math.floor(targetBounds!.width / 2),
          y: Math.floor(targetBounds!.height / 2),
        },
      });
    await expect(editor.getByLabel('로어 이름', { exact: true })).toHaveValue('미분류 길');
    await expect(editor.getByLabel('로어 폴더', { exact: true })).toHaveValue(FOLDER_KEY);
    await expect(navigation.getByRole('status')).toContainText('세계관 폴더');

    const saveResponse = nextSave(page);
    await editor.getByRole('button', { name: '변경사항 저장', exact: true }).click();
    const response = await saveResponse;
    expect(response.ok(), await response.text()).toBe(true);
    const saved = ((await response.json()) as { saved: Content }).saved;
    const lorebook = saved.package.nativeRisu.module!.lorebook as Record<string, unknown>[];
    expect(lorebook.find((entry) => entry.comment === '미분류 길')).toMatchObject({
      folder: FOLDER_KEY,
      preservedLoreValue: 'road-source',
    });

    await page.reload();
    const reloaded = await openLoreEditor(page, title);
    await selectLore(reloaded, '미분류 길');
    await expect(reloaded.getByLabel('로어 폴더', { exact: true })).toHaveValue(FOLDER_KEY);
  });
});

for (const viewport of viewports) {
  test.describe(`Native lore browser ${viewport.name} ${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test(`NATIVELORE01 folders organize lore without becoming lore at ${viewport.width}px`, async ({
      page,
      request,
    }, info) => {
      const title = `NATIVELORE01 ${viewport.width} ${randomUUID().slice(0, 8)}`;
      await seedFolderBot(request, title);
      const editor = await openLoreEditor(page, title);
      let navigation = await loreNavigation(editor);

      await expect(navigation.getByLabel('로어 찾기', { exact: true })).toBeVisible();
      await expect(navigation.getByText('로어북 · 2', { exact: true })).toBeVisible();
      await expect(navigation.getByRole('button', { name: '세계관', exact: true })).toBeVisible();
      await expect(navigation.getByRole('button', { name: '도시', exact: true })).toBeVisible();
      await expect(
        navigation.getByRole('button', { name: '미분류 길', exact: true })
      ).toBeVisible();
      await page.screenshot({ path: info.outputPath(`native-lore-list-${viewport.name}.png`) });

      await navigation.getByRole('button', { name: '세계관 접기', exact: true }).click();
      await expect(navigation.getByRole('button', { name: '도시', exact: true })).toBeHidden();
      await expect(
        navigation.getByRole('button', { name: '세계관 펼치기', exact: true })
      ).toBeVisible();
      await navigation.getByLabel('로어 찾기', { exact: true }).fill('도시');
      await expect(navigation.getByRole('button', { name: '도시', exact: true })).toBeVisible();
      await navigation.getByLabel('로어 찾기', { exact: true }).fill('');
      await navigation.getByRole('button', { name: '세계관 펼치기', exact: true }).click();

      await navigation.getByRole('button', { name: '세계관', exact: true }).click();
      await expect(editor.getByLabel('폴더 이름', { exact: true })).toHaveValue('세계관');
      await expect(editor.getByLabel('로어 본문', { exact: true })).toHaveCount(0);

      if (viewport.width === MOBILE_WIDTH) {
        await expect(navigation).toBeHidden();
        await expect(
          editor.getByRole('button', { name: '로어 목록 보기', exact: true })
        ).toBeVisible();
      }
      await page.screenshot({ path: info.outputPath(`native-lore-folder-${viewport.name}.png`) });

      await selectLore(editor, '도시');
      await expect(editor.getByLabel('로어 이름', { exact: true })).toHaveValue('도시');
      await expect(editor.getByLabel('로어 본문', { exact: true })).toHaveValue(
        '높은 성벽 안에 오래된 도시가 있어요.'
      );
      await expect(editor.getByLabel('로어 폴더', { exact: true })).toHaveValue(FOLDER_KEY);
      await expect(editor.getByLabel('포함 방식', { exact: true })).toHaveValue('conditional');
      await expect(editor.getByRole('switch', { name: '로어 사용', exact: true })).toBeChecked();

      await editor.getByLabel('로어 이름', { exact: true }).fill('수도');
      await editor.getByLabel('로어 본문', { exact: true }).fill('수도는 강과 성벽 사이에 있어요.');
      await editor.getByLabel('로어 폴더', { exact: true }).selectOption('');
      await editor.getByLabel('포함 방식', { exact: true }).selectOption('always');
      await editor.getByLabel('포함 방식', { exact: true }).selectOption('none');
      await expect(
        editor.getByRole('switch', { name: '로어 사용', exact: true })
      ).not.toBeChecked();
      await editor.getByLabel('포함 방식', { exact: true }).selectOption('conditional');
      await expect(editor.getByRole('switch', { name: '로어 사용', exact: true })).toBeChecked();
      await editor.getByLabel('포함 방식', { exact: true }).selectOption('always');
      await editor.getByLabel('포함 방식', { exact: true }).selectOption('none');

      navigation = await loreNavigation(editor);
      await navigation.getByRole('button', { name: '폴더 추가', exact: true }).click();
      await editor.getByLabel('폴더 이름', { exact: true }).fill('인물');
      navigation = await loreNavigation(editor);
      await navigation.getByRole('button', { name: '로어 추가', exact: true }).click();
      await editor.getByLabel('로어 이름', { exact: true }).fill('수문장');
      await editor
        .getByLabel('로어 본문', { exact: true })
        .fill('수문장은 해 질 무렵 문을 닫아요.');
      await editor.getByLabel('로어 폴더', { exact: true }).selectOption({ label: '인물' });
      await editor.getByText('조건·배치·원문 설정', { exact: true }).click();
      await editor.getByRole('switch', { name: '보조 키워드 사용', exact: true }).check();
      await expect(editor.getByLabel('보조 키워드', { exact: true })).toHaveValue('');

      await selectLore(editor, '인물');
      await editor.getByRole('button', { name: '폴더 삭제', exact: true }).click();
      const dialog = page.getByRole('alertdialog', { name: '폴더 삭제', exact: true });
      await expect(dialog).toBeVisible();
      await dialog.getByRole('button', { name: '폴더만 삭제', exact: true }).click();
      await selectLore(editor, '수문장');
      await expect(editor.getByLabel('로어 폴더', { exact: true })).toHaveValue('');

      const saveResponse = nextSave(page);
      await editor.getByRole('button', { name: '변경사항 저장', exact: true }).click();
      const response = await saveResponse;
      expect(response.ok(), await response.text()).toBe(true);
      const saved = ((await response.json()) as { saved: Content }).saved;
      const lorebook = saved.package.nativeRisu.module!.lorebook as Record<string, unknown>[];
      expect(lorebook).toHaveLength(4);
      expect(lorebook.filter((entry) => entry.mode !== 'folder')).toHaveLength(3);
      expect(lorebook).toContainEqual(
        expect.objectContaining({
          mode: 'folder',
          key: FOLDER_KEY,
          comment: '세계관',
          preservedFolderValue: 'folder-source',
        })
      );
      expect(lorebook).toContainEqual(
        expect.objectContaining({
          comment: '수도',
          content: '수도는 강과 성벽 사이에 있어요.',
          alwaysActive: true,
          enabled: false,
          preservedLoreValue: 'city-source',
        })
      );
      expect(lorebook).toContainEqual(
        expect.objectContaining({
          comment: '수문장',
          content: '수문장은 해 질 무렵 문을 닫아요.',
          selective: true,
          secondkey: '',
        })
      );
      expect(lorebook.find((entry) => entry.comment === '수도')).not.toHaveProperty('folder');
      expect(lorebook.find((entry) => entry.comment === '수문장')).not.toHaveProperty('folder');
      expect(lorebook.some((entry) => entry.mode === 'folder' && entry.comment === '인물')).toBe(
        false
      );

      await page.reload();
      const reloaded = await openLoreEditor(page, title);
      await selectLore(reloaded, '수도');
      await expect(reloaded.getByLabel('로어 본문', { exact: true })).toHaveValue(
        '수도는 강과 성벽 사이에 있어요.'
      );
      await expect(reloaded.getByLabel('로어 폴더', { exact: true })).toHaveValue('');
      await expect(reloaded.getByLabel('포함 방식', { exact: true })).toHaveValue('none');
      await expect(
        reloaded.getByRole('switch', { name: '로어 사용', exact: true })
      ).not.toBeChecked();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
      ).toBeLessThanOrEqual(1);
      const switchFit = await reloaded
        .getByRole('switch', { name: '로어 사용', exact: true })
        .evaluate((node) => {
          const control = node.getBoundingClientRect();
          const label = node.closest('label')!.getBoundingClientRect();
          const text = [...node.closest('label')!.childNodes].find(
            (child) => child.nodeType === Node.TEXT_NODE && child.textContent?.trim() === '사용'
          )!;
          const range = document.createRange();
          range.selectNodeContents(text);
          return {
            insideLabel: control.left >= label.left - 1 && control.right <= label.right + 1,
            insideViewport: control.left >= -1 && control.right <= window.innerWidth + 1,
            textLines: range.getClientRects().length,
          };
        });
      expect(switchFit).toEqual({ insideLabel: true, insideViewport: true, textLines: 1 });
      await page.screenshot({
        path: info.outputPath(`native-lore-detail-${viewport.name}.png`),
        fullPage: true,
      });
      navigation = await loreNavigation(reloaded);
      await expect(navigation.getByText('로어북 · 3', { exact: true })).toBeVisible();
      await expect(navigation.getByRole('button', { name: '수문장', exact: true })).toBeVisible();
    });
  });
}

test('NATIVELORE02 card lore keeps native keyword arrays and folder references', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: DESKTOP_HEIGHT });
  const title = `NATIVELORE02 ${randomUUID().slice(0, 8)}`;
  const pkg = nativeContent({
    name: title,
    character_book: {
      entries: [
        {
          id: 1,
          mode: 'folder',
          name: '장소',
          keys: [FOLDER_KEY],
          content: '',
          enabled: true,
          extensions: { preserved: 'folder-extension' },
        },
        {
          id: 2,
          mode: 'normal',
          name: '문',
          keys: ['door'],
          content: '북쪽 문은 밤에 닫혀요.',
          enabled: true,
          constant: false,
          extensions: { preserved: 'lore-extension' },
        },
      ],
    },
  });
  await post<Content>(request, '/api/content', {
    kind: 'bot',
    title,
    description: pkg.description,
    text: pkg.body,
    loading: 'pinned',
    relatedIds: [],
    package: pkg,
  });

  const editor = await openLoreEditor(page, title);
  await selectLore(editor, '문');
  await editor.getByLabel('로어 폴더', { exact: true }).selectOption(FOLDER_KEY);
  await editor.getByText('조건·배치·원문 설정', { exact: true }).click();
  await editor.getByLabel('로어 키워드', { exact: true }).fill('gate, wall');

  const saveResponse = nextSave(page);
  await editor.getByRole('button', { name: '변경사항 저장', exact: true }).click();
  const response = await saveResponse;
  expect(response.ok(), await response.text()).toBe(true);
  const saved = ((await response.json()) as { saved: Content }).saved;
  const entries = saved.package.nativeRisu.card.character_book as {
    entries: Record<string, unknown>[];
  };
  expect(entries.entries).toContainEqual(
    expect.objectContaining({
      id: 1,
      mode: 'folder',
      name: '장소',
      keys: [FOLDER_KEY],
      extensions: { preserved: 'folder-extension' },
    })
  );
  expect(entries.entries).toContainEqual(
    expect.objectContaining({
      id: 2,
      name: '문',
      keys: ['gate', 'wall'],
      folder: FOLDER_KEY,
      extensions: { preserved: 'lore-extension' },
    })
  );
});
