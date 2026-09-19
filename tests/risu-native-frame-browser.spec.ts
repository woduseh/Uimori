import { test, expect } from '@playwright/test';
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
      include: ['react', 'react-dom/client', 'dompurify', 'lucide-react'],
    },
    server: { host: '127.0.0.1', port: 0 },
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
  await server?.close();
});

test('successful controls wait for a refreshed revision and natural margins fit the frame', async ({
  page,
}) => {
  await page.goto(origin);
  await page.evaluate(async () => {
    const path = '/tests/fixtures/native-risu-frame.tsx';
    const { mount } = await import(path);
    mount();
  });
  const native = page.frameLocator('iframe[title="봇 메시지"]');
  await native.getByRole('button', { name: 'One', exact: true }).click();
  await expect(page.locator('output')).toHaveText('1');
  await expect(native.locator('body')).toHaveAttribute('data-risu-disabled', 'true');
  await native
    .getByRole('button', { name: 'Two', exact: true })
    .evaluate((button: HTMLButtonElement) => button.click());
  await expect(page.locator('output')).toHaveText('1');
  await page.getByRole('button', { name: 'Render new revision' }).click();
  await native.getByRole('button', { name: 'Two', exact: true }).click();
  await expect(page.locator('output')).toHaveText('2');
  await expect
    .poll(() =>
      native
        .locator('#last')
        .evaluate((element) => element.getBoundingClientRect().bottom <= innerHeight)
    )
    .toBe(true);
});

test('authored message CSS stays scoped and cannot crop the frame through html/body layout', async ({
  page,
}) => {
  await page.goto(origin);
  await page.evaluate(async () => {
    const path = '/tests/fixtures/native-risu-frame.tsx';
    const { mount } = await import(path);
    mount(`<div class="risu-chat-text"><style>
      html, body {height:100%;padding:50px 0;display:flex;justify-content:center;align-items:center}
      :is(.panel, .unused), [data-label="a,b"] { min-height:600px; background:rgb(12, 34, 56) }
      @media (min-width:1px) { .panel {padding:20px} }
      @keyframes appear { from {opacity:0} to {opacity:1} }
    </style><div class="panel" data-label="a,b">Top<p id="last" style="margin-top:550px">Last</p></div></div>`);
  });
  const native = page.frameLocator('iframe[title="봇 메시지"]');
  await expect(native.locator('.panel')).toHaveCSS('background-color', 'rgb(12, 34, 56)');
  await expect(native.locator('.panel')).toHaveCSS('padding', '20px');
  await expect(native.locator('body')).not.toHaveCSS('display', 'flex');
  await expect
    .poll(() =>
      native.locator('#last').evaluate((element) => {
        const panel = element.closest('.panel')!.getBoundingClientRect();
        return panel.top >= 0 && element.getBoundingClientRect().bottom <= innerHeight;
      })
    )
    .toBe(true);
});

test('a fixed authored toolbar stays visible beside a short opening', async ({ page }) => {
  await page.goto(origin);
  await page.evaluate(async () => {
    const path = '/tests/fixtures/native-risu-frame.tsx';
    const { mount } = await import(path);
    mount(`<div class="risu-chat-text"><style>
      .toolbar {position:fixed;top:35px;right:12px;display:flex;flex-direction:column;gap:8px}
      .toolbar button, .toolbar label {height:48px;width:48px;display:block}
      .closed-panel {position:fixed;right:-560px;width:520px;top:80px;height:100vh}
    </style><p>Choose a language</p><div class="toolbar">
      <label for="settings">1</label><label for="settings">2</label>
      <label for="settings">3</label><label for="settings">4</label>
      <label for="settings">5</label>
    </div><input id="settings" type="checkbox" hidden><aside class="closed-panel"><button risu-trigger="hidden">Hidden panel</button></aside></div>`);
  });
  const native = page.frameLocator('iframe[title="봇 메시지"]');
  await expect
    .poll(() =>
      native.locator('.toolbar').evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return rect.top >= 0 && rect.bottom <= innerHeight;
      })
    )
    .toBe(true);
  await native.locator('label[for="settings"]').last().click();
  await expect(native.locator('#settings')).toBeChecked();
  await expect(page.locator('iframe')).toHaveCSS('height', '307px');
});

