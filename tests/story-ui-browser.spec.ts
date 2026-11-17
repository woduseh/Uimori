import { expect, test } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
let server: ViteDevServer;
let origin: string;
test.beforeAll(async () => {
  server = await createServer({
    configFile: false,
    root: process.cwd(),
    appType: 'custom',
    plugins: [react()],
    optimizeDeps: {
      noDiscovery: true,
      include: [
        'react',
        'react-dom/client',
        'dompurify',
        'markdown-it',
        '@a2ui/react',
        '@a2ui/web_core',
        '@a2ui/web_core/catalogs/basic/v1',
        'zod',
        'intl-messageformat',
      ],
    },
    server: { host: '127.0.0.1', port: 0, watch: { ignored: ['**/output/**'] } },
  });
  server.middlewares.use(async (request, response, next) => {
    if (request.url !== '/') return next();
    response.setHeader('Content-Type', 'text/html');
    response.end(
      await server.transformIndexHtml(
        '/',
        '<!doctype html><html><body><main id="mount"></main></body></html>'
      )
    );
  });
  await server.listen();
  origin = server.resolvedUrls!.local[0]!;
});
test.afterAll(async () => {
  await server.close();
});
test('renders tabs and labelled input with keyboard navigation', async ({ page }) => {
  await page.goto(origin);
  await page.evaluate(async () => {
    const path = '/tests/fixtures/story-ui.tsx';
    const fixture = await import(path);
    fixture.mountStoryUi(document.getElementById('mount'));
  });
  await expect(page.getByText('첫 화면')).toBeVisible();
  const first = page.getByRole('tab', { name: '첫째' });
  await first.focus();
  await first.press('ArrowRight');
  await expect(page.getByRole('tab', { name: '둘째' })).toBeFocused();
  await expect(page.getByText('다음 화면')).toBeVisible();
  await page.getByLabel('이름').fill('시아');
  await expect(page.getByLabel('이름')).toHaveValue('시아');
  await page.screenshot({ path: 'output/story-ui-browser.png' });
});

test('renders bound image lists and icons without fetching edited external URLs', async ({
  page,
}) => {
  const { normalizeStoryUiOutput } = await import('../server/story-ui.js');
  const source = normalizeStoryUiOutput(`<a2ui>
$/people = [{name: "미라", portrait: "/api/assets/mira", icon: "person"}, {name: "솔", portrait: "/api/assets/sol", icon: "home"}]
$/portrait = "/api/assets/selected"
item = Row([Image($portrait, description=$name, variant="avatar"), Icon($icon), Text($name)])
root = Column([List(_template($/people, item)), TextField("첫 아이콘", $/people/0/icon), TextField("초상화 경로", $/portrait), Image($/portrait, description="선택한 초상화", fit="scaleDown")])
</a2ui>`);
  const remoteRequests: string[] = [];
  await page.route('**/api/{assets,package-image-blobs}/*', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#507ba8"/></svg>',
    })
  );
  await page.route('https://outside.invalid/**', (route) => {
    remoteRequests.push(route.request().url());
    return route.abort();
  });
  await page.goto(origin);
  await page.evaluate(async (text) => {
    const path = '/tests/fixtures/story-ui-images.tsx';
    (await import(path)).mountImages(document.getElementById('mount'), text);
  }, source);
  await expect(page.getByRole('img', { name: '미라', exact: true })).toHaveAttribute(
    'src',
    '/api/assets/mira'
  );
  await expect(page.getByRole('img', { name: '솔', exact: true })).toHaveAttribute(
    'src',
    '/api/assets/sol'
  );
  await expect(page.locator('svg.lucide')).toHaveCount(2);
  await expect(page.locator('svg.lucide-user-round')).toBeVisible();
  await expect(page.locator('svg.lucide-house')).toBeVisible();
  await expect(page.getByText('person', { exact: true })).toHaveCount(0);
  await page.getByLabel('첫 아이콘').fill('warning');
  await expect(page.locator('svg.lucide-triangle-alert')).toBeVisible();
  await expect(page.locator('svg.lucide-user-round')).toHaveCount(0);
  const selected = page.getByRole('img', { name: '선택한 초상화', exact: true });
  await expect(selected).toHaveCSS('object-fit', 'scale-down');
  await page.getByLabel('초상화 경로').fill('https://outside.invalid/portrait.png');
  await expect(selected).not.toHaveAttribute('src');
  await page.getByLabel('초상화 경로').fill('/api/package-image-blobs/changed');
  await expect(selected).toHaveAttribute('src', '/api/package-image-blobs/changed');
  expect(remoteRequests).toEqual([]);
  await page.screenshot({ path: 'output/story-ui-bound-images.png' });
});

