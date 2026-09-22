import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { createApp, type App } from '../server/app.js';
import {
  modelWorkspace,
  updateModelWorkspace,
  promptWorkspace,
  updatePromptWorkspace,
} from '../server/prompt-workspace.js';
import { prepareRisuPresetImport, applyRisuPresetImport } from '../server/risu-preset-import.js';
import { readChatVariables } from '../server/chat-variables.js';
import type { Connection, ModelPreset } from '../core/product.js';
import type { RisuImportResult } from '../core/risu-import.js';
import { loopbackProvider, writeSse } from './fixtures/loopback-provider.js';
import { navigationAction } from './ui-navigation.js';
import {
  DESKTOP_WIDTH,
  DESKTOP_HEIGHT,
  MOBILE_WIDTH,
  MOBILE_HEIGHT,
} from './fixtures/browser-viewports.js';

// Explicit local opt-in. Original cards stay outside the repository and are never modified.
const sampleRoot = process.env.UIMORI_RISU_SAMPLE_ROOT;
const diagnostic = process.env.UIMORI_RISU_SAMPLE_DIAGNOSTIC === '1';
const presetPath = process.env.UIMORI_RISU_SAMPLE_PRESET;
const visualReview = process.env.UIMORI_VISUAL_REVIEW === '1';
test.use({ trace: 'off', screenshot: 'off' });
const cases = [
  {
    id: 'RISUSAMPLE01',
    path: ['Reference', 'Cheongwon High School.charx'],
    language: 'setLangToEnglish',
    choices: ['setFirst1', 'setFirst2'],
    expected: { lang: '1', first: '1' },
    alternate: { lang: '1', first: '2' },
  },
  {
    id: 'RISUSAMPLE02',
    path: ['Reference', 'Harper.charx'],
    language: 'lang1',
    choices: ['greeting1', 'greeting2'],
    expected: { lang: '1', greeting: '1' },
    alternate: { lang: '1', greeting: '2' },
    images: 2,
  },
  {
    id: 'RISUSAMPLE03',
    path: ['Fujimiya Hinano', 'Fujimiya Hinano_v2.4.3-test.charx'],
    language: 'onLangEn',
    setup: 'initAff70',
    choices: ['scenario_g1', 'scenario_g2'],
    expected: { uiLang: 'en', greeting: '1' },
    alternate: { uiLang: 'en', greeting: '2' },
    images: 1,
  },
  {
    id: 'RISUSAMPLE04',
    path: ['Project Vela — 7 Years Later.charx'],
    language: '',
    choices: ['', ''],
    expected: {},
    alternate: {},
  },
] as const;

