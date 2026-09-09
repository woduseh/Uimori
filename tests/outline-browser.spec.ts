import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import type { Chat, ChatDetail } from '../core/types.js';
import type { OutlineDetail } from '../core/outline.js';
import { postFixtureChat } from './fixtures/chat.js';

const COMPOSITION = [
  {
    op: 'create',
    ref: 'theme',
    level: 'theme',
    title: '잊힌 이름을 되찾는 이야기',
    intent: '기억을 빼앗긴 인물이 자기 이름을 되찾는 과정을 다뤄요.',
  },
  {
    op: 'create',
    ref: 'main',
    parentRef: 'theme',
    level: 'mainStory',
    title: '이름 없는 사서',
    intent: '사서가 도서관 지하에서 자기 이름이 적힌 장부를 찾아요.',
  },
  {
    op: 'create',
    ref: 'arc',
    parentRef: 'main',
    level: 'arc',
    title: '지하 서고의 발견',
    intent: '결말에서 관장이 배신자로 드러나요. 이 사건에서는 아직 감추어요.',
  },
  {
    op: 'create',
    ref: 'ep1',
    parentRef: 'arc',
    level: 'episode',
    title: '1화 잠긴 문',
    intent: '사서가 지하 서고의 잠긴 문을 발견해요.',
  },
  {
    op: 'create',
    ref: 'beat1',
    parentRef: 'ep1',
    level: 'beat',
    title: '열쇠 없는 자물쇠',
    intent: '자물쇠에 열쇠 구멍이 없다는 것을 알아채요.',
  },
  {
    op: 'create',
    ref: 'ep2',
    parentRef: 'arc',
    level: 'episode',
    title: '2화 장부의 첫 장',
    intent: '문을 열고 장부의 첫 장을 읽어요.',
  },
];

async function seed(request: APIRequestContext, width: number) {
  const response = await postFixtureChat(request, { data: { title: `계층형 구성 합성 ${width}` } });
  expect(response.ok()).toBe(true);
  const chat: Chat = await response.json();
  const applied = await request.post(`/api/chats/${chat.id}/outline`, {
    data: { idempotencyKey: crypto.randomUUID(), operations: COMPOSITION },
  });
  expect(applied.ok(), await applied.text()).toBe(true);
  return chat;
}
async function openOutline(page: Page, chatId: string) {
  await page.goto(`/?chat=${chatId}`);
  return revealOutline(page);
}
async function revealOutline(page: Page) {
  await page.locator('.chat-menu').getByLabel('채팅 메뉴').click();
  await page
    .locator('.chat-menu .action-menu-body')
    .getByRole('button', { name: '계층형 구성', exact: true })
    .click();
  const panel = page.locator('.outline-panel');
  await expect(panel).toBeVisible();
  return panel;
}
const entry = (page: Page, title: string) =>
  page
    .locator('.outline-entry')
    .filter({ has: page.locator(`:scope > .outline-row .outline-title:text-is("${title}")`) })
    .first();
function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

