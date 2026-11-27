import { DESKTOP_WIDTH } from './fixtures/browser-viewports.js';
import { randomUUID } from 'node:crypto';
import {
  expect,
  test,
  type APIRequestContext,
  type Locator,
  type Page,
} from './fixtures/browser-test.js';
import type { HelperChange } from '../core/helper.js';
import type { Content } from '../core/product.js';
import { editableResource, type ContentEditModel } from '../core/resource-editing.js';
import { expectCodeFieldValue } from './code-field.js';
import {
  createHelperChat,
  openHelperPanel,
  routeSyntheticHelper,
} from './fixtures/helper-browser.js';
import { nativeContent } from './fixtures/native-content.js';
import {
  editLibraryContent,
  editorChanges,
  navigationAction,
  selectEditorSection,
} from './ui-navigation.js';

test.setTimeout(60000);

type EditorPost = { text: string; editor?: Record<string, any> };

async function seedEditorBot(request: APIRequestContext, title: string) {
  const response = await request.post('/api/content', {
    data: {
      kind: 'bot',
      title,
      package: nativeContent({
        name: title,
        description: '바닷가 마을의 등대지기 이야기예요.\n{{getvar::mood',
        first_mes: '안개가 걷히자 등대 불빛이 바다를 훑었어요.',
        character_book: {
          entries: [
            { keys: ['등대'], content: '등대는 마을 북쪽 절벽 위에 있어요.', comment: '등대' },
            { keys: ['항구'], content: '항구에는 작은 어선이 모여요.', comment: '항구' },
          ],
        },
      }),
      loading: 'pinned',
      relatedIds: [],
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as Content;
}

async function openEditorBot(page: Page, title: string) {
  await page.goto('/');
  await navigationAction(page, '서재');
  await page.getByRole('searchbox', { name: '서재 검색', exact: true }).fill(title);
  await editLibraryContent(page, title);
  return page.getByRole('region', { name: '자료 상세', exact: true });
}

async function openLore(editor: Locator, name: string) {
  await selectEditorSection(editor, '로어북');
  const navigation = editor.getByRole('complementary', { name: '로어 목록', exact: true });
  if (!(await navigation.isVisible()))
    await editor.getByRole('button', { name: '로어 목록 보기', exact: true }).click();
  await navigation.getByRole('button', { name, exact: true }).click();
}

const lastEditorPost = (state: { posts: unknown[] }) => state.posts.at(-1) as EditorPost;
const suggestionList = (panel: Locator) =>
  panel.getByRole('list', { name: '추천 요청', exact: true });

test('EHELP01 an editor ask sends its lore location, @ references go with the request, and an open helper follows the next bot', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const prefix = `EHELP01 ${randomUUID().slice(0, 8)}`;
  const first = await seedEditorBot(request, `${prefix} A`);
  const second = await seedEditorBot(request, `${prefix} B`);
  const state = await routeSyntheticHelper(page);
  const referenceCandidates = [
    { kind: 'scene', id: 'scene-ref-1', chatId: 'chat-ref-1', sceneNumber: 1, title: '등대의 밤' },
    { kind: 'outline', id: 'outline-ref-1', chatId: 'chat-ref-1', title: '폭풍 전야' },
    { kind: 'content', id: 'bot-ref-1', role: 'bot', title: '등대지기 미라' },
  ];
  await page.route('**/api/helper/conversations/*/references*', async (route) => {
    const q = new URL(route.request().url()).searchParams.get('q')?.trim() ?? '';
    const filtered = referenceCandidates.filter(
      (item) =>
        !q || item.title.includes(q) || (item.sceneNumber && `장면 ${item.sceneNumber}`.includes(q))
    );
    await route.fulfill({ json: filtered });
  });
  const editor = await openEditorBot(page, first.title);
  await openLore(editor, '등대');
  const ask = editor.getByRole('button', { name: '등대 도우미에게 묻기', exact: true });
  await ask.click();
  const panel = page.locator('#helper-panel');
  const input = panel.getByLabel('도우미에게 요청');
  await expect(input).toBeEnabled();
  const chip = panel.getByTestId('helper-editor-focus');
  await expect(chip).toContainText('로어북');
  await expect(chip).toContainText('등대');
  await suggestionList(panel)
    .getByRole('button', { name: '이 로어 항목 다듬어 줘', exact: true })
    .click();
  await expect(input).toHaveValue('이 로어 항목 다듬어 줘');
  await expect(suggestionList(panel)).toHaveCount(0);
  await input.press('Control+Enter');
  await expect.poll(() => state.posts.length).toBe(1);
  expect(lastEditorPost(state).editor).toMatchObject({
    kind: 'content',
    source: 'saved',
    focus: { section: 'lore', item: { index: 0, label: '등대' } },
  });
  await chip.getByRole('button', { name: '도우미가 볼 위치 빼기', exact: true }).click();
  await expect(chip).toHaveCount(0);
  await input.click();
  await input.type('@등대');
  const menu = panel.getByTestId('helper-mention-menu');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('option')).toHaveCount(2);
  await input.press('ArrowDown');
  await input.press('Enter');
  await expect(menu).toHaveCount(0);
  await expect(input).toHaveValue('@등대지기 미라 ');
  const mention = panel.getByTestId('helper-mention-chip');
  await expect(mention).toHaveCount(1);
  await expect(mention).toContainText('등대지기 미라');
  await input.type('성격만 보고 답해 줘');
  await input.press('Control+Enter');
  await expect.poll(() => state.posts.length).toBe(2);
  await expect(input).toHaveValue('');
  await expect(mention).toHaveCount(0);
  expect(lastEditorPost(state).editor).toMatchObject({ kind: 'content', source: 'saved' });
  expect(lastEditorPost(state).editor?.focus).toBeUndefined();
  expect((state.posts[1] as { references?: unknown }).references).toEqual([
    { kind: 'content', id: 'bot-ref-1' },
  ]);

  await editor.getByRole('button', { name: '서재 목록', exact: true }).click();
  await page.getByRole('searchbox', { name: '서재 검색', exact: true }).fill(second.title);
  await editLibraryContent(page, second.title);
  await expect(panel.locator('.helper-editor-draft')).toContainText(second.title);
  await openLore(editor, '항구');
  await editor.getByRole('button', { name: '항구 도우미에게 묻기', exact: true }).click();
  await expect(chip).toContainText('항구');
  await suggestionList(panel).getByRole('button').first().click();
  await input.press('Control+Enter');
  await expect.poll(() => state.posts.length).toBe(3);
  expect(lastEditorPost(state).editor).toMatchObject({
    targetId: second.id,
    focus: { section: 'lore', item: { index: 1, label: '항구' } },
  });
});

test('EHELP09 a helper save shows in the open editor with no phantom change, and one under an unsaved draft keeps the draft for the conflict review', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const title = `EHELP09 ${randomUUID().slice(0, 8)}`;
  const bot = await seedEditorBot(request, title);
  const state = await routeSyntheticHelper(page);
  const editor = await openEditorBot(page, title);
  await openLore(editor, '항구');
  await editor.getByRole('button', { name: '항구 도우미에게 묻기', exact: true }).click();
  const panel = page.locator('#helper-panel');
  const input = panel.getByLabel('도우미에게 요청');
  await input.fill('항구 로어를 다듬어 줘');
  await input.press('Control+Enter');
  await expect.poll(() => state.posts.length).toBe(1);
  const current = (await (await request.get(`/api/content/${bot.id}`)).json()) as Content;
  const model = editableResource('content', current) as ContentEditModel;
  const card = structuredClone(model.package.nativeRisu.card) as Record<string, any>;
  card.character_book.entries[1].content = '항구에는 새벽마다 작은 어선이 돌아와요.';
  const changed = await request.put(`/api/content/${bot.id}`, {
    data: {
      ...model,
      package: nativeContent(card, { images: model.package.images }),
      expectedRevision: current.revision,
    },
  });
  expect(changed.ok(), await changed.text()).toBe(true);
  const task = state.current().tasks[0]!;
  state.results.set(task.id, {
    changes: [
      {
        domain: 'resource',
        targetId: bot.id,
        title,
        location: {
          kind: 'resource-list',
          path: ['package', 'nativeRisu', 'card', 'character_book', 'entries'],
          section: 'lore',
          item: { name: '항구', index: 1 },
          field: ['content'],
        },
        action: 'update',
        diff: {
          mode: 'prose',
          unit: 'word',
          added: 2,
          removed: 1,
          hunks: [
            {
              beforeOffset: 0,
              afterOffset: 0,
              segments: [
                { op: 'equal', text: '항구에는 ' },
                { op: 'insert', text: '새벽마다 ' },
                { op: 'equal', text: '작은 어선이 ' },
                { op: 'delete', text: '모여요.' },
                { op: 'insert', text: '돌아와요.' },
              ],
            },
          ],
        },
        anchor: {
          domain: 'resource',
          kind: 'content',
          id: bot.id,
          path: '/package/nativeRisu/card/character_book/entries/1/content',
          section: 'lore',
          index: 1,
        },
      } as HelperChange,
    ],
  });
  state.emit('resource.updated');
  state.complete(task);
  const body = editor.getByRole('textbox', { name: '로어 본문', exact: true });
  await expectCodeFieldValue(body, '항구에는 새벽마다 작은 어선이 돌아와요.');
  await expect(editorChanges(page)).toHaveCount(0);
  await expect(editor.locator('.section-navigation-changed')).toHaveCount(0);
  await expect(panel.locator('.helper-editor-unsaved')).toHaveCount(0);
  await openLore(editor, '등대');
  await panel
    .getByTestId('helper-task-results')
    .getByRole('button', { name: `${title}, 로어북, 항구, 로어 본문 열기`, exact: true })
    .click();
  await expect(
    editor
      .getByRole('complementary', { name: '로어 목록', exact: true })
      .getByRole('button', { name: '항구', exact: true })
  ).toHaveAttribute('aria-current', 'true');

  await body.fill('항구는 사용자가 아직 저장하지 않은 글이에요.');
  const chips = panel.locator('.helper-context-chips');
  await expect(chips.locator('.helper-editor-unsaved')).toBeVisible();
  await editor.getByRole('button', { name: '항구 도우미에게 묻기', exact: true }).click();
  await input.fill('지금 고친 항구 로어가 다른 로어와 맞는지 봐 줘');
  await input.press('Control+Enter');
  await expect.poll(() => state.posts.length).toBe(2);
  const sent = lastEditorPost(state).editor!;
  expect(sent).toMatchObject({
    source: 'unsaved',
    focus: { section: 'lore', unsavedSections: ['lore'] },
  });
  expect(JSON.stringify(sent.model)).toContain('항구는 사용자가 아직 저장하지 않은 글이에요.');
  const saved = (await (await request.get(`/api/content/${bot.id}`)).json()) as Content;
  const savedModel = editableResource('content', saved) as ContentEditModel;
  const savedCard = structuredClone(savedModel.package.nativeRisu.card) as Record<string, any>;
  savedCard.character_book.entries[1].content = '항구에는 도우미가 저장한 글이 있어요.';
  const helperSave = await request.put(`/api/content/${bot.id}`, {
    data: {
      ...savedModel,
      package: nativeContent(savedCard, { images: savedModel.package.images }),
      expectedRevision: saved.revision,
    },
  });
  expect(helperSave.ok(), await helperSave.text()).toBe(true);
  state.emit('resource.updated');
  state.complete(state.current().tasks[0]!);
  const status = editor.getByRole('alert').filter({ hasText: '저장된 자료가 변경됐어요.' });
  await expect(status).toContainText('현재 입력은 유지돼요.');
  await expectCodeFieldValue(body, '항구는 사용자가 아직 저장하지 않은 글이에요.');
  await chips.getByRole('button', { name: '편집 중인 자료 저장', exact: true }).click();
  const review = page.getByRole('alertdialog', { name: '변경된 저장본 확인', exact: true });
  await expect(review.getByRole('region', { name: '현재 저장본' })).toBeVisible();
  await review.getByRole('button', { name: '현재 입력 유지', exact: true }).click();
  await expectCodeFieldValue(body, '항구는 사용자가 아직 저장하지 않은 글이에요.');
  const stored = await (await request.get(`/api/content/${bot.id}`)).json();
  expect(JSON.stringify(stored.package)).toContain('항구에는 도우미가 저장한 글이 있어요.');
  expect(JSON.stringify(stored.package)).not.toContain('사용자가 아직 저장하지 않은');
});