test.describe('actual local native Risu cards', () => {
  test.skip(
    !sampleRoot,
    'Set UIMORI_RISU_SAMPLE_ROOT to opt into private local sample acceptance.'
  );
  test.setTimeout(240_000);
  test.use({
    viewport: { width: DESKTOP_WIDTH, height: DESKTOP_HEIGHT },
  });
  let app: App;
  let provider: Awaited<ReturnType<typeof loopbackProvider>>;
  let request: APIRequestContext;
  let origin: string;
  let directory: string;
  let originalPresetHash: string | undefined;

  test.beforeAll(async ({ playwright }) => {
    for (const sample of cases)
      if (!existsSync(join(sampleRoot!, ...sample.path)))
        throw new Error(`Missing explicitly opted-in local sample: ${sample.id}`);
    provider = await loopbackProvider(async (received, response) => {
      const body = JSON.parse(received.body) as { modelId?: string };
      await writeSse(response, [
        {
          type: 'text_delta',
          delta: body.modelId === 'sample-auxiliary' ? '{}' : 'NATIVE_ACCEPTANCE_RESPONSE',
        },
        { type: 'usage', inputTokens: 12, outputTokens: 4, costUsd: null },
        { type: 'done', reason: 'stop' },
      ]);
    });
    directory = mkdtempSync(join(tmpdir(), 'uimori-native-samples-'));
    app = await createApp({
      dbPath: join(directory, 'test.sqlite'),
      buildId: process.env.UIMORI_BUILD_ID ?? 'native-samples-local',
      instanceId: 'native-samples-browser',
      testMode: true,
      webRoot: resolve('dist/web'),

      codex: { enabled: false },
    });
    const connection = app.store.product.connection({
      title: 'Local sample fixture',
      protocol: 'fixture-sse-v1',
      endpoint: provider.endpoint,
      enabled: true,
    }) as Connection;
    const models = ['sample-writer', 'sample-auxiliary'].map(
      (modelId) =>
        app.store.product.model({
          title: modelId,
          connectionId: connection.id,
          modelId,
          maxOutputTokens: 128,
          temperature: null,
        }) as ModelPreset
    );
    const workspace = modelWorkspace(app.store);
    updateModelWorkspace(app.store, {
      expectedRevision: workspace.revision,
      routes: { ...workspace.routes, main: { id: models[0].id } },
      scriptModel: { id: models[1].id },
      translationPolicy: workspace.translationPolicy,
    });
    if (presetPath) {
      const bytes = readFileSync(presetPath);
      originalPresetHash = createHash('sha256').update(bytes).digest('hex');
      const source = { name: basename(presetPath), base64: bytes.toString('base64') };
      const preview = prepareRisuPresetImport({ source });
      expect(
        preview.findings
          .filter((finding) => finding.level === 'unsupported')
          .map((finding) => finding.code)
      ).toEqual([]);
      const { preset } = applyRisuPresetImport(app.store, {
        source,
        digest: preview.digest,
        allowPartial: false,
        idempotencyKey: 'local-sample-preset',
      });
      const current = promptWorkspace(app.store);
      updatePromptWorkspace(
        app.store,
        {
          expectedRevision: current.revision,
          main: {
            title: preset.title,
            program: preset.program,
            values: preset.values,
          },
        },
        { role: 'main', id: preset.id }
      );
    }
    origin = await app.listen({ port: 0, host: '127.0.0.1' });
    request = await playwright.request.newContext({ baseURL: origin });
  });

  test.afterAll(async () => {
    if (presetPath && originalPresetHash)
      expect(
        createHash('sha256').update(readFileSync(presetPath)).digest('hex') === originalPresetHash,
        'Original local preset remains unchanged'
      ).toBe(true);
    await request?.dispose();
    await app?.close();
    await provider?.close();
    if (directory) {
      const target = resolve(directory);
      if (!target.startsWith(resolve(tmpdir()) + sep))
        throw new Error('Refusing cleanup outside the owned temporary directory');
      rmSync(target, { recursive: true, force: true });
    }
  });

  async function clickAuthored(page: Page, name: string, scope = '') {
    const frame = page.locator('.risu-message-surface').first();
    const control = frame
      .locator(`${scope} [risu-trigger="${name}"], ${scope} [risu-btn="${name}"]`)
      .first();
    await expect(control).toBeVisible({ timeout: 20_000 });
    const pending = page.waitForResponse(
      (response) =>
        response.url().endsWith('/risu-action') && response.request().method() === 'POST',
      { timeout: 30_000 }
    );
    await control.click();
    const response = await pending;
    expect(response.status(), `Authored action ${name} HTTP status`).toBe(200);
    await settledFrame(page);
    await expect(page.getByText('봇의 선택을 반영하지 못했어요. 다시 시도해 주세요.')).toHaveCount(
      0
    );
  }

  async function settledFrame(page: Page, position: 'first' | 'last' = 'first') {
    const surface = page.locator('.risu-message-surface')[position]();
    await expect(surface).toBeVisible();
    await expect(surface.locator('.risu-message-content')).toHaveAttribute(
      'data-risu-disabled',
      'false'
    );
    await expect
      .poll(() =>
        surface.evaluate(async (host) => {
          await document.fonts.ready;
          const bounds = host.getBoundingClientRect();
          const content = host.shadowRoot!.querySelector('.risu-message-content')!;
          const rect = content.getBoundingClientRect();
          const controls = [
            ...content.querySelectorAll('button,label,a,[role="button"],[risu-trigger],[risu-btn]'),
          ];
          const clipped = controls.filter((control) => {
            const box = control.getBoundingClientRect();
            if (!box.width || !box.height || box.right <= bounds.left || box.left >= bounds.right)
              return false;
            let fixed = false;
            for (
              let node: Element | null = control;
              node && node !== content;
              node = node.parentElement
            ) {
              const style = getComputedStyle(node);
              if (style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
              if (style.position === 'fixed') fixed = true;
            }
            return fixed && (box.top < bounds.top - 1 || box.bottom > bounds.bottom + 1);
          });
          return {
            heightDeficit: Math.max(0, rect.bottom - bounds.bottom - 1),
            clippedFixedControls: clipped.length,
          };
        })
      )
      .toEqual({ heightDeficit: 0, clippedFixedControls: 0 });
  }

  for (const sample of cases) {
    test(`${sample.id} original first-screen controls survive selection, reload, branch and a local writing turn`, async ({
      page,
    }, info) => {
      const file = join(sampleRoot!, ...sample.path);
      const hash = () => createHash('sha256').update(readFileSync(file)).digest('hex');
      const originalHash = hash();
      const externalRequests: string[] = [];
      await page.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        if (/^https?:$/.test(url.protocol) && url.origin !== origin) {
          externalRequests.push(url.origin);
          await route.abort();
        } else await route.continue();
      });
      await page.goto(origin);
      await navigationAction(page, '봇');
      await page.getByRole('button', { name: '자료 가져오기', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '자료 가져오기', exact: true });
      const preparation = page.waitForResponse(
        (response) => response.url().endsWith('/api/risu-imports/prepare'),
        { timeout: 90_000 }
      );
      await dialog.getByLabel('Risu 파일 선택', { exact: true }).setInputFiles(file);
      const prepared = await preparation;
      expect(prepared.status(), 'Local CHARX prepare').toBe(200);
      const preview = (await prepared.json()) as { findings: { code: string; level: string }[] };
      const unsupported = preview.findings
        .filter((finding) => finding.level === 'unsupported')
        .map((finding) => finding.code);
      await info.attach('import-findings', {
        body: JSON.stringify({ diagnostic, unsupported }),
        contentType: 'application/json',
      });
      const partial = dialog.getByLabel('위 미지원 항목이 반영되지 않는 부분 가져오기에 동의해요.');
      if (diagnostic && unsupported.length) await partial.check();
      else
        expect(unsupported, 'Final acceptance requires no unsupported imported features').toEqual(
          []
        );
      await expect(
        dialog.getByRole('button', { name: '가져오고 새 채팅 열기', exact: true })
      ).toBeEnabled();
      if (!diagnostic) await expect(partial).toHaveCount(0);
      const applying = page.waitForResponse(
        (response) => response.url().endsWith('/api/risu-imports/apply'),
        { timeout: 90_000 }
      );
      await dialog.getByRole('button', { name: '가져오고 새 채팅 열기', exact: true }).click();
      const applied = await applying;
      expect(applied.ok(), 'Local CHARX apply').toBe(true);
      const imported = (await applied.json()) as RisuImportResult;
      const chat = imported.chat!;
      expect(chat).not.toBeNull();
      const main = app.store.product.branch(chat.id);
      const forkResponse = await request.post(`/api/chats/${chat.id}/branches`, {
        data: { title: 'Acceptance alternative', fromRevision: main.headRevision },
      });
      expect(forkResponse.ok(), 'Fork before choosing').toBe(true);
      const fork = (await forkResponse.json()) as { id: string };
      await settledFrame(page);
      if (visualReview)
        await page.screenshot({ path: info.outputPath(`${sample.id}-opening.png`) });
      await page.setViewportSize({ width: MOBILE_WIDTH, height: MOBILE_HEIGHT });
      await settledFrame(page);
      if (sample.language) await clickAuthored(page, sample.language);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
        'Mobile opening stays within the host viewport'
      ).toBe(true);
      if (visualReview)
        await page.screenshot({ path: info.outputPath(`${sample.id}-mobile-opening.png`) });
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: DESKTOP_HEIGHT });

      if (sample.id === 'RISUSAMPLE01') {
        await clickAuthored(page, sample.language);
        const frame = page.locator('.risu-message-surface').first();
        const panel = frame.locator('.settings-side-panel-cw');
        const toggle = frame.locator('#settings-toggle-cw');
        const label = frame.locator('label[for="settings-toggle-cw"]');
        const panelGeometry = () =>
          panel.evaluate((element) => {
            const rect = element.getBoundingClientRect();
            const bounds = (element.getRootNode() as ShadowRoot).host.getBoundingClientRect();
            return {
              left: rect.left - bounds.left,
              right: rect.right - bounds.left,
              top: rect.top - bounds.top,
              bottom: rect.bottom - bounds.top,
              viewportWidth: bounds.width,
              viewportHeight: bounds.height,
              scrollHeight: element.scrollHeight,
              clientHeight: element.clientHeight,
            };
          });
        const openPanel = async () => {
          await expect(toggle).not.toBeChecked();
          await label.click();
          await expect(toggle).toBeChecked();
          await expect
            .poll(async () => {
              const box = await panelGeometry();
              return (
                box.left >= 0 &&
                box.right <= box.viewportWidth + 1 &&
                box.top >= 0 &&
                box.bottom <= box.viewportHeight + 1
              );
            })
            .toBe(true);
        };
        const closePanel = async () => {
          await label.click();
          await expect(toggle).not.toBeChecked();
          await expect
            .poll(async () => {
              const box = await panelGeometry();
              return box.left >= box.viewportWidth || box.right <= 0;
            })
            .toBe(true);
        };
        await openPanel();
        await info.attach('cheongwon-settings-panel-geometry', {
          body: JSON.stringify(await panelGeometry()),
          contentType: 'application/json',
        });
        if (visualReview)
          await page.screenshot({ path: info.outputPath(`${sample.id}-settings-panel-open.png`) });
        await closePanel();
        for (const language of [
          { action: 'setLangToKorean', value: '0', title: '설정', suffix: 'ko' },
          { action: 'setLangToEnglish', value: '1', title: 'Settings', suffix: 'en' },
        ]) {
          await openPanel();
          const languageButton = panel.locator(`[risu-trigger="${language.action}"]`);
          // The authored panel deliberately scrolls within its max-height viewport.
          await languageButton.evaluate((element) => element.scrollIntoView({ block: 'nearest' }));
          await clickAuthored(page, language.action, '.settings-side-panel-cw');
          expect(readChatVariables(app.store, chat.id, main.id).values.lang).toBe(language.value);
          await expect(frame.locator('.cwhs-panel-header')).toContainText(language.title);
          await expect(
            frame.locator(`.cwhs-panel-container [risu-trigger="${language.action}"]`)
          ).toHaveCSS('color', 'rgb(85, 234, 208)');
          await openPanel();
          await expect(languageButton).toHaveClass(/\bactive\b/);
          if (visualReview)
            await page.screenshot({
              path: info.outputPath(`${sample.id}-settings-panel-${language.suffix}.png`),
            });
          await closePanel();
        }
      }

      const choose = async (choice: string) => {
        if (sample.language) await clickAuthored(page, sample.language);
        if ('setup' in sample) await clickAuthored(page, sample.setup);
        if (choice) await clickAuthored(page, choice);
      };
      await choose(sample.choices[0]);
      expect(readChatVariables(app.store, chat.id, main.id).values).toMatchObject(sample.expected);
      await page.reload();
      await settledFrame(page);
      expect(readChatVariables(app.store, chat.id, main.id).values).toMatchObject(sample.expected);
      if ('images' in sample) {
        const images = page.locator('.risu-message-surface').first().locator('img');
        await expect.poll(() => images.count()).toBeGreaterThanOrEqual(sample.images);
        await expect
          .poll(() =>
            images.evaluateAll((nodes) =>
              nodes.every(
                (node) => node instanceof HTMLImageElement && node.complete && node.naturalWidth > 0
              )
            )
          )
          .toBe(true);
        await expect(page.getByText('asset:daily_annyoed.webp', { exact: true })).toHaveCount(0);
        await settledFrame(page);
      }
      if (visualReview)
        await page.screenshot({ path: info.outputPath(`${sample.id}-selected.png`) });
      await page.setViewportSize({ width: MOBILE_WIDTH, height: MOBILE_HEIGHT });
      await settledFrame(page);
      if ('images' in sample) {
        const images = page.locator('.risu-message-surface').first().locator('img');
        await expect
          .poll(() =>
            images.evaluateAll((nodes) =>
              nodes.every(
                (node) => node instanceof HTMLImageElement && node.complete && node.naturalWidth > 0
              )
            )
          )
          .toBe(true);
      }
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
        'Mobile host page stays within the viewport'
      ).toBe(true);
      await expect(page.getByLabel('다음 장면 요청', { exact: true })).toBeVisible();
      if (visualReview)
        await page.screenshot({ path: info.outputPath(`${sample.id}-mobile-selected.png`) });
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: DESKTOP_HEIGHT });

      await page.goto(
        `${origin}/?chat=${encodeURIComponent(chat.id)}&branch=${encodeURIComponent(fork.id)}`
      );
      await choose(sample.choices[1]);
      expect(readChatVariables(app.store, chat.id, fork.id).values).toMatchObject(sample.alternate);
      expect(readChatVariables(app.store, chat.id, main.id).values).toMatchObject(sample.expected);

      const current = app.store.chat(chat.id);
      app.store.settings(chat.id, current.settingsRevision, {
        ...current.settings,
        mode: 'direct',
        translation: false,
        status: false,
        maxCalls: 8,
      });
      await page.goto(
        `${origin}/?chat=${encodeURIComponent(chat.id)}&branch=${encodeURIComponent(main.id)}`
      );
      const marker = `${sample.id}_CONTINUE`;
      await page.getByLabel('다음 장면 요청', { exact: true }).fill(marker);
      const running = page.waitForResponse(
        (response) =>
          response.url().endsWith(`/api/chats/${chat.id}/runs`) &&
          response.request().method() === 'POST'
      );
      await page.getByRole('button', { name: '원문 생성', exact: true }).click();
      const started = await running;
      expect(started.status(), 'Start a local writing turn').toBe(200);
      const runId = ((await started.json()) as { id: string }).id;
      await expect
        .poll(() => app.store.run(runId).status, { timeout: 60_000 })
        .not.toMatch(/queued|running/);
      const run = app.store.run(runId);
      expect(run.status, run.error ?? 'Local writing result').toBe('completed');
      expect(run.snapshot.nativeRisuExecution?.variables).toMatchObject(sample.expected);
      expect(provider.requests.some((received) => received.body.includes(marker))).toBe(true);
      expect(
        app.store.source(run.sourceRevision!).text.includes('NATIVE_ACCEPTANCE_RESPONSE')
      ).toBe(true);
      await page.reload();
      const renderedResponse = page
        .locator('.risu-message-surface')
        .last()
        .getByText('NATIVE_ACCEPTANCE_RESPONSE', { exact: false });
      await expect(renderedResponse).toBeVisible();
      await settledFrame(page, 'last');
      // Authored animations may never satisfy Playwright's actionability stability check.
      // Scroll the outer reader and the native message directly, then verify visibility.
      await page
        .locator('.risu-message-surface')
        .last()
        .evaluate((element) => element.scrollIntoView({ block: 'end' }));
      await renderedResponse.evaluate((element) => element.scrollIntoView({ block: 'center' }));
      await expect(renderedResponse).toBeInViewport({ timeout: 10_000 });
      if (visualReview)
        await page.screenshot({ path: info.outputPath(`${sample.id}-response.png`) });
      expect(readChatVariables(app.store, chat.id, fork.id).values).toMatchObject(sample.alternate);
      // This fixture intercepts external assets for deterministic local execution.
      // The personal-card renderer no longer promises iframe-level network isolation.
      await info.attach('intercepted-external-origins', {
        body: JSON.stringify([...new Set(externalRequests)]),
        contentType: 'application/json',
      });
      expect(hash(), 'Original local card remains unchanged').toBe(originalHash);
    });
  }
});
