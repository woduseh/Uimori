import { randomUUID } from 'node:crypto';
import {
  expect,
  test,
  type APIRequestContext,
  type Locator,
  type Page,
  type TestInfo,
} from '@playwright/test';
import type { Chat, ChatDetail, Run } from '../core/types.js';
import { fixtureBotInput, postFixtureChat } from './fixtures/chat.js';
import { openSourceActions } from './ui-navigation.js';

test.setTimeout(90000);

const unique = '미라는 창가에 서서 오래 숨을 골랐다.';
const repeated = '바람이 불었다.';
const filler = '항구의 불빛이 하나씩 꺼지고, 젖은 돌길 위로 마지막 마차가 지나갔다. '.repeat(6);
const original = [
  '첫 문단이다. 바람이 불었다.',
  unique,
  '앞에서 **강조한 말**이 남았다.',
  '둘째로 바람이 불었다.',
  ...Array.from({ length: 10 }, (_, index) => `${index + 1}번째 긴 문단. ${filler}`),
].join('\n\n');
const translated = original.replace(unique, '미라는 창가에서 한참 숨을 골랐다.');
const proposal = '미라는 창가에 기대어 천천히 숨을 내쉬었다.';
const endpoint = '**/api/sources/*/selection-revision';

async function detail(request: APIRequestContext, chatId: string): Promise<ChatDetail> {
  const response = await request.get(`/api/chats/${chatId}`);
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

async function seed(
  request: APIRequestContext,
  options: { translation?: string | null; theme?: string } = {}
) {
  const bot = await (await request.post('/api/content', { data: fixtureBotInput() })).json();
  const response = await request.post('/api/chats/import-transcript', {
    data: {
      idempotencyKey: randomUUID(),
      transcript: {
        format: 'uimori-chat-transcript',
        version: 2,
        exportedAt: new Date().toISOString(),
        title: `Reader selection ${randomUUID()}`,
        packageAttachments: [{ id: bot.id, revision: bot.revision, role: 'bot' }],
        notes: [],
        entries: [
          { request: '창가 장면', text: original, translation: options.translation ?? null },
        ],
      },
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const chat = (await response.json()).chat;
  const catalog = await (await request.get('/api/themes')).json();
  const selection = await request.post('/api/themes/selection', {
    data: {
      themeId: options.theme ?? 'builtin:forest',
      targetId: chat.id,
      scope: 'chat',
      expectedRevision: catalog.preferences.revision,
    },
  });
  expect(selection.ok(), await selection.text()).toBe(true);
  const current = await detail(request, chat.id);
  return { chatId: chat.id as string, source: current.sources[0] };
}

type Part = { text: string; changed: boolean; applied: string[] };
async function open(page: Page, chatId: string, sourceId: string, plain = false) {
  if (plain)
    await page.route('**/sources/*/presentation?*', async (route) => {
      const native = await route
        .fetch()
        .then((response) => response.json())
        .catch(() => null);
      if (!native) return route.abort().catch(() => undefined);
      const part = (value?: Part) => value && { text: value.text, changed: false, applied: [] };
      await route
        .fulfill({
          json: {
            ...native,
            format: 'plain-text',
            original: part(native.original),
            translation: part(native.translation),
          },
        })
        .catch(() => undefined);
    });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/?chat=${chatId}`);
  const scene = page.locator(`[data-source-id="${sourceId}"][data-testid="source"]`);
  await expect(scene.locator('.source-reading-content')).toBeVisible();
  await expect
    .poll(() => scene.evaluate((node) => readable(node).includes('첫 문단이다')))
    .toBe(true);
  return scene;
}

declare function readable(node: Element): string;
const helpers = () => {
  const textNodes = (root: Node): Text[] => {
    const nodes: Text[] = [];
    const visit = (node: Node) => {
      if (node instanceof Element && node.shadowRoot) visit(node.shadowRoot);
      if (node instanceof Text) nodes.push(node);
      for (const child of node.childNodes) visit(child);
    };
    visit(root);
    return nodes;
  };
  Object.assign(window, {
    readable: (node: Element) =>
      textNodes(node.querySelector('.source-reading-content')!)
        .map((item) => item.data)
        .join(''),
    selectInScene: (node: Element, needle: string, occurrence = 0) => {
      const nodes = textNodes(node.querySelector('.source-reading-content')!);
      const joined = nodes.map((item) => item.data).join('');
      let index = -1;
      for (let count = 0; count <= occurrence; count++) index = joined.indexOf(needle, index + 1);
      if (index < 0) throw new Error(`Missing ${needle}`);
      const point = (offset: number, end: boolean) => {
        let total = 0;
        for (const item of nodes) {
          if (offset < total + item.data.length || (end && offset === total + item.data.length))
            return [item, offset - total] as const;
          total += item.data.length;
        }
        throw new Error('Out of range');
      };
      const [startNode, startOffset] = point(index, false);
      const [endNode, endOffset] = point(index + needle.length, true);
      startNode.parentElement?.scrollIntoView({ block: 'center' });
      getSelection()!.setBaseAndExtent(startNode, startOffset, endNode, endOffset);
    },
  });
};

async function select(scene: Locator, needle: string, occurrence = 0) {
  await scene.evaluate(
    (node, [needle, occurrence]) =>
      (
        window as unknown as { selectInScene: (n: Element, t: string, o: number) => void }
      ).selectInScene(node, needle as string, occurrence as number),
    [needle, occurrence] as const
  );
}

async function shot(page: Page, info: TestInfo, name: string) {
  await page.screenshot({ path: info.outputPath(`${name}.png`) });
}

function selectionBar(page: Page) {
  return page.getByRole('toolbar', { name: '선택한 글', exact: true });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(helpers);
});

for (const bot of [false, true]) {
  const label = bot ? 'bot chat drawn by Risu' : 'plain display';
  test(`RSEL01 ${label}: the bar offers refine only for a unique verbatim match`, async ({
    page,
    request,
  }) => {
    const { chatId, source } = await seed(request);
    const scene = await open(page, chatId, source.id, !bot);
    await expect(scene.locator('.risu-message-surface')).toHaveCount(bot ? 1 : 0);
    const bar = selectionBar(page);
    await select(scene, unique);
    await expect(bar).toBeVisible();
    await expect(bar.getByRole('button')).toHaveText([
      '다듬기',
      '도우미에게 물어보기',
      '책갈피',
      '복사',
    ]);
    const placement = await page.evaluate(() => {
      const bar = document.querySelector('.reader-selection-bar')!.getBoundingClientRect();
      const rects = [...getSelection()!.getRangeAt(0).getClientRects()];
      return rects.every((rect) => bar.bottom <= rect.top || bar.top >= rect.bottom);
    });
    expect(placement).toBe(true);
    await select(scene, repeated);
    await expect(bar.getByRole('button')).toHaveText(['도우미에게 물어보기', '책갈피', '복사']);
    await select(scene, '강조한 말이 남았');
    await expect(bar.getByRole('button')).toHaveText(['도우미에게 물어보기', '책갈피', '복사']);
    await page.evaluate(() => getSelection()!.removeAllRanges());
    await expect(bar).toHaveCount(0);
  });

  test(`RSEL02 ${label}: a refined source passage saves in place and keeps the reading position`, async ({
    page,
    request,
  }) => {
    const { chatId, source } = await seed(request);
    let body: Record<string, unknown> = {};
    await page.route(endpoint, async (route) => {
      body = route.request().postDataJSON();
      await route.fulfill({ json: { text: proposal } });
    });
    const scene = await open(page, chatId, source.id, !bot);
    await select(scene, unique);
    await selectionBar(page).getByRole('button', { name: '다듬기', exact: true }).click();
    const popover = page.getByRole('dialog', { name: '선택한 글 다듬기', exact: true });
    await expect(popover.getByLabel('다듬을 방향', { exact: true })).toBeFocused();
    await popover.getByLabel('다듬을 방향', { exact: true }).fill('호흡을 행동으로 보여줘.');
    await popover.getByRole('button', { name: '제안 받기', exact: true }).click();
    const diff = popover.getByTestId('reader-revision-proposal');
    await expect(diff.locator('ins').first()).toBeVisible();
    await expect(diff.locator('del').first()).toBeVisible();
    expect(body).toMatchObject({
      draft: original,
      expectedSourceHash: source.hash,
      expectedRevision: source.editRevision ?? 0,
    });
    expect(String(body.draft).slice(Number(body.start), Number(body.end))).toBe(unique);
    await expect(popover.getByText('번역을 바로 저장해요', { exact: false })).toHaveCount(0);
    const before = await scene.evaluate((node) => node.getBoundingClientRect().top);
    await popover.getByRole('button', { name: '적용', exact: true }).click();
    await expect(popover).toHaveCount(0);
    await expect
      .poll(async () => (await detail(request, chatId)).sources[0].text)
      .toBe(original.replace(unique, proposal));
    await expect
      .poll(() => scene.evaluate((node, text) => readable(node).includes(text), proposal))
      .toBe(true);
    const after = await scene.evaluate((node) => node.getBoundingClientRect().top);
    expect(Math.abs(after - before)).toBeLessThanOrEqual(2);
    expect(
      await scene.evaluate((node) =>
        node.querySelector('.source-reading-content')!.contains(document.activeElement)
      )
    ).toBe(true);
  });
}

test('RSEL03 a refined translation passage saves after stating its side effects', async ({
  page,
  request,
}, info) => {
  const { chatId, source } = await seed(request, {
    translation: translated,
    theme: 'builtin:letter',
  });
  await page.route(endpoint, async (route) => {
    expect(route.request().postDataJSON()).toMatchObject({
      target: 'translation',
      draft: translated,
      expectedSourceHash: source.hash,
    });
    await route.fulfill({ json: { text: proposal } });
  });
  const scene = await open(page, chatId, source.id);
  await expect(scene).toHaveAttribute('data-representation', 'translation');
  await select(scene, '미라는 창가에서 한참 숨을 골랐다.');
  await expect(selectionBar(page)).toHaveAttribute('data-placed', 'true');
  await shot(page, info, 'reader-selection-bar-light');
  await selectionBar(page).getByRole('button', { name: '다듬기', exact: true }).click();
  const popover = page.getByRole('dialog', { name: '선택한 글 다듬기', exact: true });
  await popover.getByLabel('다듬을 방향', { exact: true }).fill('더 담담하게.');
  await popover.getByRole('button', { name: '제안 받기', exact: true }).click();
  await expect(
    popover.getByTestId('reader-revision-proposal').locator('ins').first()
  ).toBeVisible();
  await expect(popover.getByText('번역을 바로 저장해요', { exact: false })).toBeVisible();
  await shot(page, info, 'reader-revision-popover-light');
  await popover.getByRole('button', { name: '적용', exact: true }).click();
  await expect(popover).toHaveCount(0);
  await expect
    .poll(async () => {
      const current = await detail(request, chatId);
      return current.jobs.find((job) => job.kind === 'translation' && job.result?.manual)?.result
        ?.text;
    })
    .toBe(translated.replace('미라는 창가에서 한참 숨을 골랐다.', proposal));
  await expect(scene).toHaveAttribute('data-representation', 'translation');
  await expect
    .poll(() => scene.evaluate((node, text) => readable(node).includes(text), proposal))
    .toBe(true);
});

test('RSEL04 a changed source keeps the proposal and saves nothing', async ({
  page,
  request,
}, info) => {
  const { chatId, source } = await seed(request, { theme: 'builtin:letter' });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.addInitScript(() => localStorage.setItem('uimori:theme', 'dark'));
  await page.route(endpoint, (route) => route.fulfill({ json: { text: proposal } }));
  const scene = await open(page, chatId, source.id);
  await select(scene, unique);
  await expect(selectionBar(page)).toHaveAttribute('data-placed', 'true');
  await shot(page, info, 'reader-selection-bar-dark');
  await selectionBar(page).getByRole('button', { name: '다듬기', exact: true }).click();
  const popover = page.getByRole('dialog', { name: '선택한 글 다듬기', exact: true });
  await popover.getByLabel('다듬을 방향', { exact: true }).fill('호흡을 행동으로 보여줘.');
  await popover.getByRole('button', { name: '제안 받기', exact: true }).click();
  await expect(popover.getByTestId('reader-revision-proposal')).toBeVisible();
  await shot(page, info, 'reader-revision-popover-dark');

  let conflictCalls = 0;
  await page.route(`**/api/sources/${source.id}/text`, async (route) => {
    conflictCalls++;
    await route.fulfill({ status: 409, json: { error: 'Source revision conflict' } });
  });
  await popover.getByRole('button', { name: '적용', exact: true }).click();
  await expect(
    popover.getByText('그사이 저장본이 바뀌어서 저장하지 않았어요', { exact: false })
  ).toBeVisible();
  await expect(popover.getByTestId('reader-revision-proposal')).toBeVisible();
  expect(conflictCalls).toBe(1);
  await page.unroute(`**/api/sources/${source.id}/text`);

  const elsewhere = original.replace('첫 문단이다.', '다른 창에서 고친 첫 문단이다.');
  const saved = await request.put(`/api/sources/${source.id}/text`, {
    data: { text: elsewhere, expectedRevision: source.editRevision ?? 0 },
  });
  expect(saved.ok(), await saved.text()).toBe(true);
  await expect(popover.getByText('그사이 원문이 바뀌어서', { exact: false })).toBeVisible();
  await expect(popover.getByTestId('reader-revision-proposal')).toBeVisible();
  await expect(popover.getByRole('button', { name: '적용', exact: true })).toBeDisabled();
  await shot(page, info, 'reader-revision-conflict-dark');
  expect((await detail(request, chatId)).sources[0].text).toBe(elsewhere);
});

test('RSEL05 cancelling aborts the request and Escape closes the popover, then the bar', async ({
  page,
  request,
}) => {
  const { chatId, source } = await seed(request);
  let aborted = false;
  page.on('requestfailed', (failed) => {
    if (failed.url().endsWith('/selection-revision')) aborted = true;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(endpoint, async (route) => {
    await released;
    await route.abort().catch(() => undefined);
  });
  const scene = await open(page, chatId, source.id);
  await select(scene, unique);
  const bar = selectionBar(page);
  await bar.getByRole('button', { name: '다듬기', exact: true }).click();
  const popover = page.getByRole('dialog', { name: '선택한 글 다듬기', exact: true });
  await popover.getByLabel('다듬을 방향', { exact: true }).fill('짧게.');
  await popover.getByRole('button', { name: '제안 받기', exact: true }).click();
  await popover.getByRole('button', { name: '퇴고 요청 취소', exact: true }).click();
  await expect.poll(() => aborted).toBe(true);
  release();
  await expect(popover.getByRole('button', { name: '제안 받기', exact: true })).toBeVisible();
  await expect(popover.getByRole('button', { name: '제안 받기', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(popover).toHaveCount(0);
  await expect(bar.getByRole('button', { name: '다듬기', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(bar).toHaveCount(0);
  expect((await detail(request, chatId)).sources[0].text).toBe(original);
});

test('RSEL06 the bar is reachable by keyboard and absent in editors', async ({ page, request }) => {
  const { chatId, source } = await seed(request);
  const scene = await open(page, chatId, source.id);
  await select(scene, unique);
  const bar = selectionBar(page);
  await expect(bar).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(bar.getByRole('button', { name: '다듬기', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(bar.getByRole('button', { name: '도우미에게 물어보기', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(bar).toHaveCount(0);

  await scene.getByRole('button', { name: '원문 수정', exact: true }).click();
  const field = scene.getByRole('textbox', { name: '원문 수정 내용', exact: true });
  await field.focus();
  await field.evaluate((element: HTMLTextAreaElement, text) => {
    const start = element.value.indexOf(text);
    element.setSelectionRange(start, start + text.length);
  }, unique);
  await page.waitForTimeout(100);
  await expect(bar).toHaveCount(0);
});

test('RSEL07 a translation arriving after the reader scrolled shows a badge instead of switching', async ({
  page,
  request,
}, info) => {
  const { chatId, source } = await seed(request, { theme: 'builtin:letter' });
  const scene = await open(page, chatId, source.id);
  await expect(scene).toHaveAttribute('data-representation', 'original');
  await scene.hover();
  await page.mouse.wheel(0, 200);
  const saved = await request.put(`/api/sources/${source.id}/translation`, {
    data: { text: translated, expectedRevision: 0, expectedSourceHash: source.hash },
  });
  expect(saved.ok(), await saved.text()).toBe(true);
  const badge = scene.getByRole('button', { name: '번역이 준비됐어요. 번역 보기', exact: true });
  await expect(badge).toBeVisible();
  await expect(scene).toHaveAttribute('data-representation', 'original');
  await badge.scrollIntoViewIfNeeded();
  await shot(page, info, 'reader-translation-badge-light');
  await badge.click();
  await expect(scene).toHaveAttribute('data-representation', 'translation');
  await expect(badge).toHaveCount(0);
});

test('RSEL08 a translation arriving while the reader is still switches and keeps the position', async ({
  page,
  request,
}) => {
  const { chatId, source } = await seed(request);
  const scene = await open(page, chatId, source.id, true);
  const reader = page.locator('[data-reader-scrollport]');
  await scene.evaluate((node) => {
    const target = [...node.querySelectorAll<HTMLElement>('[data-block-anchor]')][6];
    const scrollport = node.closest<HTMLElement>('[data-reader-scrollport]')!;
    scrollport.scrollTop +=
      target.getBoundingClientRect().top - scrollport.getBoundingClientRect().top;
  });
  const anchor = await reader.evaluate((node) => node.scrollTop);
  const saved = await request.put(`/api/sources/${source.id}/translation`, {
    data: { text: translated, expectedRevision: 0, expectedSourceHash: source.hash },
  });
  expect(saved.ok(), await saved.text()).toBe(true);
  await expect(scene).toHaveAttribute('data-representation', 'translation');
  await expect(scene.getByRole('button', { name: '번역이 준비됐어요. 번역 보기' })).toHaveCount(0);
  const top = await scene.evaluate((node) => {
    const target = [...node.querySelectorAll<HTMLElement>('[data-block-anchor]')][6];
    const scrollport = node.closest<HTMLElement>('[data-reader-scrollport]')!;
    return target.getBoundingClientRect().top - scrollport.getBoundingClientRect().top;
  });
  expect(Math.abs(top)).toBeLessThanOrEqual(24);
  expect(Math.abs((await reader.evaluate((node) => node.scrollTop)) - anchor)).toBeLessThan(400);
});

test('RSEL09 an explicit choice of the original is not overridden by an arriving translation', async ({
  page,
  request,
}) => {
  const { chatId, source } = await seed(request);
  await page.route(`**/api/sources/${source.id}/translation`, (route) =>
    route.request().method() === 'POST' ? route.fulfill({ json: {} }) : route.fallback()
  );
  const scene = await open(page, chatId, source.id);
  await scene.getByRole('button', { name: '번역 생성', exact: true }).click();
  await expect(scene).toHaveAttribute('data-representation', 'translation');
  await scene.getByRole('button', { name: '원문 보기', exact: true }).click();
  await expect(scene).toHaveAttribute('data-representation', 'original');
  const saved = await request.put(`/api/sources/${source.id}/translation`, {
    data: { text: translated, expectedRevision: 0, expectedSourceHash: source.hash },
  });
  expect(saved.ok(), await saved.text()).toBe(true);
  await expect(scene.getByRole('button', { name: '번역 보기', exact: true })).toBeVisible();
  await page.waitForTimeout(300);
  await expect(scene).toHaveAttribute('data-representation', 'original');
  await expect(scene.getByRole('button', { name: '번역이 준비됐어요. 번역 보기' })).toHaveCount(0);
});

async function openProposal(page: Page, scene: Locator) {
  await select(scene, unique);
  await selectionBar(page).getByRole('button', { name: '다듬기', exact: true }).click();
  const popover = page.getByRole('dialog', { name: '선택한 글 다듬기', exact: true });
  await popover.getByLabel('다듬을 방향', { exact: true }).fill('호흡을 행동으로 보여줘.');
  await popover.getByRole('button', { name: '제안 받기', exact: true }).click();
  await expect(popover.getByTestId('reader-revision-proposal')).toBeVisible();
  return popover;
}

test('RSEL10 Escape during a save keeps the popover so the conflict stays readable', async ({
  page,
  request,
}) => {
  const { chatId, source } = await seed(request);
  await page.route(endpoint, (route) => route.fulfill({ json: { text: proposal } }));
  const scene = await open(page, chatId, source.id);
  const popover = await openProposal(page, scene);
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let saving!: () => void;
  const reached = new Promise<void>((resolve) => {
    saving = resolve;
  });
  await page.route(`**/api/sources/${source.id}/text`, async (route) => {
    saving();
    await released;
    await route.fulfill({ status: 409, json: { error: 'Source revision conflict' } });
  });
  await popover.getByRole('button', { name: '적용', exact: true }).click();
  await reached;
  await expect(popover.getByRole('button', { name: '저장 중', exact: false })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(popover).toBeVisible();
  release();
  await expect(
    popover.getByText('그사이 저장본이 바뀌어서 저장하지 않았어요', { exact: false })
  ).toBeVisible();
  await expect(popover.getByTestId('reader-revision-proposal')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(popover).toHaveCount(0);
  expect((await detail(request, chatId)).sources[0].text).toBe(original);
});

test('RSEL11 global shortcuts wait while the refine popover is open', async ({ page, request }) => {
  const { chatId, source } = await seed(request);
  await page.route(endpoint, (route) => route.fulfill({ json: { text: proposal } }));
  const scene = await open(page, chatId, source.id);
  const popover = await openProposal(page, scene);
  const shell = page.locator('.app-shell');
  await expect(shell).not.toHaveClass(/sidebar-collapsed/);
  for (const key of ['Control+K', 'Control+B', 'Control+Backslash', 'Control+Comma'])
    await page.keyboard.press(key);
  await expect(shell).not.toHaveClass(/sidebar-collapsed/);
  await expect(page.locator('#helper-panel')).toBeHidden();
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await expect(popover).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(popover).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.evaluate(() => getSelection()!.removeAllRanges());
  await page.keyboard.press('Control+B');
  await expect(shell).toHaveClass(/sidebar-collapsed/);
});

for (const bot of [false, true]) {
  const label = bot ? 'bot chat drawn by Risu' : 'plain display';
  test(`RSEL12 ${label}: a selection in the scene keeps an arriving translation as a badge`, async ({
    page,
    request,
  }) => {
    const { chatId, source } = await seed(request);
    const scene = await open(page, chatId, source.id, !bot);
    await expect(scene.locator('.risu-message-surface')).toHaveCount(bot ? 1 : 0);
    await expect(scene).toHaveAttribute('data-representation', 'original');
    await select(scene, unique);
    await expect(selectionBar(page)).toBeVisible();
    const saved = await request.put(`/api/sources/${source.id}/translation`, {
      data: { text: translated, expectedRevision: 0, expectedSourceHash: source.hash },
    });
    expect(saved.ok(), await saved.text()).toBe(true);
    await expect(
      scene.getByRole('button', { name: '번역이 준비됐어요. 번역 보기', exact: true })
    ).toBeVisible();
    await expect(scene).toHaveAttribute('data-representation', 'original');
  });
}

async function writtenScene(request: APIRequestContext) {
  const created = await postFixtureChat(request, {
    data: { title: `Reader translation ${randomUUID()}` },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const chat = (await created.json()) as Chat;
  const before = await detail(request, chat.id);
  const started = await request.post(`/api/chats/${chat.id}/runs`, {
    data: {
      request: '등대지기가 편지를 펼치는 장면이에요.',
      expectedRevision: before.chat.headRevision,
      expectedSettingsRevision: before.chat.settingsRevision,
      expectedProfileRevision: before.profile!.revision,
      idempotencyKey: randomUUID(),
    },
  });
  expect(started.ok(), await started.text()).toBe(true);
  const run = (await started.json()) as Run;
  await expect
    .poll(
      async () => (await detail(request, chat.id)).runs.find((item) => item.id === run.id)?.status
    )
    .toBe('completed');
  return { chatId: chat.id, source: (await detail(request, chat.id)).sources[0] };
}

async function control(request: APIRequestContext, action: string, barrier: string) {
  const response = await request.post('/api/test/control', { data: { action, barrier } });
  expect(response.ok(), await response.text()).toBe(true);
}

test('RSEL13 an editor opened before a translation starts keeps the original when it arrives', async ({
  page,
  request,
}) => {
  const { chatId, source } = await writtenScene(request);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/?chat=${chatId}`);
  const scene = page.locator(`[data-source-id="${source.id}"][data-testid="source"]`);
  await expect(scene).toHaveAttribute('data-representation', 'original');
  await control(request, 'hold', 'translation');
  try {
    await openSourceActions(scene);
    await scene.getByRole('button', { name: '원문 수정', exact: true }).click();
    const field = scene.getByRole('textbox', { name: '원문 수정 내용', exact: true });
    await expect(field).toBeFocused();
    const started = await request.post(`/api/sources/${source.id}/translation`, { data: {} });
    expect(started.ok(), await started.text()).toBe(true);
    await expect(scene.getByRole('button', { name: '번역 보기', exact: true })).toBeVisible();
  } finally {
    await control(request, 'release', 'translation');
  }
  await expect
    .poll(async () =>
      (await detail(request, chatId)).jobs.some(
        (job) => job.kind === 'translation' && job.status === 'completed'
      )
    )
    .toBe(true);
  await expect(
    scene.getByRole('button', { name: '번역이 준비됐어요. 번역 보기', exact: true })
  ).toBeVisible();
  await expect(scene).toHaveAttribute('data-representation', 'original');
  await expect(scene.getByRole('textbox', { name: '원문 수정 내용', exact: true })).toBeFocused();
});

test('RSEL14 a selection held from before a translation starts keeps the original when it arrives', async ({
  page,
  request,
}) => {
  const { chatId, source } = await writtenScene(request);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/?chat=${chatId}`);
  const scene = page.locator(`[data-source-id="${source.id}"][data-testid="source"]`);
  await expect(scene).toHaveAttribute('data-representation', 'original');
  await control(request, 'hold', 'translation');
  try {
    await select(scene, 'the quiet pier');
    await expect(selectionBar(page)).toBeVisible();
    const started = await request.post(`/api/sources/${source.id}/translation`, { data: {} });
    expect(started.ok(), await started.text()).toBe(true);
    await expect(scene.getByRole('button', { name: '번역 보기', exact: true })).toBeVisible();
  } finally {
    await control(request, 'release', 'translation');
  }
  await expect(
    scene.getByRole('button', { name: '번역이 준비됐어요. 번역 보기', exact: true })
  ).toBeVisible();
  await expect(scene).toHaveAttribute('data-representation', 'original');
  await expect(selectionBar(page)).toBeVisible();
});