test('HELPASK01 question cards display selectable options, send the chosen reply, and settle after a later turn', async ({
  page,
  request,
}) => {
  const chat = await createHelperChat(request);
  const state = await routeSyntheticHelper(page);
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
  await page.goto(`/?chat=${chat.id}`);
  const panel = await openHelperPanel(page);
  const input = panel.getByLabel('도우미에게 요청');
  await input.fill('이 장면의 문체를 고쳐 주세요');
  await input.press('Control+Enter');
  await expect(input).toHaveValue('');

  const firstTask = state.current().tasks[0]!;
  state.results.set(firstTask.id, {
    confirmations: [
      {
        id: 'held-scene',
        taskId: firstTask.id,
        operation: 'scene.request',
        reason: 'paid',
        chatId: chat.id,
        targets: [{ kind: 'chat', id: chat.id }],
        grantedBy: null,
        grantable: true,
      },
    ],
    question: {
      id: 'q-1',
      question: '어떤 어조로 고칠까요?',
      allowFreeform: true,
      options: [
        { label: '담백하게', description: '문장을 간결하게 줄이고 사실을 또렷하게 써요.' },
        { label: '서정적으로', description: '분위기와 여운을 살려 다듬어요.' },
        { label: '대화 중심', description: '지문을 줄이고 대사의 리듬을 높여요.' },
      ],
    },
  });
  state.complete(firstTask);

  const card = panel.getByTestId('helper-question-card');
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute('data-state', 'open');
  await expect(card).toContainText('어떤 어조로 고칠까요?');

  await panel.getByRole('button', { name: '다음 장면 요청 거절', exact: true }).click();
  await card.getByRole('button', { name: /서정적으로/ }).click();
  await expect.poll(() => state.posts.length).toBe(2);
  expect(state.posts[1]).toMatchObject({
    text: '서정적으로',
    declinedConfirmations: ['held-scene'],
  });
  await expect(card).toHaveAttribute('data-state', 'answered');
  await expect(card).toContainText('이후 대화에서 응답했어요.');
  await expect(card.getByRole('button', { name: /담백하게/ })).toBeDisabled();
});
