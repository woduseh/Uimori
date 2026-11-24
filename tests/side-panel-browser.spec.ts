import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { PromptWorkspace } from '../core/product.js';
import { createReadingChat } from './fixtures/personal-workspace.js';
import { nativePrompt } from './fixtures/native-prompt.js';
import { preservePromptWorkspace } from './fixtures/prompt-workspace.js';

preservePromptWorkspace();

const OUTLINE = [
  {
    op: 'create',
    ref: 'arc',
    level: 'arc',
    title: '기억 보관소의 문',
    intent: '잃어버린 기억을 찾아 보관소에 접근해요.',
  },
  {
    op: 'create',
    ref: 'ep1',
    parentRef: 'arc',
    level: 'episode',
    title: '1화 · 열람권의 대가',
    intent: '두 사람이 처음으로 조건부 협력을 시작해요. 보관소 문이 열리기 직전에 멈춰요.',
  },
  {
    op: 'create',
    ref: 'ep2',
    parentRef: 'arc',
    level: 'episode',
    title: '2화 · 돌아온 출입증',
    intent: '상대가 떠나지 않고 돌아왔다는 작은 징후를 남겨요.',
  },
];

async function fixture(request: APIRequestContext, title: string) {
  const before = (await (await request.get('/api/prompt-workspace')).json()) as PromptWorkspace;
  const changed = await request.put('/api/prompt-workspace', {
    data: {
      expectedRevision: before.revision,
      main: {
        title: '우측 패널 검증',
        program: nativePrompt('', { customPromptTemplateToggle: 'tone=합성 문체=text' }),
        values: { tone: '기준 문체' },
      },
    },
  });
  expect(changed.ok(), await changed.text()).toBe(true);
  const { chat, detail } = await createReadingChat(request, `${title} ${Date.now()}`, 1);
  const source = detail.sources[0];
  const text = Array.from(
    { length: 60 },
    (_, index) =>
      `문단 ${index + 1}: 비가 그친 도서관에서 하린은 접어 둔 편지를 펼쳤다. 창밖의 은행나무가 바람에 흔들리고, 오래된 책장 사이로 작은 발소리가 이어졌다. 하린은 첫 줄을 다시 읽었다.`
  ).join('\n\n');
  const edited = await request.put(`/api/sources/${source.id}/text`, {
    data: { expectedRevision: source.editRevision ?? 0, text },
  });
  expect(edited.ok(), await edited.text()).toBe(true);
  const outline = await request.post(`/api/chats/${chat.id}/outline`, {
    data: { idempotencyKey: crypto.randomUUID(), operations: OUTLINE },
  });
  expect(outline.ok(), await outline.text()).toBe(true);
  return { chat, source };
}

async function openChat(page: Page, chatId: string, sourceId: string, width = 1440) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`/?chat=${chatId}&source=${sourceId}&mode=original`);
  await expect(page.getByTestId('source')).toContainText('비가 그친 도서관');
}

const header = (page: Page) => page.locator('.workspace-header');
const reader = (page: Page) => page.locator('[data-reader-scrollport]');

async function readingAnchor(page: Page) {
  return reader(page).evaluate((node) => {
    const top = node.getBoundingClientRect().top;
    const all = (root: ParentNode): HTMLElement[] =>
      [...root.querySelectorAll<HTMLElement>('*')].flatMap((item) =>
        item.shadowRoot ? [item, ...all(item.shadowRoot)] : [item]
      );
    const paragraph = all(node.querySelector('[data-testid="source"]')!).find(
      (item) =>
        !item.firstElementChild &&
        item.textContent?.startsWith('문단 ') &&
        item.getBoundingClientRect().bottom > top
    )!;
    return {
      text: paragraph.textContent?.split(':')[0],
      top: paragraph.getBoundingClientRect().top - top,
    };
  });
}

async function expectSamePassage(page: Page, before: { text?: string; top: number }) {
  await expect
    .poll(async () => {
      const after = await readingAnchor(page);
      return after.text === before.text && Math.abs(after.top - before.top) <= 2;
    })
    .toBe(true);
}

