import { MOBILE_WIDTH, DESKTOP_WIDTH } from './fixtures/browser-viewports.js';
import { visualReview } from './fixtures/visual-review.js';
import { expect, test as base, type Page } from '@playwright/test';
import type { Chat, ChatDetail } from '../core/types.js';
import type { Content, ModelWorkspace } from '../core/product.js';

// Playwright traces all contexts created through its browser fixture.
const test = base.extend<{ phone: Page; pageErrors: undefined }>({
  pageErrors: [
    async ({ context }, use, info) => {
      const errors: string[] = [];
      context.on('weberror', (event) => errors.push(event.error().message));
      await use(undefined);
      if (errors.length)
        await info.attach('desktop-page-errors', {
          body: JSON.stringify(errors),
          contentType: 'application/json',
        });
      if (info.status === info.expectedStatus) expect(errors).toEqual([]);
    },
    { auto: true },
  ],
  phone: async ({ browser }, use, info) => {
    const context = await browser.newContext({
      baseURL: process.env.UIMORI_BASE_URL,
      ignoreHTTPSErrors: true,
      viewport: { width: MOBILE_WIDTH, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const errors: string[] = [];
    context.on('weberror', (event) => errors.push(event.error().message));
    context.setDefaultTimeout(10_000);
    context.setDefaultNavigationTimeout(15_000);
    try {
      await use(await context.newPage());
    } finally {
      await context.close();
    }
    if (errors.length)
      await info.attach('mobile-page-errors', {
        body: JSON.stringify(errors),
        contentType: 'application/json',
      });
    if (info.status === info.expectedStatus) expect(errors).toEqual([]);
  },
});
async function step<T>(name: string, run: () => Promise<T>): Promise<T> {
  console.log(`SELFHOST_STEP ${name}`);
  return test.step(name, run, { timeout: 20_000 });
}

// This suite needs the authenticated HTTPS fixture and must contribute neither
// skipped tests nor false evidence to ordinary loopback browser regressions.
if (process.env.UIMORI_SELF_HOST_BROWSER === '1')
  test.use({
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
  });
if (process.env.UIMORI_SELF_HOST_BROWSER === '1')
  test.describe('personal self-host HTTPS', () => {
    const origin = process.env.UIMORI_BASE_URL!;
    const token = process.env.UIMORI_ACCESS_TOKEN!;
    const mutationHeaders = { Origin: origin };
    async function login(page: Page, target = '/') {
      await page.goto(new URL(target, origin).href);
      await expect(
        page.getByRole('heading', { name: '개인 작업실에 연결', exact: true })
      ).toBeVisible();
      await page.getByLabel('접속 토큰', { exact: true }).fill(token);
      const accepted = page.waitForResponse(
        (response) =>
          response.url() === `${origin}/api/session` && response.request().method() === 'POST'
      );
      await page.getByRole('button', { name: '작업실 연결', exact: true }).click();
      expect((await accepted).status()).toBe(200);
      await expect(page.getByLabel('접속 토큰', { exact: true })).toHaveCount(0);
    }
    async function assertBrowserSecurity(page: Page) {
      const security = await page.evaluate(
        (accessToken) => ({
          secureContext: window.isSecureContext,
          uuidAvailable:
            typeof crypto.randomUUID === 'function' && /^[a-f0-9-]{36}$/u.test(crypto.randomUUID()),
          readableSession: document.cookie.includes('uimori_session='),
          tokenStored:
            Object.values(localStorage).some((value) => String(value).includes(accessToken)) ||
            Object.values(sessionStorage).some((value) => String(value).includes(accessToken)),
        }),
        token
      );
      expect(security).toEqual({
        secureContext: true,
        uuidAvailable: true,
        readableSession: false,
        tokenStored: false,
      });
      const cookies = await page.context().cookies(origin);
      const session = cookies.find((cookie) => cookie.name === 'uimori_session');
      expect(session).toMatchObject({
        secure: true,
        httpOnly: true,
        sameSite: 'Strict',
        path: '/',
      });
      const remaining = session!.expires - Date.now() / 1000;
      expect(remaining).toBeGreaterThan(399 * 24 * 60 * 60);
      expect(remaining).toBeLessThanOrEqual(400 * 24 * 60 * 60);
    }
    async function assertLiveStream(page: Page, chatId: string) {
      const observation = await page.evaluate(
        (id) =>
          new Promise<{ kind: string; opened: boolean }>((resolve, reject) => {
            let opened = false;
            const stream = new EventSource(`/api/chats/${id}/events`);
            const timer = setTimeout(() => {
              stream.close();
              reject(new Error('HTTPS SSE snapshot timeout'));
            }, 5000);
            stream.onopen = () => {
              opened = true;
            };
            stream.onmessage = (event) => {
              clearTimeout(timer);
              stream.close();
              resolve({ kind: JSON.parse(event.data).kind, opened });
            };
            stream.onerror = () => {
              clearTimeout(timer);
              stream.close();
              reject(new Error('HTTPS SSE connection failed'));
            };
          }),
        chatId
      );
      expect(observation).toEqual({ kind: 'snapshot', opened: true });
      await expect(page.getByText('연결을 다시 확인하는 중이에요.', { exact: true })).toHaveCount(
        0
      );
    }
    async function selectSyntheticMainModel(page: Page) {
      const endpoint = process.env.UIMORI_PROVIDER_FIXTURE_URL;
      if (!endpoint) throw new Error('Owned self-host provider fixture is required');
      const connectionResponse = await page.request.post('/api/connections', {
        headers: mutationHeaders,
        data: {
          title: '합성 HTTPS 본문 연결',
          protocol: 'fixture-sse-v1',
          endpoint,
          enabled: true,
        },
      });
      expect(connectionResponse.ok(), await connectionResponse.text()).toBe(true);
      const connection = (await connectionResponse.json()) as { id: string };
      const modelResponse = await page.request.post('/api/model-presets', {
        headers: mutationHeaders,
        data: {
          title: '합성 HTTPS 본문 모델',
          connectionId: connection.id,
          modelId: 'synthetic-self-host-main',
          maxOutputTokens: 512,
          temperature: null,
        },
      });
      expect(modelResponse.ok(), await modelResponse.text()).toBe(true);
      const model = (await modelResponse.json()) as { id: string };
      const workspace = (await (
        await page.request.get('/api/model-workspace')
      ).json()) as ModelWorkspace;
      const selected = await page.request.put('/api/model-workspace', {
        headers: mutationHeaders,
        data: {
          expectedRevision: workspace.revision,
          routes: { ...workspace.routes, main: { id: model.id } },
          translationPolicy: workspace.translationPolicy,
        },
      });
      expect(selected.ok(), await selected.text()).toBe(true);
      expect(((await selected.json()) as ModelWorkspace).routes.main).toEqual({ id: model.id });
    }

    test('SHUI01 actual HTTPS enforces authentication, exact origin and secure browser sessions', async ({
      page,
      request,
    }, info) => {
      expect((await request.get('/api/chats')).status()).toBe(401);
      expect((await request.get('/api/health')).status()).toBe(401);
      expect((await request.get('/%61pi/library')).status()).toBe(401);
      expect(
        (await request.get('/api/session', { headers: { Host: 'untrusted.invalid' } })).status()
      ).toBe(403);
      expect((await request.post('/api/session', { data: { token } })).status()).toBe(403);
      expect(
        (
          await request.post('/api/session', {
            headers: { Origin: 'https://untrusted.invalid' },
            data: { token },
          })
        ).status()
      ).toBe(403);
      expect(
        (
          await request.post('/api/session', {
            headers: { ...mutationHeaders, 'Sec-Fetch-Site': 'cross-site' },
            data: { token },
          })
        ).status()
      ).toBe(403);
      expect(
        (
          await request.post('/api/session', {
            headers: mutationHeaders,
            data: { token: 'synthetic-invalid-token' },
          })
        ).status()
      ).toBe(401);
      await login(page);
      await assertBrowserSecurity(page);
      expect((await page.request.get('/api/health')).status()).toBe(200);
      expect(
        (
          await page.request.post('/api/test/control', {
            headers: mutationHeaders,
            data: { action: 'hold', barrier: 'run' },
          })
        ).status()
      ).toBe(404);
      const invalid = await page.request.post('/api/chats', {
        headers: { Origin: 'https://untrusted.invalid' },
        data: { title: 'Must never be created' },
      });
      expect(invalid.status()).toBe(403);
      const list = await page.request.get('/api/chats');
      expect(
        ((await list.json()) as Chat[]).some((chat) => chat.title === 'Must never be created')
      ).toBe(false);
      if (visualReview)
        await page.screenshot({ path: info.outputPath('https-authenticated-mobile-library.png') });
      const logout = await page.request.delete('/api/session', {
        headers: mutationHeaders,
        data: {},
      });
      expect(logout.status()).toBe(200);
      expect(logout.headers()['set-cookie']).toContain('Secure');
      expect((await page.request.get('/api/chats')).status()).toBe(401);
      await page.reload();
      await expect(
        page.getByRole('heading', { name: '개인 작업실에 연결', exact: true })
      ).toBeVisible();
    });

    async function createChat(pc: Page): Promise<Chat> {
      await selectSyntheticMainModel(pc);
      const title = `합성 HTTPS 개인 작업실 ${test.info().testId}`;
      const response = await pc.request.post('/api/content', {
        headers: mutationHeaders,
        data: {
          kind: 'bot',
          title: `합성 HTTPS 안내자 ${test.info().testId}`,
          description: 'Public synthetic self-host fixture',
          text: 'A synthetic harbor keeper.',
          loading: 'pinned',
          relatedIds: [],
        },
      });
      expect(response.ok()).toBe(true);
      const bot = (await response.json()) as Content;
      await pc.reload();
      await pc.getByRole('button', { name: `${bot.title} 새 채팅`, exact: true }).click();
      await pc
        .getByRole('dialog', { name: '새 채팅', exact: true })
        .locator('.new-story-options > summary')
        .click();
      await pc.getByLabel('새 채팅 이름', { exact: true }).fill(title);
      const created = pc.waitForResponse(
        (item) =>
          new URL(item.url()).pathname === '/api/chats' && item.request().method() === 'POST'
      );
      await pc.getByRole('button', { name: '채팅 만들기', exact: true }).click();
      const chat = (await (await created).json()) as Chat;
      await expect(pc.getByRole('heading', { name: title, exact: true })).toBeVisible();

      return chat;
    }
    async function generate(page: Page, text: string, count: number) {
      await page.getByLabel('다음 장면 요청', { exact: true }).fill(text);
      await page.getByRole('button', { name: '원문 생성', exact: true }).click();
      await expect(page.getByTestId('source')).toHaveCount(count);
    }
    const detail = async (page: Page, chat: Chat): Promise<ChatDetail> => {
      const response = await page.request.get(`/api/chats/${chat.id}`, { timeout: 10_000 });
      expect(response.status()).toBe(200);
      return response.json();
    };

    test('SHUI02 desktop and mobile share persisted chats and live HTTPS SSE', async ({
      page: pc,
      phone,
    }, info) => {
      test.setTimeout(60_000);
      await pc.setViewportSize({ width: DESKTOP_WIDTH, height: 1000 });
      const chat = await step('create independent chat', async () => {
        await login(pc);
        return createChat(pc);
      });
      await step('connect independent mobile session', async () => {
        await login(phone, `/?chat=${chat.id}`);
        await assertBrowserSecurity(pc);
        await assertBrowserSecurity(phone);
        await assertLiveStream(pc, chat.id);
        await assertLiveStream(phone, chat.id);
        const session = async (p: Page) =>
          (await p.context().cookies(origin)).find((c) => c.name === 'uimori_session')!.value;
        expect(await session(pc)).not.toBe(await session(phone));
      });
      await step('observe the same generated source over mobile SSE without reload', async () => {
        await generate(
          pc,
          'SYNTHETIC_SELF_HOST_FIRST: A sealed letter waits on the harbor desk.',
          1
        );
        await expect(phone.getByTestId('source')).toHaveCount(1);
        const saved = await detail(pc, chat);
        expect(saved.sources).toHaveLength(1);
        await expect(phone.getByTestId('source')).toHaveAttribute(
          'data-source-id',
          saved.sources[0].id
        );
        expect(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true
        );
        if (visualReview)
          await phone.screenshot({ path: info.outputPath('https-mobile-shared-source.png') });
      });
    });

    test('SHUI03 tab re-entry and revoked mobile session preserve desktop and stored results', async ({
      page: pc,
      phone: initialPhone,
    }) => {
      test.setTimeout(60_000);
      let phone = initialPhone;
      await pc.setViewportSize({ width: DESKTOP_WIDTH, height: 1000 });
      const chat = await step('prepare an independent chat and source', async () => {
        await login(pc);
        const chat = await createChat(pc);
        await generate(pc, 'SYNTHETIC_SELF_HOST_REENTRY: A compass waits on the desk.', 1);
        await login(phone, `/?chat=${chat.id}`);
        await expect(phone.getByTestId('source')).toHaveCount(1);
        return chat;
      });
      const saved = await detail(pc, chat);
      await step('close mobile tab, generate, reopen and reload', async () => {
        const mobile = phone.context();
        await phone.close();
        await generate(pc, 'SYNTHETIC_SELF_HOST_SECOND: The keeper opens the letter.', 2);
        phone = await mobile.newPage();
        await phone.goto(`/?chat=${chat.id}`);
        await expect(phone.getByTestId('source')).toHaveCount(2);
        await assertLiveStream(phone, chat.id);
        await assertBrowserSecurity(phone);
        await phone.reload();
        await expect(phone.getByTestId('source')).toHaveCount(2);
      });
      await step('revoke mobile session while UI is open', async () => {
        // Fill while still authenticated. After revocation the gate can remove the
        // composer between awaits; waiting for actionability there used to consume
        // the entire test timeout. The conditional click below is one DOM task.
        await phone
          .getByLabel('다음 장면 요청', { exact: true })
          .fill('SYNTHETIC_EXPIRED_SESSION_MUST_NOT_GENERATE');
        await expect(phone.getByRole('button', { name: '원문 생성', exact: true })).toBeEnabled();
        expect(
          (
            await phone.request.delete('/api/session', {
              headers: mutationHeaders,
              data: {},
              timeout: 10_000,
            })
          ).status()
        ).toBe(200);
        await phone.evaluate(() => {
          const button = [...document.querySelectorAll('button')].find(
            (b) => b.textContent?.trim() === '원문 생성'
          );
          button?.click();
        });
        await expect(
          phone.getByRole('heading', { name: '개인 작업실에 연결', exact: true })
        ).toBeVisible();
        await expect(phone.getByRole('button', { name: '원문 생성', exact: true })).toHaveCount(0);
        const after = await detail(pc, chat);
        expect(after.runs).toHaveLength(2);
        expect(after.sources).toHaveLength(2);
        expect((await pc.request.get('/api/health', { timeout: 10_000 })).status()).toBe(200);
      });
      await step('reauthenticate and verify original source is unchanged', async () => {
        await login(phone, `/?chat=${chat.id}`);
        await expect(phone.getByTestId('source')).toHaveCount(2);
        const final = await detail(pc, chat);
        expect(final.runs).toHaveLength(2);
        expect(final.sources).toHaveLength(2);
        expect(final.sources.find((source) => source.id === saved.sources[0].id)).toEqual(
          saved.sources[0]
        );
      });
    });
  });
