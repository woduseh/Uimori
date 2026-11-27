import { test, expect, type APIRequestContext, type Page } from './fixtures/browser-test.js';
import type { Chat, ChatDetail } from '../core/types.js';
import type { OutlineDetail } from '../core/outline.js';
import { postFixtureChat } from './fixtures/chat.js';

const WIDTHS = [390, 1440] as const;
const COMPOSITION = [
  {
    op: 'create',
    ref: 'theme',
    level: 'theme',
    title: '감춰진 이름과 되찾는 선택',
    intent:
      '상대를 지키려는 거짓말은 누구의 선택권을 빼앗는가? 정답을 말하기보다 두 사람의 선택으로 탐구해요.',
  },
  {
    op: 'create',
    ref: 'arc',
    parentRef: 'theme',
    level: 'arc',
    title: '기억 보관소의 문',
    intent: '잃어버린 기억을 찾아 보관소에 접근해요. 주인공이 숨기는 이유는 뒤에서 드러나요.',
  },
  {
    op: 'create',
    ref: 'ep1',
    parentRef: 'arc',
    level: 'episode',
    title: '1화 · 열람권의 대가',
    intent:
      '### 이번 화의 역할\n두 사람이 처음으로 조건부 협력을 시작해요.\n\n### 남길 변화\n열람권을 얻지만 작은 의심이 생겨요. 담보의 정체는 아직 공개하지 않아요.\n\n### 멈출 지점\n보관소 문이 열리기 직전에 멈춰요.',
  },
  {
    op: 'create',
    ref: 'beat',
    parentRef: 'ep1',
    level: 'beat',
    title: '답하지 않은 질문',
    intent: '직원이 담보를 요구해요. 상대가 정체를 묻지만 주인공은 질문을 피합니다.',
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
async function seed(request: APIRequestContext, width: number, empty = false) {
  const response = await postFixtureChat(request, {
    data: { title: `기억 보관소 · 구성 작업실 ${width}` },
  });
  expect(response.ok()).toBe(true);
  const chat: Chat = await response.json();
  if (!empty) {
    const saved = await request.post(`/api/chats/${chat.id}/outline`, {
      data: { idempotencyKey: crypto.randomUUID(), operations: COMPOSITION },
    });
    expect(saved.ok(), await saved.text()).toBe(true);
  }
  return chat;
}
async function open(page: Page, chatId: string, width: number) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`/?chat=${chatId}`);
  await page.locator('.chat-menu').getByLabel('채팅 메뉴').click();
  await page
    .locator('.chat-menu .action-menu-body')
    .getByRole('button', { name: '플롯', exact: true })
    .click();
  const panel = page.locator('.outline-panel');
  await expect(panel).toBeVisible();
  return panel;
}
async function choose(page: Page, title: string, width: number) {
  if (width < 760)
    await page.locator('.outline-mobile-select select').selectOption({ label: `회차: ${title}` });
  else
    await page
      .locator('.outline-navigation .outline-title')
      .getByText(title, { exact: true })
      .click();
  await expect(page.locator('.outline-detail-heading h3')).toHaveText(title);
}
async function sourceCount(request: APIRequestContext, chatId: string) {
  const detail: ChatDetail = await (await request.get(`/api/chats/${chatId}`)).json();
  return detail.sources.length;
}
for (const width of WIDTHS) {
  if (width === 1440)
    test(`OUTUI07 ${width} saved outline conflict preserves the edit draft`, async ({
      page,
      request,
    }) => {
      const chat = await seed(request, width);
      const panel = await open(page, chat.id, width);
      await choose(page, '1화 · 열람권의 대가', width);
      const initial: OutlineDetail = await (
        await request.get(`/api/chats/${chat.id}/outline`)
      ).json();
      const episode = initial.nodes.find((node) => node.title === '1화 · 열람권의 대가')!;
      await panel
        .locator('.outline-primary-actions')
        .getByRole('button', { name: '편집', exact: true })
        .click();
      const input = panel.getByRole('textbox', { name: '이번 회차의 사건과 목적', exact: true });
      await input.fill('이 창에서 작성한 플롯 초안');
      const updated = await request.post(`/api/chats/${chat.id}/outline`, {
        data: {
          idempotencyKey: crypto.randomUUID(),
          operations: [
            {
              op: 'update',
              id: episode.id,
              expectedRevision: episode.revision,
              intent: '다른 창의 변경',
            },
          ],
        },
      });
      expect(updated.ok(), await updated.text()).toBe(true);
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      const conflict = panel.locator('.outline-conflict');
      await expect(conflict).toContainText('플롯이 바뀌었어요.');
      await expect(input).toHaveValue('이 창에서 작성한 플롯 초안');
      await expect(conflict.getByRole('button', { name: '최신 내용 불러오기' })).toBeVisible();
    });

  if (width === 390)
    test(`OUTUI03 ${width} lost save acknowledgement replays once after reload and preserves unsaved content`, async ({
      page,
      request,
    }) => {
      const chat = await seed(request, width),
        bodies: unknown[] = [];
      await page.route(`**/api/chats/${chat.id}/outline`, async (route) => {
        if (route.request().method() !== 'POST') return route.continue();
        bodies.push(route.request().postDataJSON());
        if (bodies.length === 2)
          return route.fulfill({ status: 409, json: { error: 'Temporary confirmation failure' } });
        const response = await route.fetch();
        expect(response.ok()).toBe(true);
        if (bodies.length === 1) await route.abort('failed');
        else await route.fulfill({ response });
      });
      let panel = await open(page, chat.id, width);
      await choose(page, '1화 · 열람권의 대가', width);
      await panel
        .locator('.outline-primary-actions')
        .getByRole('button', { name: '편집', exact: true })
        .click();
      await panel
        .getByRole('textbox', { name: '이번 회차의 사건과 목적', exact: true })
        .fill('응답이 유실되어도 이 초안을 지켜요.');
      await panel
        .locator('.outline-form')
        .getByRole('button', { name: '저장', exact: true })
        .click();
      await expect(panel.getByRole('button', { name: '요청 결과 확인' })).toBeVisible();
      panel = await open(page, chat.id, width);
      await panel.getByRole('button', { name: '요청 결과 확인' }).click();
      await expect.poll(() => bodies.length).toBe(2);
      await expect(panel.getByRole('button', { name: '요청 결과 확인' })).toBeVisible();
      await panel.getByRole('button', { name: '요청 결과 확인' }).click();
      await expect(panel.getByRole('button', { name: '요청 결과 확인' })).toHaveCount(0);
      expect(bodies).toHaveLength(3);
      expect(bodies[1]).toEqual(bodies[0]);
      expect(bodies[2]).toEqual(bodies[0]);
      const saved: OutlineDetail = await (
        await request.get(`/api/chats/${chat.id}/outline`)
      ).json();
      expect(saved.nodes.find((node) => node.title === '1화 · 열람권의 대가')).toMatchObject({
        revision: 2,
        intent: '응답이 유실되어도 이 초안을 지켜요.',
      });
    });

  if (width === 1440)
    test(`OUTUI04 ${width} a lost writer response is confirmed with original revisions, not another run`, async ({
      page,
      request,
    }) => {
      const chat = await seed(request, width),
        bodies: unknown[] = [];
      await page.route('**/api/scene-commands/*/run', async (route) => {
        bodies.push(route.request().postDataJSON());
        if (bodies.length === 2)
          return route.fulfill({ status: 409, json: { error: 'Temporary confirmation failure' } });
        const response = await route.fetch();
        expect(response.ok()).toBe(true);
        if (bodies.length === 1) await route.abort('failed');
        else await route.fulfill({ response });
      });
      let panel = await open(page, chat.id, width);
      await choose(page, '1화 · 열람권의 대가', width);
      await panel.getByRole('button', { name: '집필하기', exact: true }).click();
      await panel.getByRole('button', { name: '집필 시작', exact: true }).click();
      await expect(panel.getByRole('button', { name: '요청 결과 확인' })).toBeVisible();
      await expect.poll(() => sourceCount(request, chat.id)).toBe(1);
      panel = await open(page, chat.id, width);
      await panel.getByRole('button', { name: '요청 결과 확인' }).click();
      await expect.poll(() => bodies.length).toBe(2);
      await expect(panel.getByRole('button', { name: '요청 결과 확인' })).toBeVisible();
      await panel.getByRole('button', { name: '요청 결과 확인' }).click();
      await expect(panel).toHaveCount(0);
      expect(bodies).toHaveLength(3);
      expect(bodies[1]).toEqual(bodies[0]);
      expect(bodies[2]).toEqual(bodies[0]);
      expect(await sourceCount(request, chat.id)).toBe(1);
    });

  if (width === 390)
    test(`OUTUI05 ${width} helper handoff preserves selected identity and draft without automatic model execution`, async ({
      page,
      request,
    }) => {
      const chat = await seed(request, width);
      const panel = await open(page, chat.id, width);
      await choose(page, '1화 · 열람권의 대가', width);
      const messages: Record<string, unknown>[] = [];
      await page.route('**/api/helper/conversations/*/messages', async (route) => {
        if (route.request().method() !== 'POST') return route.continue();
        messages.push(route.request().postDataJSON());
        await route.fulfill({
          status: 409,
          json: { code: 'MODEL_REQUIRED', params: { role: 'helper' } },
        });
      });
      await panel.getByRole('button', { name: '상세화', exact: true }).click();
      const helper = page.locator('#helper-panel');
      await expect(helper).toBeVisible();
      await expect(helper.locator('.helper-outline-selection')).toContainText(
        '1화 · 열람권의 대가'
      );
      const composer = helper.locator('.helper-composer textarea').last();
      await expect(composer).toHaveValue(/선택한 플롯/);
      await composer.fill('내가 미리 작성한 요청을 보존해줘.');
      expect(messages).toHaveLength(0);
      await expect(panel).toBeHidden();
      await helper.getByRole('button', { name: '플롯으로 돌아가기', exact: true }).click();
      await expect(panel).toBeVisible();
      await choose(page, '2화 · 돌아온 출입증', width);
      await panel.getByRole('button', { name: '상세화', exact: true }).click();
      await expect(helper.locator('.helper-outline-selection')).toContainText(
        '2화 · 돌아온 출입증'
      );
      await expect(composer).toHaveValue('내가 미리 작성한 요청을 보존해줘.');
      await composer.press('Control+Enter');
      await expect.poll(() => messages.length).toBe(1);
      const saved: OutlineDetail = await (
        await request.get(`/api/chats/${chat.id}/outline`)
      ).json();
      const selected = saved.nodes.find((node) => node.title === '2화 · 돌아온 출입증')!;
      expect(messages[0].outline).toEqual({
        nodeId: selected.id,
        expectedRevision: selected.revision,
        purpose: 'compose',
      });
      expect(await sourceCount(request, chat.id)).toBe(0);
    });
  if (width === 1440)
    test(`OUTUI08 ${width} the current unit guides ordinary continuation and deletion asks first`, async ({
      page,
      request,
    }) => {
      const chat = await seed(request, width);
      let panel = await open(page, chat.id, width);
      await choose(page, '1화 · 열람권의 대가', width);
      await panel.getByRole('button', { name: '집필하기', exact: true }).click();
      await panel.getByRole('button', { name: '집필 시작', exact: true }).click();
      await expect(panel).toHaveCount(0);
      await expect.poll(() => sourceCount(request, chat.id)).toBe(1);

      const status = page.locator('.composer-dock .outline-focus-status');
      await expect(status).toContainText('진행 중 플롯');
      await expect(
        status.getByRole('button', { name: '1화 · 열람권의 대가 플롯 열기' })
      ).toHaveText('회차 1화 · 열람권의 대가');

      await page.locator('#request').fill('보관소 직원에게 한 번 더 말을 걸어요.');
      const send = page
        .locator('.composer-dock')
        .getByRole('button', { name: '원문 생성', exact: true });
      await expect(send).toBeEnabled();
      await send.click();
      await expect.poll(() => sourceCount(request, chat.id)).toBe(2);
      const linked: OutlineDetail = await (
        await request.get(`/api/chats/${chat.id}/outline`)
      ).json();
      const episode = linked.nodes.find((node) => node.title === '1화 · 열람권의 대가')!;
      expect(linked.focusId).toBe(episode.id);
      expect(episode.writings?.map((source) => [source.origin, source.current])).toEqual([
        ['planned', true],
        ['focus', true],
      ]);

      await status.getByRole('button', { name: '1화 · 열람권의 대가 플롯 열기' }).click();
      panel = page.locator('.outline-panel');
      await expect(panel).toBeVisible();
      await choose(page, '1화 · 열람권의 대가', width);
      const line = panel.locator('.outline-status-line');
      await expect(line).toContainText('진행 중');
      await expect(line).toContainText('원문 2개 연결');
      const row = panel
        .locator('.outline-navigation .outline-entry')
        .filter({ has: page.getByText('기억 보관소의 문', { exact: true }) })
        .first();
      await expect(row.locator('.outline-node-progress').first()).toHaveText('1/2');
      await panel.getByRole('button', { name: '다음: 2화 · 돌아온 출입증', exact: true }).click();
      await expect(panel.locator('.outline-detail-heading h3')).toHaveText('2화 · 돌아온 출입증');

      const menu = panel.locator('.outline-detail-heading details');
      await menu.getByLabel('플롯 관리', { exact: true }).click();
      await menu.getByRole('button', { name: '플롯 수정', exact: true }).click();
      const form = panel.locator('.outline-form');
      await form.getByRole('combobox', { name: '수준', exact: true }).selectOption('beat');
      await form
        .getByRole('combobox', { name: '상위 플롯', exact: true })
        .selectOption({ label: '1화 · 열람권의 대가' });
      const references = form.locator('.outline-reference-picker').first();
      await references.locator('summary').click();
      await references.getByRole('searchbox', { name: '플롯 검색' }).fill('대가');
      await expect(references.locator('label:has(input[type=checkbox])')).toHaveText([
        /1화 · 열람권의 대가/,
      ]);
      await references.getByRole('searchbox', { name: '플롯 검색' }).fill('없는 이름');
      await expect(references).toContainText('검색 결과가 없어요.');
      await form.getByRole('button', { name: '저장', exact: true }).click();
      await expect(form).toHaveCount(0);
      const moved: OutlineDetail = await (
        await request.get(`/api/chats/${chat.id}/outline`)
      ).json();
      expect(moved.nodes.find((node) => node.title === '2화 · 돌아온 출입증')).toMatchObject({
        level: 'beat',
        parentId: episode.id,
      });

      await menu.getByLabel('플롯 관리', { exact: true }).click();
      await menu.getByRole('button', { name: '플롯 삭제', exact: true }).click();
      const confirm = page.getByRole('alertdialog');
      await expect(confirm).toContainText('2화 · 돌아온 출입증 항목을 삭제할까요?');
      await confirm.getByRole('button', { name: '취소', exact: true }).click();
      await expect(confirm).toHaveCount(0);
      expect(
        ((await (await request.get(`/api/chats/${chat.id}/outline`)).json()) as OutlineDetail).nodes
      ).toHaveLength(COMPOSITION.length);
      await menu.getByLabel('플롯 관리', { exact: true }).click();
      await menu.getByRole('button', { name: '플롯 삭제', exact: true }).click();
      await page
        .getByRole('alertdialog')
        .getByRole('button', { name: '플롯 삭제', exact: true })
        .click();
      await expect
        .poll(
          async () =>
            ((await (await request.get(`/api/chats/${chat.id}/outline`)).json()) as OutlineDetail)
              .nodes.length
        )
        .toBe(COMPOSITION.length - 1);

      await panel.getByRole('button', { name: '플롯 닫기', exact: true }).click();
      await status.getByRole('button', { name: '진행 중 플롯 해제', exact: true }).click();
      await expect(status).toHaveCount(0);
      expect(await (await request.get(`/api/chats/${chat.id}/outline/focus`)).json()).toBeNull();
    });
}
