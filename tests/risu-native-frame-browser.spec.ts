import { test, expect } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import {
  MOBILE_WIDTH,
  DESKTOP_WIDTH,
  MOBILE_HEIGHT,
  DESKTOP_HEIGHT,
} from './fixtures/browser-viewports.js';

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
  await server?.close();
});

test('RSURFACE successful controls wait for a refreshed revision', async ({ page }) => {
  await page.goto(origin);
  await page.evaluate(async () => {
    const path = '/tests/fixtures/native-risu-frame.tsx';
    const { mount } = await import(path);
    mount();
  });
  const native = page.locator('.risu-message-surface');
  await native.getByRole('button', { name: 'One', exact: true }).click();
  await expect(page.locator('output')).toHaveText('1');
  await expect(native.locator('.risu-message-content')).toHaveAttribute(
    'data-risu-disabled',
    'true'
  );
  await native
    .getByRole('button', { name: 'Two', exact: true })
    .evaluate((button: HTMLButtonElement) => button.click());
  await expect(page.locator('output')).toHaveText('1');
  await page.getByRole('button', { name: 'Render new revision' }).click();
  await native.getByRole('button', { name: 'Two', exact: true }).click();
  await expect(page.locator('output')).toHaveText('2');
});

test('RSURFACE plain paragraphs use natural flow after reading size changes', async ({ page }) => {
  for (const viewport of [
    { width: MOBILE_WIDTH, height: MOBILE_HEIGHT },
    { width: DESKTOP_WIDTH, height: DESKTOP_HEIGHT },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto(origin);
    await page.evaluate(async () => {
      const path = '/tests/fixtures/native-risu-frame.tsx';
      const { mount } = await import(path);
      mount(
        '<p>First paragraph with enough text to wrap on a phone.</p><p>Second paragraph.</p><p id="last">Last paragraph.</p>'
      );
    });
    const native = page.locator('.risu-message-surface');
    const heights: number[] = [];
    for (const size of [18, 26, 14]) {
      await page.evaluate(
        (value) => document.documentElement.style.setProperty('--reading', `${value}px`),
        size
      );
      await expect(native.locator('#last')).toHaveCSS('font-size', `${size}px`);
      await expect
        .poll(() =>
          native.evaluate((host) => {
            const last = host.shadowRoot!.querySelector('#last')!;
            return (
              last.getBoundingClientRect().bottom +
                parseFloat(getComputedStyle(last).marginBottom) <=
              host.getBoundingClientRect().bottom + 1
            );
          })
        )
        .toBe(true);
      heights.push((await native.boundingBox())!.height);
    }
    expect(heights[2]).toBeLessThan(heights[1]);
    await expect(page.locator('iframe')).toHaveCount(0);
  }
});

test('RSURFACE authored CSS cannot apply html/body layout to the app', async ({ page }) => {
  await page.goto(origin);
  await page.evaluate(async () => {
    const path = '/tests/fixtures/native-risu-frame.tsx';
    const { mount } = await import(path);
    mount(`<div class="risu-chat-text"><style>
      html, body {height:100%;padding:50px;display:flex}
      :is(.panel, .unused), [data-label="a,b"] {min-height:600px;background:rgb(12,34,56)}
      @media (min-width:1px) {.panel{padding:20px}}
      @keyframes appear {from{opacity:0}to{opacity:1}}
    </style><div class="panel" data-label="a,b">Top<p id="last" style="margin-top:550px">Last</p></div></div>`);
  });
  const native = page.locator('.risu-message-surface');
  await expect(native.locator('.panel')).toHaveCSS('background-color', 'rgb(12, 34, 56)');
  await expect(native.locator('.panel')).toHaveCSS('padding', '20px');
  await expect(page.locator('body')).not.toHaveCSS('display', 'flex');
  await expect
    .poll(() =>
      native.evaluate(
        (host) =>
          host.shadowRoot!.querySelector('#last')!.getBoundingClientRect().bottom <=
          host.getBoundingClientRect().bottom + 1
      )
    )
    .toBe(true);
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
  await editor.getByRole('tab', { name: '기본 옵션', exact: true }).click();
  await editor.getByLabel('Mood', { exact: true }).selectOption('"1"');
  await editor.getByRole('tab', { name: '구성', exact: true }).click();
  await expect(editor.getByLabel('1번 프롬프트 본문')).toHaveValue('{{getvar::place}}');
  await editor.getByLabel('1번 프롬프트 본문').fill('{{#when::mood::tis::1}}VIVID{{/when}}');
  await editor.getByRole('tab', { name: '정규식', exact: true }).click();
  await editor.getByText('고급 JSON 편집', { exact: true }).click();
  await editor.getByLabel('Risu 정규식 JSON').fill('[invalid');
  await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();
  await editor.getByRole('tab', { name: '구성', exact: true }).click();
  await editor.getByLabel('1번 블록 이름').fill('Try another edit');
  await editor.getByRole('tab', { name: '정규식', exact: true }).click();
  await expect(editor.getByLabel('Risu 정규식 JSON')).toHaveValue('[invalid');
  await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();
  const regex = [{ in: '(hello)', out: '$1 {{getvar::place}}', type: 'editinput' }];
  await editor.getByLabel('Risu 정규식 JSON').fill(JSON.stringify(regex));
  await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();
  await editor.getByRole('button', { name: '폼에 반영', exact: true }).click();
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

test('native preset blocks reorder by drag and keep the moved block selected', async ({ page }) => {
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: DESKTOP_HEIGHT });
  await page.goto(origin);
  await page.evaluate(async () => {
    const path = '/tests/fixtures/native-preset-editor.tsx';
    const { mountReorderFixture } = await import(path);
    mountReorderFixture();
  });
  const editor = page.getByRole('region', { name: 'Risu 프롬프트 원본 편집' });
  const list = editor.getByRole('complementary', { name: '프롬프트 블록 목록' });
  const rows = list.locator(':scope > button');
  await expect(rows).toHaveCount(3);
  await rows.nth(0).dragTo(rows.nth(2), { targetPosition: { x: 20, y: 40 } });
  await expect(rows.locator('strong')).toHaveText(['1. Second', '2. Third', '3. First']);
  await expect(editor.getByLabel('3번 프롬프트 본문')).toHaveValue('First');
  const savedOrder = () =>
    page
      .locator('output')
      .textContent()
      .then((value) =>
        JSON.parse(value!).nativeRisuPreset.preset.promptTemplate.map(
          (block: { name: string }) => block.name
        )
      );
  await expect.poll(savedOrder).toEqual(['Second', 'Third', 'First']);

  await list.getByPlaceholder('블록 찾기').fill('i');
  const filteredRows = list.locator(':scope > button');
  await expect(filteredRows).toHaveCount(2);
  await filteredRows.nth(1).dragTo(filteredRows.nth(0), { targetPosition: { x: 20, y: 1 } });
  await expect.poll(savedOrder).toEqual(['Second', 'First', 'Third']);
});

test('native collection rows share drag ordering and selection feedback', async ({ page }) => {
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: DESKTOP_HEIGHT });
  await page.goto(origin);
  await page.evaluate(async () => {
    const path = '/tests/fixtures/native-regex-editor.tsx';
    const { mount } = await import(path);
    mount();
  });
  const list = page.getByRole('complementary', { name: '정규식 목록', exact: true });
  const rows = list.locator(':scope > button');
  await rows.nth(0).dragTo(rows.nth(2), { targetPosition: { x: 20, y: 48 } });
  const value = () =>
    page
      .locator('output')
      .textContent()
      .then((text) => JSON.parse(text!).map((item: { comment: string }) => item.comment));
  await expect.poll(value).toEqual(['Second rule', 'Future rule', 'First rule']);
  await expect(page.getByLabel('정규식 이름', { exact: true })).toHaveValue('First rule');
  await expect(list.getByRole('status')).toContainText('3번째');
});