test('native preset editor keeps raw CBS, toggle values, and invalid regex drafts', async ({
  page,
}) => {
  await page.goto(origin);
  await page.evaluate(async () => {
    const path = '/tests/fixtures/native-preset-editor.tsx';
    const { mount } = await import(path);
    mount();
  });
  const editor = page.getByRole('region', { name: 'Risu 프롬프트 원본 편집' });
  await editor.getByLabel('Mood', { exact: true }).selectOption('"1"');
  await editor.getByText('1. plain', { exact: true }).click();
  await expect(editor.getByLabel('1번 프롬프트 본문')).toHaveValue('{{getvar::place}}');
  await editor.getByLabel('1번 프롬프트 본문').fill('{{#when::mood::tis::1}}VIVID{{/when}}');
  await editor.getByText('정규식 스크립트', { exact: true }).click();
  await editor.getByLabel('Risu 정규식 원본 JSON').fill('[invalid');
  await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();
  await editor.getByLabel('1번 블록 이름').fill('Try another edit');
  await expect(editor.getByLabel('Risu 정규식 원본 JSON')).toHaveValue('[invalid');
  await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();
  const regex = [{ in: '(hello)', out: '$1 {{getvar::place}}', type: 'editinput' }];
  await editor.getByLabel('Risu 정규식 원본 JSON').fill(JSON.stringify(regex));
  await expect(page.getByRole('button', { name: 'Save' })).toBeEnabled();
  const saved = JSON.parse((await page.locator('output').textContent())!);
  expect(saved.values).toEqual({ mood: '1' });
  expect(saved.program.nativeRisuPreset.preset).toMatchObject({
    regex,
    promptTemplate: [{ text: '{{#when::mood::tis::1}}VIVID{{/when}}' }],
  });
  expect(saved.program.nativeRisuPreset.preset.aiModel).toBeUndefined();
  expect(saved.program.nativeRisuPreset.preset.apiKey).toBeUndefined();
});

test('native authored CSS and delegated controls work while active content and remote fetches stay isolated', async ({
  page,
}) => {
  const remote: string[] = [];
  await page.route('https://attacker.invalid/**', async (route) => {
    remote.push(route.request().url());
    await route.abort();
  });
  await page.goto(origin);
  await page.evaluate(async () => {
    const path = '/web/risu-message-frame.ts';
    const { prepareRisuMessage, RISU_FRAME_CHANNEL } = await import(path);
    const prepared = prepareRisuMessage(
      `<style>.native-card{color:rgb(12,34,56);background-image:url(https://attacker.invalid/css)}</style><div class="native-card"><button risu-trigger="pick-route" onclick="parent.document.body.dataset.compromised='true'">Choose</button><button risu-btn="other">Other</button><img src="https://attacker.invalid/pixel" onerror="parent.postMessage('x','*')"><script>parent.document.body.dataset.compromised='true'</script><iframe srcdoc="<script>alert(1)</script>"></iframe></div>`
    );
    const frame = document.createElement('iframe');
    frame.id = 'native';
    frame.sandbox.add('allow-scripts');
    frame.srcdoc = prepared.srcDoc;
    frame.style.height = '500px';
    (window as unknown as { nativeActions: unknown[] }).nativeActions = [];
    window.addEventListener('message', (event) => {
      if (
        event.source !== frame.contentWindow ||
        event.origin !== 'null' ||
        event.data?.token !== prepared.token
      )
        return;
      const data = event.data;
      if (data.kind === 'ready')
        frame.contentWindow!.postMessage(
          { channel: RISU_FRAME_CHANNEL, token: prepared.token, kind: 'disabled', value: false },
          '*'
        );
      if (data.kind === 'action')
        (window as unknown as { nativeActions: unknown[] }).nativeActions.push({
          kind: data.actionKind,
          name: data.name,
        });
      if (data.kind === 'resize') document.body.dataset.frameHeight = String(data.height);
    });
    document.getElementById('mount')!.append(frame);
  });
  const native = page.frameLocator('#native');
  await expect(native.locator('.native-card')).toHaveCSS('color', 'rgb(12, 34, 56)');
  await expect(native.locator('iframe')).toHaveCount(0);
  await expect(native.locator('script')).toHaveCount(1);
  await expect(native.getByRole('button', { name: 'Choose' })).not.toHaveAttribute('onclick');
  await native.getByRole('button', { name: 'Choose' }).click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { nativeActions: unknown[] }).nativeActions)
    )
    .toEqual([{ kind: 'trigger', name: 'pick-route' }]);
  expect(await page.locator('body').getAttribute('data-compromised')).toBeNull();
  await expect.poll(() => page.locator('body').getAttribute('data-frame-height')).not.toBeNull();
  const frame = (await (await page.locator('#native').elementHandle())!.contentFrame())!;
  expect(
    await frame.evaluate(() => {
      try {
        return { accessible: !!parent.document };
      } catch {
        return { accessible: false };
      }
    })
  ).toEqual({ accessible: false });
  expect(remote).toEqual([]);
});

test('style terminators and link payloads cannot introduce authored scripts or navigation', async ({
  page,
}) => {
  await page.goto(origin);
  const result = await page.evaluate(async () => {
    const path = '/web/risu-message-frame.ts';
    const { prepareRisuMessage } = await import(path);
    const prepared = prepareRisuMessage(
      '<a href="data:image/svg+xml;base64,PHN2Zz4=">bad link</a><button risu-btn="run">ok</button>',
      '</style><script>window.injected=true</script><style>'
    );
    const doc = new DOMParser().parseFromString(prepared.srcDoc, 'text/html');
    return {
      scripts: doc.querySelectorAll('script').length,
      href: doc.querySelector('a')?.getAttribute('href'),
      nonceScripts: doc.querySelectorAll('script[nonce]').length,
      actions: [...prepared.actions],
    };
  });
  expect(result).toEqual({
    scripts: 1,
    href: null,
    nonceScripts: 1,
    actions: ['["button","run"]'],
  });
});
