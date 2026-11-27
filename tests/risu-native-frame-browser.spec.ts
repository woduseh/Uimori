import { test, expect } from './fixtures/browser-test.js';
import { selectEditorSection } from './ui-navigation.js';
import { startFixtureVite, type FixtureVite } from './fixtures/fixture-vite.js';
import {
  MOBILE_WIDTH,
  DESKTOP_WIDTH,
  MOBILE_HEIGHT,
  DESKTOP_HEIGHT,
} from './fixtures/browser-viewports.js';

let vite: FixtureVite;
let origin: string;
test.beforeAll(async () => {
  vite = await startFixtureVite(['react', 'react-dom/client', 'dompurify', 'lucide-react']);
  origin = vite.origin;
});
test.afterAll(async () => {
  await vite?.close();
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

test('RSURFACE viewport projections retain local controls and action locks until a native revision', async ({
  page,
}) => {
  const requests: { width: number; height: number }[] = [];
  const previews: { width: number; height: number }[] = [];
  let nativeRevision = 0;
  let draftDefault = 'Original draft';
  let heldWidthText: number | undefined;
  let waitForResize = false;
  let releaseResize!: () => void;
  const resizeGate = new Promise<void>((resolve) => {
    releaseResize = resolve;
  });
  let releasePreviewRetry!: () => void;
  const previewRetryGate = new Promise<void>((resolve) => {
    releasePreviewRetry = resolve;
  });
  const dimensions = (url: string) => {
    const query = new URL(url).searchParams;
    return {
      width: Number(query.get('viewportWidth')),
      height: Number(query.get('viewportHeight')),
    };
  };
  await page.route('**/api/chats/chat/sources/source/presentation?*', async (route) => {
    const viewport = dimensions(route.request().url());
    requests.push(viewport);
    if (waitForResize) await resizeGate;
    await route.fulfill({
      json: {
        sourceRevision: 'source',
        sourceHash: 'source-hash',
        format: 'risu-html',
        nativeAction: {
          expectedHeadRevision: 'source',
          expectedHeadHash: 'source-hash',
          expectedVariableRevision: nativeRevision,
        },
        original: {
          text: `Width ${heldWidthText ?? viewport.width}`,
          html: `<p>Width ${heldWidthText ?? viewport.width}</p>
            <input id="draft" aria-label="Card draft" value="${draftDefault}">
            <textarea risu-id="notes" aria-label="Card notes">Original notes ${nativeRevision}</textarea>
            <select name="choice" aria-label="Card choice">
              <option value="first" ${nativeRevision === 0 ? 'selected' : ''}>First</option>
              <option value="second">Second</option>
              <option value="third" ${nativeRevision === 1 ? 'selected' : ''}>Third</option>
            </select>
            <input id="panel-toggle" type="checkbox" aria-label="Panel open">
            <details id="details"><summary>Card details</summary>Extra information</details>
            <button risu-trigger="one">One</button>`,
          css: `#draft { max-width: ${viewport.width}px; }`,
          changed: true,
          applied: [],
        },
        translationId: null,
        translationRevision: null,
        issues: [],
      },
    });
  });
  await page.route('**/api/content/bot/risu-preview?*', async (route) => {
    const viewport = dimensions(route.request().url());
    previews.push(viewport);
    if (previews.length === 1) {
      await route.fulfill({ status: 503, json: { error: 'Synthetic preview read failure' } });
      return;
    }
    await previewRetryGate;
    await route.fulfill({
      json: { html: `<p>Preview ${viewport.width}</p>`, css: '', issues: [] },
    });
  });
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: DESKTOP_HEIGHT });
  await page.goto(origin);
  await page.clock.install();
  await page.evaluate(async () => {
    const path = '/tests/fixtures/native-risu-viewport.tsx';
    const { mount } = await import(path);
    mount();
  });
  const presentation = page.getByRole('region', { name: 'Presentation', exact: true });
  await expect(presentation).toContainText(`Width ${DESKTOP_WIDTH}`);
  expect(requests).toEqual([{ width: DESKTOP_WIDTH, height: DESKTOP_HEIGHT }]);
  const draft = presentation.getByRole('textbox', { name: 'Card draft', exact: true });
  const notes = presentation.getByRole('textbox', { name: 'Card notes', exact: true });
  const choice = presentation.getByRole('combobox', { name: 'Card choice', exact: true });
  const panelToggle = presentation.getByRole('checkbox', { name: 'Panel open', exact: true });
  const details = presentation.locator('#details');
  await draft.fill('Unsaved card draft');
  await notes.fill('Unsaved card notes');
  await choice.selectOption('second');
  await panelToggle.check();
  await details.getByText('Card details', { exact: true }).click();
  await draft.focus();
  await draft.evaluate((node: HTMLInputElement) => node.setSelectionRange(2, 7));

  waitForResize = true;
  await page.setViewportSize({ width: MOBILE_WIDTH, height: MOBILE_HEIGHT });
  await expect
    .poll(() => requests.at(-1))
    .toEqual({
      width: MOBILE_WIDTH,
      height: MOBILE_HEIGHT,
    });
  await expect(page.getByLabel('Presentation status')).toHaveText('pending');
  await expect(presentation).toContainText(`Width ${DESKTOP_WIDTH}`);
  await expect(presentation.locator('.risu-message-content')).toHaveAttribute(
    'data-risu-disabled',
    'true'
  );
  await presentation
    .getByRole('button', { name: 'One', exact: true })
    .evaluate((button: HTMLButtonElement) => button.click());
  await expect(page.getByLabel('Action calls')).toHaveText('0');
  releaseResize();
  await expect(presentation).toContainText(`Width ${MOBILE_WIDTH}`);
  await expect(page.getByLabel('Presentation status')).toHaveText('ready');
  await expect(draft).toHaveValue('Unsaved card draft');
  await expect(notes).toHaveValue('Unsaved card notes');
  await expect(choice).toHaveValue('second');
  await expect(panelToggle).toBeChecked();
  await expect(details).toHaveAttribute('open', '');
  expect(
    await draft.evaluate((node: HTMLInputElement) => ({
      focused: (node.getRootNode() as ShadowRoot).activeElement === node,
      start: node.selectionStart,
      end: node.selectionEnd,
    }))
  ).toEqual({ focused: true, start: 2, end: 7 });
  await presentation.getByRole('button', { name: 'One', exact: true }).click();
  await expect(page.getByLabel('Action calls')).toHaveText('1');

  const settledRequests = requests.length;
  await page.setViewportSize({ width: MOBILE_WIDTH, height: MOBILE_HEIGHT + 60 });
  await page.clock.fastForward(1000);
  expect(requests).toHaveLength(settledRequests);

  const draftNode = await draft.elementHandle();
  heldWidthText = MOBILE_WIDTH;
  await page.setViewportSize({ width: MOBILE_WIDTH + 2, height: MOBILE_HEIGHT + 60 });
  await expect
    .poll(() => requests.at(-1))
    .toEqual({
      width: MOBILE_WIDTH + 2,
      height: MOBILE_HEIGHT + 60,
    });
  await expect(draft).toHaveCSS('max-width', `${MOBILE_WIDTH + 2}px`);
  await expect(page.getByLabel('Presentation status')).toHaveText('ready');
  expect(
    await draftNode!.evaluate(
      (node) =>
        node.isConnected && (node.getRootNode() as ShadowRoot).querySelector('#draft') === node
    )
  ).toBe(true);
  await presentation
    .getByRole('button', { name: 'One', exact: true })
    .evaluate((button: HTMLButtonElement) => button.click());
  await expect(page.getByLabel('Action calls')).toHaveText('1');

  heldWidthText = undefined;
  draftDefault = 'Updated authored default';
  await page.setViewportSize({ width: MOBILE_WIDTH + 1, height: MOBILE_HEIGHT });
  await expect(presentation).toContainText(`Width ${MOBILE_WIDTH + 1}`);
  await expect(draft).toHaveValue('Updated authored default');
  await expect(notes).toHaveValue('Unsaved card notes');
  await expect(panelToggle).toBeChecked();

  nativeRevision = 1;
  draftDefault = 'New native draft';
  await page.getByRole('button', { name: 'Refresh native revision', exact: true }).click();
  await expect(draft).toHaveValue('New native draft');
  await expect(notes).toHaveValue('Original notes 1');
  await expect(choice).toHaveValue('third');
  await expect(panelToggle).not.toBeChecked();
  await expect(details).not.toHaveAttribute('open', '');
  await presentation.getByRole('button', { name: 'One', exact: true }).click();
  await expect(page.getByLabel('Action calls')).toHaveText('2');

  await page.getByRole('button', { name: 'Toggle preview', exact: true }).click();
  const preview = page.getByRole('region', { name: 'Preview', exact: true });
  await expect(preview.getByRole('alert')).toContainText('서버 작업을 완료하지 못했어요. (503)');
  const retryPreview = preview.getByRole('button', { name: '다시 불러오기', exact: true });
  await retryPreview.click();
  await expect(retryPreview).toBeDisabled();
  await expect(preview.getByRole('alert')).toContainText('서버 작업을 완료하지 못했어요. (503)');
  releasePreviewRetry();
  await expect(preview).toContainText(`Preview ${MOBILE_WIDTH + 1}`);
  expect(previews).toEqual([
    { width: MOBILE_WIDTH + 1, height: MOBILE_HEIGHT },
    { width: MOBILE_WIDTH + 1, height: MOBILE_HEIGHT },
  ]);
  await page.getByRole('button', { name: 'Toggle preview', exact: true }).click();
  await page.getByRole('button', { name: 'Toggle presentation', exact: true }).click();
  await expect(presentation).toHaveText('Saved original');
  const requestCount = requests.length;
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: DESKTOP_HEIGHT });
  await page.clock.fastForward(1000);
  expect(requests).toHaveLength(requestCount);
  expect(previews).toHaveLength(2);
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