test('native regex synced buffers follow parent JSON changes while local and remote drafts survive', async ({
  page,
}) => {
  await page.goto(origin);
  await page.evaluate(async () => {
    const path = '/tests/fixtures/native-regex-draft.tsx';
    const { mount } = await import(path);
    mount();
  });
  await page.getByLabel('정규식 찾을 표현식', { exact: true }).fill('form edit');
  await page.getByRole('button', { name: '부모 JSON 적용', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  await expect(page.getByLabel('정규식 찾을 표현식', { exact: true })).toHaveValue('parent-1');
  if (
    !(await page.locator('.native-regex-raw').evaluate((node) => (node as HTMLDetailsElement).open))
  )
    await page.getByText('고급 JSON 편집', { exact: true }).click();
  const raw = page.getByLabel('Risu 정규식 JSON', { exact: true });
  await expect.poll(async () => JSON.parse(await raw.inputValue())[0].in).toBe('parent-1');
  await raw.fill('[local unfinished');
  await page.getByRole('button', { name: '부모 JSON 적용', exact: true }).click();
  await expect(raw).toHaveValue('[local unfinished');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '입력 되돌리기', exact: true }).click();
  await expect.poll(async () => JSON.parse(await raw.inputValue())[0].in).toBe('parent-2');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '원격 초안 복원', exact: true }).click();
  await expect(raw).toHaveValue('[remote unfinished');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await expect
    .poll(async () => JSON.parse((await page.locator('output').textContent())!)[0].in)
    .toBe('remote');
});