for (const width of [390, 1440]) {
  test(`OUTUI03 ${width} confirms a committed save after response loss without duplicate nodes or losing a later draft`, async ({
    page,
    request,
  }) => {
    const chat = await seed(request, width);
    await page.setViewportSize({ width, height: 900 });
    let lost = false;
    const bodies: unknown[] = [];
    await page.route(`**/api/chats/${chat.id}/outline`, async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      bodies.push(route.request().postDataJSON());
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      if (!lost) {
        lost = true;
        await route.abort('failed');
      } else await route.fulfill({ response });
    });
    let panel = await openOutline(page, chat.id);
    await panel.getByRole('button', { name: '전체 주제 추가', exact: true }).click();
    const form = panel.locator('> .outline-form');
    await form.getByLabel('전체 주제 이름').fill('유실 응답의 주제');
    await form.getByRole('button', { name: '추가', exact: true }).click();
    await expect(panel.getByRole('button', { name: '요청 결과 확인' })).toBeVisible();
    await expect(form.getByLabel('전체 주제 이름')).toHaveValue('유실 응답의 주제');
    await expect(form.getByLabel('전체 주제 이름')).toBeDisabled();
    panel = await openOutline(page, chat.id); // A reload must keep the original request body.
    await panel.getByRole('button', { name: '요청 결과 확인' }).click();
    await expect(panel.locator('.outline-title:text-is("유실 응답의 주제")')).toHaveCount(1);
    await expect(panel.getByRole('button', { name: '요청 결과 확인' })).toHaveCount(0);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual(bodies[0]);
    const saved: OutlineDetail = await (await request.get(`/api/chats/${chat.id}/outline`)).json();
    expect(saved.nodes).toHaveLength(COMPOSITION.length + 1);

    // Once POST succeeds its tree is authoritative even when a following GET would fail.
    await page.unroute(`**/api/chats/${chat.id}/outline`);
    let afterSaveReads = 0;
    await page.route(`**/api/chats/${chat.id}/outline*`, async (route) => {
      if (route.request().method() === 'GET') {
        afterSaveReads++;
        await route.fulfill({ status: 503, json: { error: 'fixture read unavailable' } });
      } else await route.continue();
    });
    const target = entry(page, '2화 장부의 첫 장');
    await target
      .locator('> .outline-row')
      .getByRole('button', { name: '구성 수정', exact: true })
      .click();
    await target.locator('.outline-form textarea').first().fill('POST로 확정한 새 의도');
    await target
      .locator('.outline-form')
      .getByRole('button', { name: '저장', exact: true })
      .click();
    await expect(target.locator('> .outline-intent')).toHaveText('POST로 확정한 새 의도');
    expect(afterSaveReads).toBe(0);
    await page.unroute(`**/api/chats/${chat.id}/outline*`);
    await target
      .locator('> .outline-row')
      .getByRole('button', { name: '구성 수정', exact: true })
      .click();
    await target.locator('.outline-form textarea').first().fill('닫아도 보존하는 미저장 의도');
    await openOutline(page, chat.id);
    const reopened = entry(page, '2화 장부의 첫 장');
    await reopened
      .locator('> .outline-row')
      .getByRole('button', { name: '구성 수정', exact: true })
      .click();
    await expect(reopened.locator('.outline-form textarea').first()).toHaveValue(
      '닫아도 보존하는 미저장 의도'
    );
    const current: OutlineDetail = await (
      await request.get(`/api/chats/${chat.id}/outline`)
    ).json();
    const node = current.nodes.find((item) => item.title === '2화 장부의 첫 장')!;
    expect(
      (
        await request.post(`/api/chats/${chat.id}/outline`, {
          data: {
            idempotencyKey: crypto.randomUUID(),
            operations: [
              {
                op: 'update',
                id: node.id,
                expectedRevision: node.revision,
                intent: '다른 탭의 확정 의도',
              },
            ],
          },
        })
      ).ok()
    ).toBe(true);
    await reopened
      .locator('.outline-form')
      .getByRole('button', { name: '저장', exact: true })
      .click();
    await expect(page.locator('.outline-panel').getByRole('alert')).toBeVisible();
    await expect(reopened.locator('.outline-form textarea').first()).toHaveValue(
      '닫아도 보존하는 미저장 의도'
    );
    const afterConflict: OutlineDetail = await (
      await request.get(`/api/chats/${chat.id}/outline`)
    ).json();
    expect(afterConflict.nodes.find((item) => item.id === node.id)?.intent).toBe(
      '다른 탭의 확정 의도'
    );
    await reopened
      .locator('.outline-form')
      .getByRole('button', { name: '취소', exact: true })
      .click();
    // Closing a modal leaves its fetch alive. That late result must not clear a newer receipt.
    const accepted = barrier();
    const release = barrier();
    const delivered = barrier();
    const requests: { idempotencyKey: string }[] = [];
    await page.route(`**/api/chats/${chat.id}/outline`, async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      requests.push(route.request().postDataJSON());
      const index = requests.length;
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      if (index === 1) {
        accepted.resolve();
        await release.promise;
        await route.fulfill({ response });
        delivered.resolve();
      } else if (index === 3) await route.abort('failed');
      else await route.fulfill({ response });
    });
    try {
      await panel.getByRole('button', { name: '전체 주제 추가', exact: true }).click();
      await panel.locator('> .outline-form').getByLabel('전체 주제 이름').fill('늦게 응답한 저장');
      await panel
        .locator('> .outline-form')
        .getByRole('button', { name: '추가', exact: true })
        .click();
      await accepted.promise;
      await page.getByRole('button', { name: '계층형 구성 닫기', exact: true }).click();
      panel = await revealOutline(page);
      await panel.getByRole('button', { name: '요청 결과 확인' }).click();
      await expect(panel.getByRole('button', { name: '요청 결과 확인' })).toHaveCount(0);
      await panel.getByRole('button', { name: '전체 주제 추가', exact: true }).click();
      await panel
        .locator('> .outline-form')
        .getByLabel('전체 주제 이름')
        .fill('새 요청의 복구 기록');
      await panel
        .locator('> .outline-form')
        .getByRole('button', { name: '추가', exact: true })
        .click();
      await expect(panel.getByRole('button', { name: '요청 결과 확인' })).toBeVisible();
      release.resolve();
      await delivered.promise;
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
          )
      );
      const pending = await page.evaluate(() =>
        Object.keys(sessionStorage)
          .filter((key) => key.startsWith('outline-pending:') && !key.includes(':draft:'))
          .map((key) => JSON.parse(sessionStorage.getItem(key)!))
      );
      expect(pending).toEqual([
        expect.objectContaining({
          body: expect.objectContaining({ idempotencyKey: requests[2].idempotencyKey }),
        }),
      ]);
      await panel.getByRole('button', { name: '요청 결과 확인' }).click();
      await expect(panel.getByRole('button', { name: '요청 결과 확인' })).toHaveCount(0);
      await expect(panel.locator('.outline-title:text-is("새 요청의 복구 기록")')).toHaveCount(1);
    } finally {
      release.resolve();
    }
  });

  test(`OUTUI04 ${width} confirms a lost run response after reload with the original revisions and no second run`, async ({
    page,
    request,
  }) => {
    const chat = await seed(request, width);
    await page.setViewportSize({ width, height: 900 });
    const bodies: unknown[] = [];
    await page.route('**/api/scene-commands/*/run', async (route) => {
      bodies.push(route.request().postDataJSON());
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      if (bodies.length === 1) await route.abort('failed');
      else await route.fulfill({ response });
    });
    await openOutline(page, chat.id);
    await entry(page, '1화 잠긴 문').locator('> .outline-row .outline-write').click();
    await expect(
      page.locator('.outline-panel').getByRole('button', { name: '요청 결과 확인' })
    ).toBeVisible();
    await expect
      .poll(async () => {
        const detail: ChatDetail = await (await request.get(`/api/chats/${chat.id}`)).json();
        return detail.sources.length;
      })
      .toBe(1);
    const panel = await openOutline(page, chat.id);
    await expect(entry(page, '1화 잠긴 문').locator('> .outline-row .outline-progress')).toHaveText(
      '집필 완료'
    );
    await panel.getByRole('button', { name: '요청 결과 확인' }).click();
    await expect(panel).toHaveCount(0);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual(bodies[0]);
    const detail: ChatDetail = await (await request.get(`/api/chats/${chat.id}`)).json();
    expect(detail.runs).toHaveLength(1);
    expect(detail.sources).toHaveLength(1);
  });

  test(`OUTUI01 ${width} shows every composition level, its own plan and where writing is possible`, async ({
    page,
    request,
  }, info) => {
    const chat = await seed(request, width);
    await page.setViewportSize({ width, height: 900 });
    const panel = await openOutline(page, chat.id);

    for (const [title, level] of [
      ['잊힌 이름을 되찾는 이야기', '전체 주제'],
      ['이름 없는 사서', '메인 스토리'],
      ['지하 서고의 발견', '큰 사건'],
      ['1화 잠긴 문', '회차'],
      ['열쇠 없는 자물쇠', '작은 사건'],
    ] as const) {
      const row = entry(page, title).locator('> .outline-row');
      await expect(row.locator('.outline-level')).toHaveText(level);
      await expect(row.locator('.outline-progress')).toHaveText('구성만 있어요');
    }
    // The composed hierarchy is real nesting, not a flat list.
    await expect(
      entry(page, '지하 서고의 발견').locator('.outline-title:text-is("1화 잠긴 문")')
    ).toBeVisible();
    // Only a unit one request can write offers writing.
    await expect(
      entry(page, '지하 서고의 발견').locator('> .outline-row .outline-write')
    ).toHaveCount(0);
    await expect(entry(page, '1화 잠긴 문').locator('> .outline-row .outline-write')).toHaveCount(
      1
    );
    await expect(
      entry(page, '열쇠 없는 자물쇠').locator('> .outline-row .outline-write')
    ).toHaveCount(1);
    // Composing alone commits no prose.
    await expect(page.getByTestId('source')).toHaveCount(0);

    expect(await panel.evaluate((el) => el.scrollWidth - el.clientWidth)).toBe(0);
    expect(await page.evaluate(() => document.body.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`outline-panel-${width}.png`) });

    // A user edit reaches the named target and leaves the rest of the composition alone.
    const target = entry(page, '2화 장부의 첫 장');
    await target.locator('> .outline-row').getByRole('button', { name: '구성 수정' }).click();
    const intent = target.locator('.outline-form textarea').first();
    await intent.fill('');
    await intent.click();
    // Typed one key at a time: the editor must keep focus and every character.
    await intent.pressSequentially('관장 대신 조수가 찾아와요.');
    await expect(intent).toBeFocused();
    await expect(intent).toHaveValue('관장 대신 조수가 찾아와요.');
    await target
      .locator('> .outline-row')
      .getByRole('button', { name: '이 구성 고정', exact: true })
      .click();
    await expect(
      target.locator('> .outline-row').getByRole('button', { name: '고정 해제', exact: true })
    ).toBeEnabled();
    await expect(intent).toHaveValue('관장 대신 조수가 찾아와요.');
    await target.locator('.outline-form').getByRole('button', { name: '저장' }).click();
    await expect(target.locator('> .outline-intent')).toHaveText('관장 대신 조수가 찾아와요.');
    await expect(entry(page, '1화 잠긴 문').locator('> .outline-intent')).toHaveText(
      '사서가 지하 서고의 잠긴 문을 발견해요.'
    );

    // Adding a level below keeps the same typing guarantee and the level rule.
    await target.locator('> .outline-row').getByRole('button', { name: '작은 사건 추가' }).click();
    const added = target.locator('.outline-form').first();
    await added.locator('input').click();
    await added.locator('input').pressSequentially('장부의 첫 문장');
    await expect(added.locator('input')).toBeFocused();
    await added.getByRole('button', { name: '추가' }).click();
    const beat = entry(page, '장부의 첫 문장');
    await expect(beat.locator('> .outline-row .outline-level')).toHaveText('작은 사건');
    await expect(target.locator('.outline-title:text-is("장부의 첫 문장")')).toBeVisible();
  });

  test(`OUTUI02 ${width} writes only the chosen unit and carries the upper intent into that request`, async ({
    page,
    request,
  }, info) => {
    const chat = await seed(request, width);
    await page.setViewportSize({ width, height: 900 });
    await openOutline(page, chat.id);
    await entry(page, '1화 잠긴 문')
      .locator('> .outline-row')
      .getByRole('button', { name: '이 단위 집필' })
      .click();
    await expect(page.locator('.outline-panel')).toHaveCount(0);
    await expect(page.getByTestId('source')).toHaveCount(1);

    const detail: ChatDetail = await (await request.get(`/api/chats/${chat.id}`)).json();
    expect(detail.sources).toHaveLength(1);
    const run = detail.runs.find((item) => item.sourceRevision === detail.sources[0].id);
    expect(run?.request).toContain('1화 잠긴 문');
    // The applied composition is auditable in the frozen execution input.
    const outline = run?.snapshot.outline;
    expect(outline?.path.map((item) => item.level)).toEqual([
      'theme',
      'mainStory',
      'arc',
      'episode',
    ]);
    expect(outline?.path.at(-1)?.title).toBe('1화 잠긴 문');
    expect(outline?.children.map((item) => item.title)).toEqual(['열쇠 없는 자물쇠']);
    expect(JSON.stringify(outline)).not.toContain('2화 장부의 첫 장');
    expect(run?.inputs?.[0]?.contract).toContain('planning, not story that already happened');

    const composed = await openOutline(page, chat.id);
    await expect(entry(page, '1화 잠긴 문').locator('> .outline-row .outline-progress')).toHaveText(
      '집필 완료'
    );
    // A one-unit request never writes the other episodes.
    await expect(
      entry(page, '2화 장부의 첫 장').locator('> .outline-row .outline-progress')
    ).toHaveText('구성만 있어요');
    await page.screenshot({ path: info.outputPath(`outline-written-${width}.png`) });

    const after: OutlineDetail = await (await request.get(`/api/chats/${chat.id}/outline`)).json();
    expect(
      after.nodes.filter((node) => node.progress.state === 'written').map((node) => node.title)
    ).toEqual(['1화 잠긴 문']);
    await composed.getByRole('button', { name: '집필한 원문 읽기' }).click();
    await expect(page.locator('.outline-panel')).toHaveCount(0);
    await expect(page.getByTestId('source')).toHaveCount(1);
  });
}