test('reader submits its authored event through the real action route', async ({ page }) => {
  const { createApp } = await import('../server/app.js');
  const { importChatTranscript } = await import('../server/chat-transcript.js');
  const { fixtureBotInput } = await import('./fixtures/chat.js');
  const { normalizeStoryUiOutput } = await import('../server/story-ui.js');
  const { randomUUID } = await import('node:crypto');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = mkdtempSync(join(tmpdir(), 'uimori-story-ui-browser-'));
  const app = await createApp({
    dbPath: join(directory, 'app.sqlite'),
    buildId: 'story-ui-browser',
    testMode: true,
    codex: { enabled: false },
  });
  try {
    const bot = app.store.product.content(fixtureBotInput());
    const text = normalizeStoryUiOutput(
      '문이 열린다.\n\n<a2ui>root = Column([TextField("쪽지", $/note), Button(Text("보내기"), action=Event("send", {note: $/note}))])</a2ui>\n\n복도는 조용하다.'
    );
    const imported = importChatTranscript(app.store, {
      idempotencyKey: randomUUID(),
      transcript: {
        format: 'uimori-chat-transcript',
        version: 2,
        exportedAt: new Date().toISOString(),
        title: '편지',
        packageAttachments: [{ id: bot.id, revision: bot.revision, role: 'bot' }],
        notes: [],
        entries: [{ request: '문을 연다', text, translation: null }],
      },
    }).chat;
    const chat = app.store.settings(imported.id, imported.settingsRevision, {
      ...imported.settings,
      storyUi: true,
    });
    const source = app.store.source(chat.headRevision!);
    app.controls.hold('run');
    let responseStatus = 0;
    await page.route('**/api/**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const response = await app.inject({
        method: request.method() as 'GET' | 'POST',
        url: url.pathname + url.search,
        payload: request.postData() ?? undefined,
        headers: request.postData() ? { 'content-type': 'application/json' } : undefined,
      });
      if (url.pathname.endsWith('/story-ui/actions')) responseStatus = response.statusCode;
      await route.fulfill({
        status: response.statusCode,
        body: response.body,
        contentType: 'application/json',
      });
    });
    await page.goto(origin);
    await page.evaluate(async (value) => {
      const path = '/tests/fixtures/story-ui.tsx';
      const fixture = await import(path);
      await fixture.mountReader(document.getElementById('mount'), value);
    }, source);
    await expect(page.getByText('문이 열린다.')).toBeVisible();
    await expect(page.getByText('복도는 조용하다.')).toBeVisible();
    await page.getByLabel('쪽지').fill('안녕');
    await page.getByRole('button', { name: '보내기' }).first().click();
    await page.getByRole('button', { name: '보내기' }).last().click();
    await expect.poll(() => responseStatus).toBe(200);
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('charts show positive and negative values on their proper sides', async ({ page }) => {
  await page.goto(origin);
  await page.evaluate(async () => {
    const path = '/tests/fixtures/story-ui.tsx';
    (await import(path)).mountCharts(document.getElementById('mount'));
  });
  const line = page.getByRole('img', { name: '밤: -10, 낮: 20' });
  await expect(line.locator('polyline')).toHaveAttribute('points', '0,90 100,10');
  const tracks = page.locator('.story-ui-bar-track');
  const negative = await tracks
    .nth(0)
    .locator('.story-ui-bar')
    .evaluate((bar) => ({
      left: (bar as HTMLElement).style.left,
      width: (bar as HTMLElement).style.width,
    }));
  const positive = await tracks
    .nth(1)
    .locator('.story-ui-bar')
    .evaluate((bar) => ({
      left: (bar as HTMLElement).style.left,
      width: (bar as HTMLElement).style.width,
    }));
  expect(Number.parseFloat(negative.left)).toBe(0);
  expect(Number.parseFloat(negative.width)).toBeCloseTo(100 / 3);
  expect(Number.parseFloat(positive.left)).toBeCloseTo(100 / 3);
  expect(Number.parseFloat(positive.width)).toBeCloseTo(200 / 3);
});

test('completed streamed UI remains visible as subsequent prose arrives', async ({ page }) => {
  const { normalizeStoryUiOutput } = await import('../server/story-ui.js');
  const block = '<a2ui>root = Text("상태 표시")</a2ui>';
  const opening = 'Before the quiet harbor opened. '.repeat(700);
  const continuation = `${'After the fishing ship returned. '.repeat(700)}The harbor is quiet again.`;
  let requests = 0;
  await page.route('**/api/story-ui/preview', async (route) => {
    requests++;
    await route.fulfill({ json: { text: normalizeStoryUiOutput(block) } });
  });
  await page.goto(origin);
  await page.evaluate(async (value) => {
    const path = '/tests/fixtures/story-ui.tsx';
    (window as any).showStream = await (await import(path)).mountStreaming(
      document.getElementById('mount'),
      value,
      'modern'
    );
  }, `${opening}\n\n${block}`);
  await expect(page.getByText('상태 표시')).toBeVisible();
  await expect(page.locator('.story-ui')).toHaveAttribute('data-story-ui-style', 'modern');
  await page.evaluate(
    (value) => (window as any).showStream(value),
    `${opening}\n\n${block}\n\n${continuation}`
  );
  await expect(page.getByText('상태 표시')).toBeVisible();
  await expect(page.getByText('The harbor is quiet again.')).toBeVisible();
  await expect(page.locator('body')).not.toContainText('<a2ui>');
  expect(requests).toBe(1);
});