async function panelWidth(page: Page, selector: string) {
  return page.locator(selector).evaluate((node) => Math.round(node.getBoundingClientRect().width));
}

async function expectTabsAlignedWithHeader(page: Page) {
  const tabs = (await page.locator('.side-panel-tabs:visible').boundingBox())!;
  const main = (await header(page).boundingBox())!;
  expect(Math.abs(tabs.y - main.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(tabs.y + tabs.height - (main.y + main.height))).toBeLessThanOrEqual(1);
}

async function surfaceOf(page: Page, selector: string) {
  return page.locator(selector).evaluate((node) => {
    const probe = document.createElement('div');
    probe.style.background = 'var(--panel)';
    document.body.append(probe);
    const panel = getComputedStyle(probe).backgroundColor;
    probe.remove();
    const style = getComputedStyle(node);
    return { background: style.backgroundColor, panel, shadow: style.boxShadow };
  });
}

test('SIDEPANEL01 outline and writing options share the right panel and keep their unsaved work', async ({
  page,
  request,
}, info) => {
  const { chat, source } = await fixture(request, '우측 패널 탭');
  await openChat(page, chat.id, source.id);
  const outlineToggle = header(page).getByRole('button', { name: '플롯', exact: true });
  await expect(outlineToggle).toHaveAttribute('aria-pressed', 'false');
  await outlineToggle.click();
  await expect(outlineToggle).toHaveAttribute('aria-pressed', 'true');
  const outline = page.locator('#outline-panel');
  await expect(outline).toHaveClass(/outline-sidecar/u);
  await expect(page.getByTestId('source')).toBeVisible();
  await reader(page).evaluate((node) => {
    node.scrollTop = 600;
  });
  await expect.poll(() => reader(page).evaluate((node) => node.scrollTop)).toBeGreaterThan(500);
  await outline
    .locator('.outline-mobile-select select')
    .selectOption({ label: '회차: 1화 · 열람권의 대가' });
  await outline
    .locator('.outline-primary-actions')
    .getByRole('button', { name: '편집', exact: true })
    .click();
  const intent = outline.getByRole('textbox', { name: '이번 회차의 사건과 목적', exact: true });
  await intent.fill('본문을 보면서 고친 플롯 초안');
  expect(await panelWidth(page, '.story-workspace')).toBeGreaterThanOrEqual(768);
  await page.screenshot({ path: info.outputPath('outline-tab-1440.png') });

  await outline.getByRole('tab', { name: '창작 옵션', exact: true }).click();
  const options = page.locator('#chat-prompt-options');
  await expect(outline).toBeHidden();
  await expect(options.getByRole('tab', { name: '창작 옵션', exact: true })).toBeFocused();
  await options.locator('.chat-option-group > summary').first().click();
  await options.getByRole('button', { name: '합성 문체 개별 지정', exact: true }).click();
  const tone = options.getByLabel('합성 문체', { exact: true });
  await tone.fill('탭을 오가도 남는 문체');
  const save = options.getByRole('button', { name: '채팅 고정 옵션 저장', exact: true });
  await expect(save).toBeEnabled();

  await options.getByRole('tab', { name: '플롯', exact: true }).click();
  await expect(options).toBeHidden();
  await expect(intent).toHaveValue('본문을 보면서 고친 플롯 초안');
  await outline.getByRole('tab', { name: '창작 옵션', exact: true }).click();
  await expect(tone).toHaveValue('탭을 오가도 남는 문체');
  await expect(save).toBeEnabled();

  await options.getByRole('tab', { name: '플롯', exact: true }).click();
  await outline.getByRole('button', { name: '플롯 크게 보기', exact: true }).click();
  await expect(outline).toHaveClass(/outline-workspace-shell/u);
  await expect(page.locator('.outline-navigation')).toBeVisible();
  await expect(intent).toHaveValue('본문을 보면서 고친 플롯 초안');
  await outline.getByRole('button', { name: '도우미', exact: true }).click();
  const helper = page.locator('#helper-panel');
  await expect(helper).toBeVisible();
  await expect(helper.getByRole('tab')).toHaveCount(0);
  await expect(helper.getByRole('button', { name: '도우미 닫기', exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('outline-workspace-1440.png') });
  await outline.getByRole('button', { name: '플롯 닫기', exact: true }).click();
  await expect(outline).toHaveClass(/outline-sidecar/u);
  await expect(outline.getByRole('tab', { name: '플롯', exact: true })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  await expect(intent).toHaveValue('본문을 보면서 고친 플롯 초안');
  await outline.getByRole('button', { name: '플롯 닫기', exact: true }).click();
  await expect(outline).toBeHidden();
  await expect(outlineToggle).toHaveAttribute('aria-pressed', 'false');
});

test('SIDEPANEL02 the panel edge resizes by pointer and keyboard and persists once on release', async ({
  page,
  request,
}) => {
  const { chat, source } = await fixture(request, '우측 패널 폭');
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('side-panel-seeded')) {
      sessionStorage.setItem('side-panel-seeded', 'true');
      localStorage.setItem('uimori:panel-width', '480');
    }
  });
  await openChat(page, chat.id, source.id);
  await header(page).getByRole('button', { name: '도우미', exact: true }).click();
  const helper = page.locator('#helper-panel');
  await expect(helper).toBeVisible();
  expect(await panelWidth(page, '#helper-panel')).toBe(480);
  const edge = page.getByRole('separator', { name: '우측 패널 폭', exact: true });
  await expect(edge).toHaveAttribute('aria-valuenow', '480');
  const box = (await edge.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 60, box.y + 200, { steps: 4 });
  expect(await panelWidth(page, '#helper-panel')).toBe(540);
  expect(await page.evaluate(() => localStorage.getItem('uimori:panel-width'))).toBe('480');
  await page.mouse.move(box.x - 600, box.y + 200, { steps: 4 });
  await page.mouse.up();
  const maximum = 1440 - 56 - 768;
  await expect(edge).toHaveAttribute('aria-valuenow', String(maximum));
  expect(await panelWidth(page, '#helper-panel')).toBe(maximum);
  expect(await panelWidth(page, '.story-workspace')).toBe(768);
  expect(await page.evaluate(() => localStorage.getItem('uimori:panel-width'))).toBe(
    String(maximum)
  );

  await edge.focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(edge).toHaveAttribute('aria-valuenow', String(maximum - 32));
  await page.keyboard.press('Home');
  await expect(edge).toHaveAttribute('aria-valuenow', '360');
  await page.keyboard.press('ArrowLeft');
  await expect(edge).toHaveAttribute('aria-valuenow', '376');
  expect(await page.evaluate(() => localStorage.getItem('uimori:panel-width'))).toBe('376');

  await page.reload();
  await header(page).getByRole('button', { name: '도우미', exact: true }).click();
  await expect(helper).toBeVisible();
  expect(await panelWidth(page, '#helper-panel')).toBe(376);
  await header(page).getByRole('button', { name: '플롯', exact: true }).click();
  expect(await panelWidth(page, '#outline-panel')).toBe(400);
  await expect(edge).toHaveAttribute('aria-valuemin', '400');

  await page.evaluate(() => localStorage.setItem('uimori:panel-width', '9999'));
  await page.reload();
  await header(page).getByRole('button', { name: '도우미', exact: true }).click();
  expect(await panelWidth(page, '#helper-panel')).toBe(maximum);
  expect(await panelWidth(page, '.story-workspace')).toBeGreaterThanOrEqual(768);
});

