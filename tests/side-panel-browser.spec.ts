import { expect, test, type APIRequestContext, type Page } from './fixtures/browser-test.js';
import type { PromptWorkspace } from '../core/product.js';
import { createReadingChat } from './fixtures/personal-workspace.js';
import { nativePrompt } from './fixtures/native-prompt.js';
import { preservePromptWorkspace } from './fixtures/prompt-workspace.js';
import { visualReview } from './fixtures/visual-review.js';

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

async function panelWidth(page: Page, selector: string) {
  return page.locator(selector).evaluate((node) => Math.round(node.getBoundingClientRect().width));
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
  if (visualReview) await page.screenshot({ path: info.outputPath('outline-tab-1440.png') });

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
  if (visualReview) await page.screenshot({ path: info.outputPath('outline-workspace-1440.png') });
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
