import { loopbackProvider, writeSse } from './fixtures/loopback-provider.js';
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import type { Chat, ChatDetail } from '../core/types.js';
import type { OutlineDetail } from '../core/outline.js';
import { postFixtureChat } from './fixtures/chat.js';

// This redesigned workspace is checked at its agreed narrow and desktop design widths.
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
    .getByRole('button', { name: '계층형 구성', exact: true })
    .click();
  const panel = page.locator('.outline-panel');
  await expect(panel).toBeVisible();
  return panel;
}
async function choose(page: Page, title: string, width: number) {
  if (width < 760)
    await page.locator('.outline-mobile-select select').selectOption({ label: `회차 · ${title}` });
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
  test(`OUTUI01 ${width} approachable start, skipped levels and responsive editing preserve drafts`, async ({
    page,
    request,
  }, info) => {
    const chat = await seed(request, width, true);
    let modelRequests = 0;
    page.on('request', (r) => {
      if (r.method() === 'POST' && /\/messages$|\/run$/.test(new URL(r.url()).pathname))
        modelRequests++;
    });
    const panel = await open(page, chat.id, width);
    await expect(
      panel.getByRole('heading', { name: '작은 장면에서 시작해도 좋아요.' })
    ).toBeVisible();
    await page.screenshot({ path: info.outputPath(`outline-empty-${width}.png`) });
    await panel.getByRole('button', { name: '직접 추가', exact: true }).click();
    const form = panel.locator('.outline-form');
    await form.getByRole('combobox', { name: '수준', exact: true }).selectOption('episode');
    await form.getByRole('textbox', { name: '이름', exact: true }).fill('한 회차에서 시작');
    const intent = form.getByRole('textbox', { name: '구성 내용', exact: true });
    await intent.pressSequentially('대화를 길게 나누되 관계를 급하게 진전시키지 않아요.');
    await expect(intent).toBeFocused();
    await form.getByRole('button', { name: '닫기 · 초안 보관' }).click();
    await panel.getByRole('button', { name: '직접 추가', exact: true }).click();
    await expect(form.getByRole('textbox', { name: '이름', exact: true })).toHaveValue(
      '한 회차에서 시작'
    );
    await form.getByRole('button', { name: '추가', exact: true }).click();
    await expect(panel.locator('.outline-detail-heading h3')).toHaveText('한 회차에서 시작');
    const saved: OutlineDetail = await (await request.get(`/api/chats/${chat.id}/outline`)).json();
    expect(saved.nodes).toHaveLength(1);
    expect(saved.nodes[0]).toMatchObject({ parentId: null, level: 'episode' });
    expect(modelRequests).toBe(0);
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    await page.screenshot({ path: info.outputPath(`outline-standalone-dark-${width}.png`) });
    expect(await panel.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.body.scrollWidth <= innerWidth)).toBe(true);
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
  });

  test(`OUTUI02 ${width} plan detail, brief preview and continuation use only selected unit`, async ({
    page,
    request,
  }, info) => {
    const chat = await seed(request, width);
    let panel = await open(page, chat.id, width);
    await choose(page, '1화 · 열람권의 대가', width);
    await expect(panel.locator('.outline-intent-card')).toContainText('멈출 지점');
    await page.screenshot({ path: info.outputPath(`outline-detail-light-${width}.png`) });
    await panel.getByRole('button', { name: '이번 구성의 집필 맥락 보기' }).click();
    await expect(panel.locator('.outline-brief')).toContainText('감춰진 이름과 되찾는 선택');
    expect(await sourceCount(request, chat.id)).toBe(0);
    await panel.getByRole('button', { name: '이 단위 집필', exact: true }).click();
    await panel
      .getByLabel('추가 지시와 멈출 지점')
      .fill('선택한 1화만 집필해요. 문이 열리기 직전에 멈춰요.');
    await page.screenshot({ path: info.outputPath(`outline-writing-${width}.png`) });
    await panel.getByRole('button', { name: '집필 시작', exact: true }).click();
    await expect(panel).toHaveCount(0);
    await expect.poll(() => sourceCount(request, chat.id)).toBe(1);
    panel = await open(page, chat.id, width);
    await choose(page, '1화 · 열람권의 대가', width);
    await expect(panel.locator('.outline-status-line')).toContainText('원문 1개 연결');
    await panel.getByRole('button', { name: '이어 쓰기', exact: true }).click();
    await panel.getByRole('button', { name: '집필 시작', exact: true }).click();
    await expect.poll(() => sourceCount(request, chat.id)).toBe(2);
    const detail: OutlineDetail = await (await request.get(`/api/chats/${chat.id}/outline`)).json();
    expect(
      detail.nodes.find((node) => node.title === '1화 · 열람권의 대가')?.writings
    ).toHaveLength(2);
    expect(
      detail.nodes
        .filter((node) => node.title !== '1화 · 열람권의 대가')
        .every((node) => !node.writings?.length)
    ).toBe(true);
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
        const response = await route.fetch();
        expect(response.ok()).toBe(true);
        if (bodies.length === 1) await route.abort('failed');
        else await route.fulfill({ response });
      });
      let panel = await open(page, chat.id, width);
      await choose(page, '1화 · 열람권의 대가', width);
      await panel
        .locator('.outline-intent-card')
        .getByRole('button', { name: '편집', exact: true })
        .click();
      await panel
        .getByRole('textbox', { name: '구성 내용', exact: true })
        .fill('응답이 유실되어도 이 초안을 지켜요.');
      await panel
        .locator('.outline-form')
        .getByRole('button', { name: '저장', exact: true })
        .click();
      await expect(panel.getByRole('button', { name: '요청 결과 확인' })).toBeVisible();
      panel = await open(page, chat.id, width);
      await panel.getByRole('button', { name: '요청 결과 확인' }).click();
      await expect(panel.getByRole('button', { name: '요청 결과 확인' })).toHaveCount(0);
      expect(bodies).toHaveLength(2);
      expect(bodies[1]).toEqual(bodies[0]);
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
        const response = await route.fetch();
        expect(response.ok()).toBe(true);
        if (bodies.length === 1) await route.abort('failed');
        else await route.fulfill({ response });
      });
      let panel = await open(page, chat.id, width);
      await choose(page, '1화 · 열람권의 대가', width);
      await panel.getByRole('button', { name: '이 단위 집필', exact: true }).click();
      await panel.getByRole('button', { name: '집필 시작', exact: true }).click();
      await expect(panel.getByRole('button', { name: '요청 결과 확인' })).toBeVisible();
      await expect.poll(() => sourceCount(request, chat.id)).toBe(1);
      panel = await open(page, chat.id, width);
      await panel.getByRole('button', { name: '요청 결과 확인' }).click();
      await expect(panel).toHaveCount(0);
      expect(bodies).toHaveLength(2);
      expect(bodies[1]).toEqual(bodies[0]);
      expect(await sourceCount(request, chat.id)).toBe(1);
    });

  test(`OUTUI05 ${width} helper handoff preserves selected identity and draft without automatic model execution`, async ({
    page,
    request,
  }, info) => {
    const chat = await seed(request, width);
    const panel = await open(page, chat.id, width);
    await choose(page, '1화 · 열람권의 대가', width);
    const messages: Record<string, unknown>[] = [];
    await page.route('**/api/helper/conversations/*/messages', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      messages.push(route.request().postDataJSON());
      await route.fulfill({ status: 409, json: { error: 'MODEL_REQUIRED:helper' } });
    });
    await panel.getByRole('button', { name: '상세화', exact: true }).click();
    const helper = page.locator('#helper-panel');
    await expect(helper).toBeVisible();
    await expect(helper.locator('.helper-outline-selection')).toContainText('1화 · 열람권의 대가');
    const composer = helper.locator('.helper-composer textarea').last();
    await expect(composer).toHaveValue(/선택한 구성/);
    await composer.fill('내가 미리 작성한 요청을 보존해줘.');
    expect(messages).toHaveLength(0);
    if (width === 1440) await expect(panel).toBeVisible();
    else await expect(panel).toBeHidden();
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.screenshot({ path: info.outputPath(`outline-helper-dark-${width}.png`) });
    await helper.getByRole('button', { name: '구성으로 돌아가기', exact: true }).click();
    await expect(panel).toBeVisible();
    await choose(page, '2화 · 돌아온 출입증', width);
    await panel.getByRole('button', { name: '상세화', exact: true }).click();
    await expect(helper.locator('.helper-outline-selection')).toContainText('2화 · 돌아온 출입증');
    await expect(composer).toHaveValue('내가 미리 작성한 요청을 보존해줘.');
    await composer.press('Control+Enter');
    await expect.poll(() => messages.length).toBe(1);
    const saved: OutlineDetail = await (await request.get(`/api/chats/${chat.id}/outline`)).json();
    const selected = saved.nodes.find((node) => node.title === '2화 · 돌아온 출입증')!;
    expect(messages[0].outline).toEqual({
      nodeId: selected.id,
      expectedRevision: selected.revision,
      purpose: 'compose',
    });
    expect(await sourceCount(request, chat.id)).toBe(0);
  });
  if (width === 1440)
    test(`OUTUI06 ${width} explicit review stays read-only, links its conversation and becomes stale after a plan edit`, async ({
      page,
      request,
    }, info) => {
      const chat = await seed(request, width);
      const previous = await (await request.get('/api/model-workspace')).json();
      // Unlike the main test-mode writer, the helper requires an explicitly selected model.
      // Reuse the existing loopback transport peer; no product-only fixture path is introduced.
      const peer = await loopbackProvider((wire, response) => {
        const input = JSON.parse(wire.body);
        const source = input.input.source.outline.sources[0];
        return writeSse(response, [
          {
            type: 'text_delta',
            delta: `현재 원문의 ${source.id}에서 제공된 ${source.start}–${source.end} 구간을 확인했어요. 이 답변은 UI 연결을 검증하는 합성 점검이에요.`,
          },
          { type: 'usage', inputTokens: 50, outputTokens: 30, costUsd: null },
          { type: 'done', reason: 'stop' },
        ]);
      });
      try {
        const connectionResponse = await request.post('/api/connections', {
          data: {
            title: '구성 점검 합성 연결',
            protocol: 'fixture-sse-v1',
            endpoint: peer.endpoint,
            enabled: true,
          },
        });
        expect(connectionResponse.ok(), await connectionResponse.text()).toBe(true);
        const modelResponse = await request.post('/api/model-presets', {
          data: {
            title: '구성 점검 합성 모델',
            connectionId: (await connectionResponse.json()).id,
            modelId: 'outline-review-fixture',
            inputTokenLimit: 65536,
            maxOutputTokens: 2048,
            temperature: null,
          },
        });
        expect(modelResponse.ok(), await modelResponse.text()).toBe(true);
        const config = await request.put('/api/model-workspace', {
          data: {
            expectedRevision: previous.revision,
            routes: previous.routes,
            translationPolicy: previous.translationPolicy,
            helperModel: { id: (await modelResponse.json()).id },
          },
        });
        expect(config.ok(), await config.text()).toBe(true);
        let panel = await open(page, chat.id, width);
        await choose(page, '1화 · 열람권의 대가', width);
        await panel.getByRole('button', { name: '이 단위 집필', exact: true }).click();
        await panel.getByRole('button', { name: '집필 시작', exact: true }).click();
        await expect.poll(() => sourceCount(request, chat.id)).toBe(1);
        panel = await open(page, chat.id, width);
        await choose(page, '1화 · 열람권의 대가', width);
        await panel.getByRole('button', { name: '원문과 점검', exact: true }).click();
        const helper = page.locator('#helper-panel');
        await expect(helper.locator('.helper-outline-selection')).toContainText('읽기 전용');
        await helper.locator('.helper-composer textarea').last().press('Control+Enter');
        const current = async () =>
          (
            (await (await request.get(`/api/chats/${chat.id}/outline`)).json()) as OutlineDetail
          ).nodes.find((node) => node.title === '1화 · 열람권의 대가')!;
        await expect.poll(async () => (await current()).latestReview?.status).toBe('completed');
        expect(await sourceCount(request, chat.id)).toBe(1);
        await helper.getByRole('button', { name: '구성으로 돌아가기', exact: true }).click();
        await expect(panel.locator('.outline-review')).toContainText('점검 의견 있음');
        const before = await current();
        expect(before.latestReview?.sources).toHaveLength(1);
        expect(before.latestReview?.stale).toBe(false);
        expect(peer.requests).toHaveLength(1);
        const saved = await request.post(`/api/chats/${chat.id}/outline`, {
          data: {
            idempotencyKey: crypto.randomUUID(),
            operations: [
              {
                op: 'update',
                id: before.id,
                expectedRevision: before.revision,
                intent: '점검 이후 사용자가 변경한 현재 계획',
              },
            ],
          },
        });
        expect(saved.ok()).toBe(true);
        await panel.getByRole('button', { name: '새로고침', exact: true }).click();
        await expect(panel.locator('.outline-review')).toContainText('이후 변경됨');
        await page.screenshot({ path: info.outputPath(`outline-review-${width}.png`) });
        await panel.getByRole('button', { name: '도우미에서 점검 의견 보기' }).click();
        await expect(helper).toBeVisible();
        await expect(helper.locator('.helper-messages')).not.toBeEmpty();
      } finally {
        await peer.close();
        const current = await (await request.get('/api/model-workspace')).json();
        const restored = await request.put('/api/model-workspace', {
          data: {
            expectedRevision: current.revision,
            routes: current.routes,
            translationPolicy: current.translationPolicy,
            helperModel: previous.helperModel ?? null,
          },
        });
        expect(restored.ok(), await restored.text()).toBe(true);
      }
    });
}