test('SIDEPANEL03 resizing keeps working when browser storage refuses writes', async ({
  page,
  request,
}) => {
  const { chat, source } = await fixture(request, '우측 패널 저장 불가');
  await page.addInitScript(() => {
    const write = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key === 'uimori:panel-width')
        throw new DOMException('Quota exceeded', 'QuotaExceededError');
      write.call(this, key, value);
    };
  });
  await openChat(page, chat.id, source.id);
  await header(page).getByRole('button', { name: '도우미', exact: true }).click();
  const edge = page.getByRole('separator', { name: '우측 패널 폭', exact: true });
  await edge.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(edge).toHaveAttribute('aria-valuenow', '400');
  expect(await panelWidth(page, '#helper-panel')).toBe(400);
  await header(page).getByRole('button', { name: '플롯', exact: true }).click();
  await header(page).getByRole('button', { name: '도우미', exact: true }).click();
  expect(await panelWidth(page, '#helper-panel')).toBe(400);
});

test('SIDEPANEL04 opening, resizing and closing the panel keep the passage being read', async ({
  page,
  request,
}) => {
  const { chat, source } = await fixture(request, '우측 패널 읽기 위치');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await openChat(page, chat.id, source.id);
  await reader(page).evaluate((node) => {
    node.scrollTop = 1800;
  });
  await expect.poll(() => reader(page).evaluate((node) => node.scrollTop)).toBeGreaterThan(1700);
  let anchor = await readingAnchor(page);
  expect(Number(anchor.text?.replace('문단 ', ''))).toBeGreaterThan(5);
  await header(page).getByRole('button', { name: '도우미', exact: true }).click();
  await expect(page.locator('#helper-panel')).toBeVisible();
  await expectSamePassage(page, anchor);

  anchor = await readingAnchor(page);
  const edge = page.getByRole('separator', { name: '우측 패널 폭', exact: true });
  const box = (await edge.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x - 120, box.y + 200, { steps: 6 });
  await page.mouse.up();
  await expectSamePassage(page, anchor);

  anchor = await readingAnchor(page);
  await edge.focus();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expectSamePassage(page, anchor);

  anchor = await readingAnchor(page);
  await header(page).getByRole('button', { name: '플롯', exact: true }).click();
  await expect(page.locator('#outline-panel')).toBeVisible();
  await expectSamePassage(page, anchor);

  anchor = await readingAnchor(page);
  await header(page).getByRole('button', { name: '플롯', exact: true }).click();
  await expect(page.locator('#outline-panel')).toBeHidden();
  await expectSamePassage(page, anchor);
  expect(await reader(page).evaluate((node) => node.scrollTop)).toBeGreaterThan(1000);
});