test('switches original and translated UI when both start at the same offset', async ({ page }) => {
  const { normalizeStoryUiOutput } = await import('../server/story-ui.js');
  const { parseStoryUi, encodeStoryUi } = await import('../core/story-ui.js');
  const original = normalizeStoryUiOutput(
    '<a2ui>root = Column([Text("Original"), TextField("Draft", $/draft)])</a2ui>'
  );
  const part = parseStoryUi(original).find((item) => item.kind === 'ui');
  if (!part || part.kind !== 'ui') throw new Error('invalid fixture');
  const messages = structuredClone(part.messages);
  const message = messages[0] as any;
  message.createSurface.components.find(
    (component: { component: string }) => component.component === 'Text'
  ).text = '번역 문구';
  const translated = encodeStoryUi(part.expression, messages);
  const source = {
    id: 'translation-source',
    chatId: 'chat',
    parentRevision: null,
    runId: 'run',
    text: original,
    hash: 'hash',
  };
  const jobs = [
    {
      id: 'translation-job',
      chatId: 'chat',
      sourceRevision: source.id,
      sourceHash: source.hash,
      kind: 'translation',
      status: 'completed',
      attempt: 1,
      error: null,
      result: { mock: false, text: translated, sourceRevision: source.id, sourceHash: source.hash },
    },
  ];
  await page.goto(origin);
  await page.evaluate(
    async (values) => {
      localStorage.setItem('uimori:reading-language', 'original');
      const path = '/tests/fixtures/story-ui.tsx';
      await (await import(path)).mountReader(
        document.getElementById('mount'),
        values.source,
        values.jobs
      );
    },
    { source, jobs }
  );
  await expect(page.getByText('Original', { exact: true })).toBeVisible();
  await page.getByLabel('Draft', { exact: true }).fill('아직 보내지 않은 답장');
  await page.getByRole('button', { name: '번역 보기' }).click();
  await expect(page.getByText('번역 문구', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Draft', { exact: true })).toHaveValue('아직 보내지 않은 답장');
  await page.getByRole('button', { name: '원문 보기' }).click();
  await expect(page.getByText('Original', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Draft', { exact: true })).toHaveValue('아직 보내지 않은 답장');
});

test('presets reach SDK components and streaming surfaces at desktop and mobile widths', async ({
  page,
}) => {
  for (const width of [1100, 390]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(origin);
    await page.evaluate(async () => {
      const path = '/tests/fixtures/story-ui.tsx';
      const fixture = await import(path);
      fixture.mountStoryUi(document.getElementById('mount')!, 'fantasy');
    });
    const surface = page.locator('.story-ui');
    await expect(surface.getByText('첫 화면')).toBeVisible();
    await expect(surface).toHaveCSS('background-color', 'rgb(239, 227, 198)');
    const sdkText = surface.getByText('첫 화면');
    await expect(sdkText).toHaveCSS('color', 'rgb(56, 43, 32)');
    await page.screenshot({ path: `output/story-ui-preset-${width}.png` });
  }
});

test('story UI presets keep their controls usable at desktop and mobile widths', async ({
  page,
}) => {
  for (const width of [1100, 390]) {
    for (const style of ['default', 'east-asian', 'fantasy', 'modern', 'period', 'blue-archive']) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(origin);
      await page.addStyleTag({
        content:
          ':root{--text:#263445;--panel:#fff;--border:#ccd3da;--accent:#2864a0;--accent-ink:#fff;--input-bg:#fff}body{margin:0;background:#e5ebef;font-family:system-ui,sans-serif}main{max-width:720px;margin:20px auto;padding:0 12px}',
      });
      await page.evaluate(async (selected) => {
        const path = '/tests/fixtures/story-ui.tsx';
        (await import(path)).mountPreset(document.getElementById('mount'), selected);
      }, style);
      const surface = page.locator('.story-ui');
      await expect(surface).toHaveAttribute('data-story-ui-style', style);
      if (style === 'modern')
        await expect(
          surface
            .getByRole('button', { name: '확인', exact: true })
            .getByText('확인', { exact: true })
        ).toHaveCSS('color', 'rgb(255, 255, 255)');
      await expect(surface.getByText('오늘의 순찰 구역을 확인해 주세요.')).toBeVisible();
      await surface.getByRole('tab', { name: '임무 정보' }).focus();
      await page.keyboard.press('ArrowRight');
      await expect(surface.getByText('오늘의 활동 기록이에요.')).toBeVisible();
      await surface.getByLabel('조사 메모').fill('오후에 다시 확인');
      await expect(surface.getByLabel('조사 메모')).toHaveValue('오후에 다시 확인');
      expect(await surface.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
      await page.screenshot({
        path: `output/story-ui-${style}-${width}.png`,
        fullPage: true,
      });
    }
  }
});