{
  test.describe('native editor input', () => {
    test.use({ viewport: { width: MOBILE_WIDTH, height: 915 } });

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
      const confirm = page.getByRole('alertdialog', { name: '삭제 확인', exact: true });
      await expect(confirm).toContainText('First rule');
      expect((await value()).length).toBe(4);
      await confirm.getByRole('button', { name: '정규식 삭제', exact: true }).click();
      await expect.poll(async () => (await value()).length).toBe(3);
      await page.getByText('고급 JSON 편집', { exact: true }).click();
      await page.getByLabel('Risu 정규식 JSON', { exact: true }).fill('[invalid');
      await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
      await expect(page.getByLabel('정규식 이름', { exact: true })).toBeDisabled();
      await page.getByRole('button', { name: '다른 탭', exact: true }).click();
      await page.getByRole('button', { name: '다른 탭', exact: true }).click();
      await expect(page.getByLabel('Risu 정규식 JSON', { exact: true })).toHaveValue('[invalid');
      await page.getByRole('button', { name: '편집기에 적용', exact: true }).click();
      await expect(page.getByRole('alert')).toBeVisible();
      await page.getByRole('button', { name: '입력 되돌리기', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
      await expect
        .poll(async () => (await value())[2])
        .toEqual({ comment: 'Future rule', in: '', out: '', type: 'future_mode', unknown: [1, 2] });
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
      await selectEditorSection(page, '로어북');
      await page.getByText('조건, 배치, 원문 설정', { exact: true }).click();
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
  });
}

test('STUDIOLOC01 the active editor location follows the selected section and list item', async ({
  page,
}) => {
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: DESKTOP_HEIGHT });
  await page.goto(origin);
  await page.evaluate(async () => {
    const path = '/tests/fixtures/studio-location-editor.tsx';
    const { mount } = await import(path);
    mount();
  });
  const location = () => page.evaluate(() => window.studioLocation());
  await expect.poll(location).toEqual({ section: 'basic' });
  await selectEditorSection(page, '첫 메시지');
  await expect.poll(location).toMatchObject({ section: 'greetings', item: { index: 0 } });
  const panel = (section: string) => page.locator(`[data-studio-section="${section}"]`);
  await panel('greetings').locator('[data-studio-item="1"]').click();
  await expect.poll(location).toMatchObject({ section: 'greetings', item: { index: 1 } });
  await selectEditorSection(page, '로어북');
  await expect.poll(location).toEqual({ section: 'lore', item: { index: 0, label: 'Forest' } });
  await panel('lore').locator('[data-studio-item="1"] .nl-select').click();
  await expect.poll(location).toEqual({ section: 'lore', item: { index: 1, label: 'River' } });
  await selectEditorSection(page, '정규식');
  await expect.poll(location).toEqual({ section: 'regex', item: { index: 0, label: 'Emphasis' } });
  await panel('regex').locator('[data-studio-item="1"]').click();
  await expect.poll(location).toEqual({ section: 'regex', item: { index: 1, label: 'Quotes' } });
  await selectEditorSection(page, '기본 정보');
  await expect.poll(location).toEqual({ section: 'basic' });
  await selectEditorSection(page, '로어북');
  await expect.poll(location).toEqual({ section: 'lore', item: { index: 1, label: 'River' } });
});