test('SIDEPANEL05 the shortcut reopens the last used tab', async ({ page, request }) => {
  const { chat, source } = await fixture(request, '우측 패널 단축키');
  await openChat(page, chat.id, source.id);
  const composer = page.getByRole('textbox', { name: '다음 장면 요청', exact: true });
  await composer.click();
  await page.keyboard.press('Control+Backslash');
  const helper = page.locator('#helper-panel');
  await expect(helper).toBeVisible();
  await helper.getByRole('tab', { name: '플롯', exact: true }).click();
  const outline = page.locator('#outline-panel');
  await expect(outline).toBeVisible();
  await page.keyboard.press('Control+Backslash');
  await expect(outline).toBeHidden();
  await composer.click();
  await page.keyboard.press('Control+Backslash');
  await expect(outline).toBeVisible();
  await expect(outline.getByRole('tab', { name: '플롯', exact: true })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  await expect(helper).toBeHidden();
});

for (const width of [1440, 2560])
  test(`SIDEPANEL06 ${width} each tab sits beside the manuscript in light and dark themes`, async ({
    page,
    request,
  }, info) => {
    const { chat, source } = await fixture(request, `우측 패널 화면 ${width}`);
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await openChat(page, chat.id, source.id, width);
      await header(page).getByRole('button', { name: '도우미', exact: true }).click();
      await expect(page.locator('#helper-panel')).toBeVisible();
      for (const [tab, surface] of [
        ['도우미', '#helper-panel'],
        ['플롯', '#outline-panel'],
        ['창작 옵션', '#chat-prompt-options'],
      ] as const) {
        await page
          .locator('.side-panel-tabs:visible')
          .getByRole('tab', { name: tab, exact: true })
          .click();
        await expect(page.locator(surface)).toBeVisible();
        await expect(
          page
            .locator(surface)
            .locator('.helper-composer, .outline-detail, .chat-option-group')
            .first()
        ).toBeVisible();
        await expect(page.getByTestId('source')).toBeVisible();
        await expectTabsAlignedWithHeader(page);
        expect((await surfaceOf(page, surface)).shadow).toBe('none');
        expect(await panelWidth(page, '.story-workspace')).toBeGreaterThanOrEqual(768);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
        ).toBeLessThanOrEqual(1);
        await page.screenshot({
          path: info.outputPath(`${surface.slice(1)}-${scheme}-${width}.png`),
        });
      }
      await page.locator('.side-panel-tabs:visible').getByRole('tab', { name: '플롯' }).click();
      await page.getByRole('button', { name: '플롯 크게 보기', exact: true }).click();
      await page
        .locator('#outline-panel')
        .getByRole('button', { name: '도우미', exact: true })
        .click();
      await expect(page.locator('#helper-panel .helper-composer')).toBeVisible();
      await expect(page.locator('.outline-navigation')).toBeVisible();
      await page.screenshot({ path: info.outputPath(`outline-workspace-${scheme}-${width}.png`) });
    }
  });