for (const viewport of [
  { width: MOBILE_WIDTH, height: 915 },
  { width: DESKTOP_WIDTH, height: 1440 },
]) {
  test.describe(`native editor input at ${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport });

    test('native regex forms preserve aliases, custom flags, order and invalid raw drafts', async ({
      page,
    }) => {
      await page.goto(origin);
      await page.evaluate(async () => {
        const path = '/tests/fixtures/native-regex-editor.tsx';
        const { mount } = await import(path);
        mount();
      });
      const value = () =>
        page
          .locator('output')
          .textContent()
          .then((text) => JSON.parse(text!));
      await page.getByLabel('정규식 찾을 표현식', { exact: true }).fill('(world)');
      await page.getByLabel('정규식 바꿀 내용', { exact: true }).fill('$1 {{getvar::place}}');
      await expect.poll(value).toMatchObject([
        {
          in: '(world)',
          find: '(world)',
          out: '$1 {{getvar::place}}',
          replace: '$1 {{getvar::place}}',
          ableFlag: false,
          extra: { preserved: true },
        },
        {},
        {},
      ]);
      await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
      await page.getByRole('checkbox', { name: '사용자 지정 플래그', exact: true }).check();
      await page.getByRole('button', { name: '대소문자 무시 (i)', exact: true }).click();
      await page.getByText('고급 플래그', { exact: true }).click();
      await page.getByLabel('정규식 실행 우선순위', { exact: true }).fill('8');
      await expect(page.getByLabel('정규식 플래그 원문', { exact: true })).toHaveValue(
        'g<cbs><future_flag><order 8>'
      );
      await page.getByRole('checkbox', { name: '사용자 지정 플래그', exact: true }).uncheck();
      await expect
        .poll(value)
        .toMatchObject([
          { ableFlag: false, flag: 'g<cbs><future_flag><order 8>', type: 'editdisplay' },
          {},
          {},
        ]);
      await page.getByLabel('정규식 적용 단계', { exact: true }).selectOption('disabled');
      await page.getByRole('button', { name: '정규식 아래로', exact: true }).click();
      await expect
        .poll(async () => (await value()).map((item: { comment: string }) => item.comment))
        .toEqual(['Second rule', 'First rule', 'Future rule']);
      await page.getByRole('button', { name: '정규식 복제', exact: true }).click();
      await expect
        .poll(async () => (await value())[2])
        .toMatchObject({
          comment: 'First rule 사본',
          type: 'disabled',
          extra: { preserved: true },
        });
      await page.getByRole('button', { name: '선택한 정규식 삭제', exact: true }).click();
      await expect.poll(async () => (await value()).length).toBe(3);
      await page.getByText('고급 JSON 편집', { exact: true }).click();
      await page.getByLabel('Risu 정규식 JSON', { exact: true }).fill('[invalid');
      await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
      await expect(page.getByLabel('정규식 이름', { exact: true })).toBeDisabled();
      await page.getByRole('button', { name: '다른 탭', exact: true }).click();
      await page.getByRole('button', { name: '다른 탭', exact: true }).click();
      await expect(page.getByLabel('Risu 정규식 JSON', { exact: true })).toHaveValue('[invalid');
      await page.getByRole('button', { name: '폼에 반영', exact: true }).click();
      await expect(page.getByRole('alert')).toBeVisible();
      await page.getByRole('button', { name: '입력 되돌리기', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
      await expect
        .poll(async () => (await value())[2])
        .toEqual({ comment: 'Future rule', in: '', out: '', type: 'future_mode', unknown: [1, 2] });
      const bounds = await page.getByRole('region', { name: '정규식 편집기' }).evaluate((node) => {
        const edge = node.getBoundingClientRect().right;
        return {
          overflow: node.scrollWidth - node.clientWidth,
          outside: [...node.querySelectorAll('*')]
            .filter((child) => child.getBoundingClientRect().right > edge + 1)
            .map((child) => ({
              tag: child.tagName,
              classes: child.className,
              right: child.getBoundingClientRect().right,
              width: child.getBoundingClientRect().width,
            })),
        };
      });
      expect(bounds.overflow, JSON.stringify(bounds.outside)).toBeLessThanOrEqual(1);
    });

    test('native lore keywords accept sequential comma input without losing the next key', async ({
      page,
    }) => {
      await page.route('**/api/library?view=summary', (route) =>
        route.fulfill({ json: { contents: [], promptPresets: [] } })
      );
      await page.goto(origin);
      await page.evaluate(async () => {
        const path = '/tests/fixtures/native-content-editor.tsx';
        const { mount } = await import(path);
        mount();
      });
      await page.getByRole('tab', { name: '로어북', exact: true }).click();
      await page.getByText('조건·배치·원문 설정', { exact: true }).click();
      const keywords = page.getByLabel('로어 키워드', { exact: true });
      await keywords.focus();
      await keywords.press('End');
      await keywords.pressSequentially(',');
      await expect(keywords).toHaveValue('forest,');
      await keywords.pressSequentially(' river, village');
      await expect(keywords).toHaveValue('forest, river, village');
      const keys = () =>
        page
          .locator('output')
          .textContent()
          .then((value) => JSON.parse(value!).nativeRisu.card.character_book.entries[0].keys);
      await expect.poll(keys).toEqual(['forest', 'river', 'village']);
      await page.getByLabel('로어 이름', { exact: true }).click();
      await expect(keywords).toHaveValue('forest, river, village');
      await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
    });

    test('native preset block types use their own role and switch numeric chat end back to end', async ({
      page,
    }) => {
      await page.goto(origin);
      await page.evaluate(async () => {
        const path = '/tests/fixtures/native-preset-editor.tsx';
        const { mount } = await import(path);
        mount();
      });
      const editor = page.getByRole('region', { name: 'Risu 프롬프트 원본 편집' });
      const role = editor.getByLabel('1번 블록 역할');
      await role.selectOption('user');
      await editor.locator('summary').filter({ hasText: '블록 종류' }).click();
      const type = editor.getByLabel('1번 블록 종류');
      await type.selectOption('description');
      await expect(role).toHaveValue('system');
      await role.selectOption('assistant');
      await expect(role).toHaveValue('assistant');
      await type.selectOption('plain');
      await expect(role).toHaveValue('user');
      await type.selectOption('description');
      await expect(role).toHaveValue('assistant');
      await type.selectOption('chat');
      await editor.getByLabel('대화 끝 위치 유형', { exact: true }).selectOption('index');
      await editor.getByLabel('대화 끝 위치', { exact: true }).fill('-2');
      const block = () =>
        page
          .locator('output')
          .textContent()
          .then((value) => JSON.parse(value!).program.nativeRisuPreset.preset.promptTemplate[0]);
      await expect.poll(block).toMatchObject({ rangeEnd: -2 });
      await editor.getByLabel('대화 끝 위치 유형', { exact: true }).selectOption('end');
      await expect(editor.getByLabel('대화 끝 위치', { exact: true })).toHaveCount(0);
      await expect.poll(block).toMatchObject({
        type: 'chat',
        role: 'user',
        role2: 'bot',
        rangeEnd: 'end',
      });
      await expect(editor.getByRole('alert')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
    });
  });
}

test('RSURFACE appearance follows app settings without resetting authored controls', async ({
  page,
}) => {
  await page.goto(origin);
  await page.evaluate(async () => {
    document.documentElement.style.setProperty('--text', '#123456');
    document.documentElement.style.setProperty('--reading', '18px');
    const path = '/tests/fixtures/native-risu-frame.tsx';
    const { mount } = await import(path);
    mount(
      '<p id="inherited">App defaults</p><p id="authored" style="color:rgb(100,20,30);font-size:12px">Authored style</p><input aria-label="Unsaved input" />'
    );
  });
  const native = page.locator('.risu-message-surface');
  await expect(native.locator('#inherited')).toHaveCSS('color', 'rgb(18, 52, 86)');
  await native.getByRole('textbox', { name: 'Unsaved input' }).fill('Keep me');
  await page.evaluate(() => {
    document.documentElement.style.setProperty('--text', '#abcdef');
    document.documentElement.style.setProperty('--reading', '24px');
    document.documentElement.style.setProperty('--reading-line-height', '2.2');
  });
  await expect(native.locator('#inherited')).toHaveCSS('color', 'rgb(171, 205, 239)');
  await expect(native.locator('#inherited')).toHaveCSS('font-size', '24px');
  await expect(native.locator('#authored')).toHaveCSS('color', 'rgb(100, 20, 30)');
  await expect(native.locator('#authored')).toHaveCSS('font-size', '12px');
  await expect(native.getByRole('textbox', { name: 'Unsaved input' })).toHaveValue('Keep me');
});
