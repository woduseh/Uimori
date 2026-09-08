import { expect, test, type Page } from '@playwright/test';
import type { Chat, ChatDetail } from '../core/types.js';
import type { Content } from '../core/product.js';

// This suite needs the authenticated HTTPS fixture and must contribute neither
// skipped tests nor false evidence to ordinary loopback browser regressions.
if (process.env.NR_SELF_HOST_BROWSER === '1') test.use({ ignoreHTTPSErrors: true, trace: 'off' });
if (process.env.NR_SELF_HOST_BROWSER === '1')
  test.describe('personal self-host HTTPS', () => {
    const origin = process.env.NR_BASE_URL!;
    const token = process.env.NR_ACCESS_TOKEN!;
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
          readableSession: document.cookie.includes('nr_session='),
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
      const session = cookies.find((cookie) => cookie.name === 'nr_session');
      expect(session).toMatchObject({
        secure: true,
        httpOnly: true,
        sameSite: 'Strict',
        path: '/',
      });
      expect(session!.expires - Date.now() / 1000).toBeGreaterThan(43_000);
      expect(session!.expires - Date.now() / 1000).toBeLessThanOrEqual(43_200);
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

    test('SHUI01 actual HTTPS enforces authentication, exact origin and secure browser sessions', async ({
      page,
      request,
    }, info) => {
      expect((await request.get('/api/chats')).status()).toBe(401);
      expect((await request.get('/api/health')).status()).toBe(401);
      expect((await request.get('/%61pi/library')).status()).toBe(401);
      expect((await request.get('/%61pi/export')).status()).toBe(401);
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

    test('SHUI02 desktop and 390px mobile share persisted chats and live HTTPS SSE across re-entry', async ({
      browser,
    }, info) => {
      test.setTimeout(60_000);
      const desktop = await browser.newContext({
        baseURL: origin,
        ignoreHTTPSErrors: true,
        viewport: { width: 1440, height: 1000 },
      });
      const mobile = await browser.newContext({
        baseURL: origin,
        ignoreHTTPSErrors: true,
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      });
      const errors: string[] = [];
      const pc = await desktop.newPage();
      pc.on('pageerror', (error) => errors.push(error.message));
      let phone = await mobile.newPage();
      phone.on('pageerror', (error) => errors.push(error.message));
      try {
        await login(pc);
        const title = '합성 HTTPS 개인 작업실';
        const response = await pc.request.post('/api/content', {
          headers: mutationHeaders,
          data: {
            kind: 'bot',
            title: '합성 HTTPS 안내자',
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
        await assertBrowserSecurity(pc);
        await assertLiveStream(pc, chat.id);
        await login(phone, `/?chat=${chat.id}`);
        await expect(phone.getByRole('heading', { name: title, exact: true })).toBeVisible();
        await assertBrowserSecurity(phone);
        await assertLiveStream(phone, chat.id);
        const pcSession = (await desktop.cookies(origin)).find(
          (cookie) => cookie.name === 'nr_session'
        )!;
        const phoneSession = (await mobile.cookies(origin)).find(
          (cookie) => cookie.name === 'nr_session'
        )!;
        expect(pcSession.value).not.toBe(phoneSession.value);

        await pc
          .getByLabel('다음 장면 요청', { exact: true })
          .fill('SYNTHETIC_SELF_HOST_FIRST: A sealed letter waits on the harbor desk.');
        await pc.getByRole('button', { name: '원문 생성', exact: true }).click();
        await expect(pc.getByTestId('source')).toHaveCount(1);
        await expect(phone.getByTestId('source')).toHaveCount(1); // SSE update, no reload or navigation.
        const saved = (await (await pc.request.get(`/api/chats/${chat.id}`)).json()) as ChatDetail;
        expect(saved.sources).toHaveLength(1);
        const sourceId = saved.sources[0].id;
        await expect(phone.getByTestId('source')).toHaveAttribute('data-source-id', sourceId);
        expect(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true
        );
        await phone.screenshot({ path: info.outputPath('https-mobile-shared-source-390.png') });
        await pc.screenshot({ path: info.outputPath('https-desktop-shared-source.png') });

        await phone.close();
        await pc
          .getByLabel('다음 장면 요청', { exact: true })
          .fill('SYNTHETIC_SELF_HOST_SECOND: The keeper places a brass compass beside the letter.');
        await pc.getByRole('button', { name: '원문 생성', exact: true }).click();
        await expect(pc.getByTestId('source')).toHaveCount(2);
        phone = await mobile.newPage();
        phone.on('pageerror', (error) => errors.push(error.message));
        await phone.goto(`/?chat=${chat.id}`);
        await expect(phone.getByTestId('source')).toHaveCount(2);
        await assertLiveStream(phone, chat.id);
        await assertBrowserSecurity(phone);
        await phone.reload();
        await expect(phone.getByTestId('source')).toHaveCount(2);

        // Invalidate this device's server session while its UI remains open. The
        // next protected UI request must return it to login, without affecting PC.
        expect(
          (
            await phone.request.delete('/api/session', { headers: mutationHeaders, data: {} })
          ).status()
        ).toBe(200);
        await phone
          .getByLabel('다음 장면 요청', { exact: true })
          .fill('SYNTHETIC_EXPIRED_SESSION_MUST_NOT_GENERATE');
        await phone.getByRole('button', { name: '원문 생성', exact: true }).click();
        await expect(
          phone.getByRole('heading', { name: '개인 작업실에 연결', exact: true })
        ).toBeVisible();
        expect((await pc.request.get('/api/health')).status()).toBe(200);
        await login(phone, `/?chat=${chat.id}`);
        await expect(phone.getByTestId('source')).toHaveCount(2);
        const final = (await (await pc.request.get(`/api/chats/${chat.id}`)).json()) as ChatDetail;
        expect(final.runs).toHaveLength(2);
        expect(final.sources).toHaveLength(2);
        expect(final.sources.find((source) => source.id === sourceId)).toEqual(saved.sources[0]);
        expect(errors).toEqual([]);
        await info.attach('https-browser-observations', {
          contentType: 'application/json',
          body: JSON.stringify(
            {
              chatId: chat.id,
              firstSourceId: sourceId,
              sourceCount: final.sources.length,
              independentSessions: true,
              liveMobileSseUpdate: true,
              tabReentry: true,
              sessionReauthentication: true,
              viewport: { width: 390, height: 844 },
              browserErrors: errors,
            },
            null,
            2
          ),
        });
      } finally {
        await mobile.close();
        await desktop.close();
      }
    });
  });