test('SIDEPANEL07 Back with the docked helper open returns to the previous chat and tab changes keep focus on the tabs', async ({
  page,
  request,
}) => {
  const first = await fixture(request, '우측 패널 뒤로');
  const secondTitle = `${first.chat.title} 자료`;
  await openChat(page, first.chat.id, first.source.id);
  await header(page).getByRole('button', { name: '도우미', exact: true }).click();
  const helper = page.locator('#helper-panel');
  await expect(helper).toBeVisible();
  await expect(helper).not.toHaveClass(/helper-expanded/u);
  await page.locator('.sidebar').getByRole('button', { name: secondTitle, exact: true }).click();
  await expect(page).not.toHaveURL(new RegExp(`chat=${first.chat.id}`, 'u'));
  await expect(header(page)).toContainText(secondTitle);
  await expect(helper).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`chat=${first.chat.id}`, 'u'));
  await expect(header(page)).not.toContainText(secondTitle);
  await expect(header(page)).toContainText(first.chat.title);
  await expect(helper).toBeVisible();
  await page.goForward();
  await expect(header(page)).toContainText(secondTitle);

  await page.evaluate(() => {
    const trail: string[] = [];
    Object.assign(window, { focusTrail: trail });
    document.addEventListener('focusin', (event) => {
      const target = event.target as HTMLElement;
      trail.push(target.closest('.workspace-header') ? 'header' : 'panel');
    });
  });
  await helper.getByRole('tab', { name: '플롯', exact: true }).click();
  const outline = page.locator('#outline-panel');
  await expect(outline.getByRole('tab', { name: '플롯', exact: true })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  await expect
    .poll(() => outline.evaluate((node) => node.contains(document.activeElement)))
    .toBe(true);
  await outline.getByRole('tab', { name: '도우미', exact: true }).click();
  await expect(helper.getByRole('tab', { name: '도우미', exact: true })).toBeFocused();
  expect(
    await page.evaluate(() => (window as unknown as { focusTrail: string[] }).focusTrail)
  ).not.toContain('header');
});

test('SIDEPANEL08 a wide stored panel width stays inside a narrower window as an overlay', async ({
  page,
  request,
}) => {
  const { chat, source } = await fixture(request, '우측 패널 넓은 너비');
  await page.addInitScript(() => localStorage.setItem('uimori:panel-width', '920'));
  await openChat(page, chat.id, source.id, 2200);
  await header(page).getByRole('button', { name: '도우미', exact: true }).click();
  const helper = page.locator('#helper-panel');
  await expect(helper).toBeVisible();
  expect(await panelWidth(page, '#helper-panel')).toBe(920);
  for (const width of [959, 800, 761]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.locator('.app-shell')).toHaveClass(/panel-overlay/u);
    const box = await helper.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      return { left: rect.left, right: rect.right, viewport: innerWidth };
    });
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(box.viewport);
    await expectTabsAlignedWithHeader(page);
    const surface = await surfaceOf(page, '#helper-panel');
    expect(surface.background).toBe(surface.panel);
    expect(surface.shadow).not.toBe('none');
  }
});
