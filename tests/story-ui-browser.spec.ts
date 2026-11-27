import { expect, test } from '@playwright/test';
import { startFixtureVite, type FixtureVite } from './fixtures/fixture-vite.js';
import { visualReview } from './fixtures/visual-review.js';

test.use({ reducedMotion: 'no-preference' });

let vite: FixtureVite;
let origin: string;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  vite = await startFixtureVite(
    [
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
    ['/tests/fixtures/story-ui.tsx']
  );
  origin = vite.origin;
});
test.afterAll(async () => {
  await vite?.close();
});
test('renders bound image lists and icons without fetching edited external URLs', async ({
  page,
}, info) => {
  const { normalizeStoryUiOutput } = await import('../server/story-ui.js');
  const source = normalizeStoryUiOutput(
    `<a2ui>
$/people = [{name: "미라", portrait: "{{img::미라_미소}}", icon: "person"}, {name: "솔", portrait: "/api/assets/sol", icon: "home"}]
$/portrait = "/api/assets/selected"
item = Row([Image($portrait, description=$name, variant="avatar"), Icon($icon), Text($name)])
root = Column([List(_template($/people, item)), TextField("첫 아이콘", $/people/0/icon), TextField("초상화 경로", $/portrait), Image($/portrait, description="선택한 초상화", fit="scaleDown"), Image("https://outside.invalid/literal.png", description="밖의 그림"), Text("끝")])
</a2ui>`,
    (name) => (name === '미라_미소' ? '/api/package-image-blobs/mira' : undefined)
  );
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
    '/api/package-image-blobs/mira'
  );
  await expect(page.getByRole('img', { name: '미라', exact: true })).toHaveJSProperty(
    'naturalWidth',
    40
  );
  await expect(page.getByRole('img', { name: '솔', exact: true })).toHaveAttribute(
    'src',
    '/api/assets/sol'
  );
  await expect(page.getByText('끝', { exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: '밖의 그림' })).toHaveCount(0);
  await expect(page.getByText('밖의 그림')).toHaveCount(0);
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
  await expect(selected).toHaveCount(0);
  await page.getByLabel('초상화 경로').fill('/api/package-image-blobs/changed');
  await expect(selected).toHaveAttribute('src', '/api/package-image-blobs/changed');
  expect(remoteRequests).toEqual([]);
  if (visualReview) await page.screenshot({ path: info.outputPath('story-ui-bound-images.png') });
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

test('block CSS written by the model stays inside its block and loads nothing remote', async ({
  page,
}) => {
  const { normalizeStoryUiOutput } = await import('../server/story-ui.js');
  const source = normalizeStoryUiOutput(`<a2ui>
$/_uimori/css = r"""
& { --story-ink: #f3e9ff; color-scheme: dark; }
.look-scan { border: 1px solid #3df2ff !important; background-image: url("https://outside.invalid/track.png"); }
.look-escape { position: fixed; inset: -200px; opacity: 0; }
@font-face { font-family: Evil; src: url("https://outside.invalid/font.woff2"); }
@import url("https://outside.invalid/sheet.css");
"""
root = Column([Card(Text("INSERT COIN", variant="label"), look="scan"), Column([], look="escape")])
</a2ui>`);
  const remoteRequests: string[] = [];
  await page.route('https://outside.invalid/**', (route) => {
    remoteRequests.push(route.request().url());
    return route.abort();
  });
  await page.goto(origin);
  await page.evaluate(async (value) => {
    const path = '/tests/fixtures/story-ui.tsx';
    await (await import(path)).mountGallery(document.getElementById('mount'), [value]);
  }, source);
  const authored = page.locator('.story-ui[data-story-ui-authored]');
  await expect(authored).toHaveCSS('color', 'rgb(243, 233, 255)');
  expect(await authored.locator('style').textContent()).not.toMatch(
    /outside\.invalid|important|@font-face|@import/
  );
  await expect(authored.locator('.look-scan')).toHaveCSS('background-image', 'none');
  const escaped = (await authored.locator('.look-escape').boundingBox())!;
  const host = (await page.locator('.story-ui-block[data-authored]').boundingBox())!;
  expect(escaped.x).toBeGreaterThanOrEqual(host.x - 200);
  expect(escaped.width).toBeLessThanOrEqual(host.width + 400);
  expect(remoteRequests).toEqual([]);
});
