import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { measureScreen, metricSource } from '../../tests/fixtures/ui-metrics.ts';
import { locatorFor, resolveUrl, runStep } from './steps.mjs';
import { defaultMetrics, viewports } from './screens.mjs';

// A journey is a sequence of steps a reader performs on the seeded fixture. Every step is
// captured after it settles, and the clicks, fills, menu opens and key presses it needed are
// counted so a review can see how many interactions each outcome costs at each width.
//
//   { id, title, actions: [<steps.mjs step>...], ready?: <locator>, urlParam?: 'chat' }
//
// `urlParam` waits until that query parameter differs from before the step (a new chat, a fork).
// Journeys run after the screens, in a light theme only, and they create real chats on the
// owned server; nothing they leave behind is reused by a screen capture.

const chatMetrics = ['header-controls', 'composer-dock', ...defaultMetrics];
const sendAction = { click: { label: '원문 생성' } };
const inMenu = { css: 'details[open] .action-menu-body' };

export const journeys = [
  {
    id: 'first-chat',
    title: '서재의 봇에서 첫 채팅, 이어가기, 포크까지',
    principles: ['P1', 'P7', 'P11', 'F4', 'F6'],
    url: { destination: 'library', tab: 'bot' },
    ready: { testid: 'library-panel' },
    steps: [
      { id: 'library', title: '서재 · 봇 탭', actions: [] },
      {
        id: 'new-chat',
        title: '새 채팅 대화상자',
        actions: [{ click: { role: 'button', name: '$bot.main.title 새 채팅' } }],
        ready: { role: 'dialog', name: '새 채팅' },
      },
      {
        id: 'created',
        title: '채팅 생성 직후',
        actions: [{ click: { role: 'button', name: '채팅 만들기' } }],
        ready: { label: '다음 장면 요청' },
        urlParam: 'chat',
        metrics: chatMetrics,
      },
      {
        id: 'first-scene',
        title: '첫 요청과 첫 장면',
        actions: [
          { fill: { label: '다음 장면 요청', text: '등대의 첫날 밤을 묘사해 주세요.' } },
          sendAction,
        ],
        ready: { testid: 'source-text' },
        metrics: [...chatMetrics, 'body-share'],
      },
      {
        id: 'second-scene',
        title: '이어가기 (둘째 장면)',
        actions: [
          { fill: { label: '다음 장면 요청', text: '아침에 배 한 척이 다가와요.' } },
          sendAction,
        ],
        ready: { testid: 'source-text', nth: 1 },
        metrics: chatMetrics,
      },
      {
        id: 'fork',
        title: '채팅 ⋯ → 채팅 포크',
        actions: [
          { menu: 'chat' },
          { click: { role: 'button', name: '채팅 포크', within: inMenu } },
        ],
        ready: { testid: 'source-text', nth: 1 },
        urlParam: 'chat',
        metrics: chatMetrics,
      },
    ],
  },
];

const journeyTheme = 'light';

export function expectedJourneyCaptures(list = journeys) {
  return list.reduce(
    (count, journey) =>
      count + journey.steps.length * (journey.viewports?.length ?? Object.keys(viewports).length),
    0
  );
}

export async function captureJourneys({
  browser,
  baseUrl,
  ids,
  directory,
  journeys: list = journeys,
  log = () => {},
}) {
  const shots = path.join(directory, 'journeys');
  await mkdir(shots, { recursive: true });
  const runs = [];
  const metrics = [];
  const failures = [];
  for (const journey of list)
    for (const vp of journey.viewports ?? Object.keys(viewports)) {
      const viewport = viewports[vp];
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        isMobile: viewport.isMobile,
        hasTouch: viewport.hasTouch,
        colorScheme: journeyTheme,
        locale: 'ko-KR',
      });
      const page = await context.newPage();
      const run = {
        journey: journey.id,
        title: journey.title,
        viewport: vp,
        width: viewport.width,
        theme: journeyTheme,
        steps: [],
        interactions: 0,
        elapsedMs: 0,
        completed: false,
      };
      const started = Date.now();
      try {
        await page.goto(resolveUrl(baseUrl, journey.url, ids), { waitUntil: 'load' });
        await locatorFor(page, journey.ready ?? { css: 'header.workspace-header' }, ids).waitFor({
          state: 'visible',
          timeout: 10_000,
        });
        for (const step of journey.steps) {
          const file = `${journey.id}-${step.id}-${viewport.width}.png`;
          const stepStarted = Date.now();
          const before = step.urlParam
            ? new URL(page.url()).searchParams.get(step.urlParam)
            : undefined;
          let interactions = 0;
          try {
            for (const action of step.actions) {
              // Counted as they happen so a step that fails afterwards still reports its cost.
              const count = await runStep(page, action, ids);
              interactions += count;
              run.interactions += count;
            }
            if (step.urlParam)
              await page.waitForURL((url) => url.searchParams.get(step.urlParam) !== before, {
                timeout: 15_000,
              });
            if (step.ready)
              await locatorFor(page, step.ready, ids).waitFor({
                state: 'visible',
                timeout: 15_000,
              });
            await page.waitForTimeout(step.settle ?? 300);
            await page.screenshot({ path: path.join(shots, file) });
            const results = await measureScreen(page, step.metrics ?? defaultMetrics, {
              compact: viewport.width <= 760,
            });
            for (const result of results)
              metrics.push({
                journey: journey.id,
                step: step.id,
                viewport: vp,
                width: viewport.width,
                theme: journeyTheme,
                ...result,
                source: metricSource,
              });
            run.steps.push({
              step: step.id,
              title: step.title,
              at: new Date(stepStarted).toISOString(),
              interactions,
              cumulativeInteractions: run.interactions,
              elapsedMs: Date.now() - stepStarted,
              url: new URL(page.url()).search,
              file: `journeys/${file}`,
            });
            log(`journey ${file} (${interactions} interactions)`);
          } catch (error) {
            failures.push(
              `${journey.id} ${step.id} ${vp}: ${String(error.message).split('\n')[0]}`
            );
            run.failedStep = { step: step.id, interactions };
            await page
              .screenshot({ path: path.join(shots, file.replace(/\.png$/u, '-failed.png')) })
              .catch(() => {});
            break;
          }
        }
        run.completed = run.steps.length === journey.steps.length;
      } catch (error) {
        failures.push(`${journey.id} ${vp}: ${String(error.message).split('\n')[0]}`);
      } finally {
        run.elapsedMs = Date.now() - started;
        runs.push(run);
        await context.close();
      }
    }
  return { runs, metrics, failures };
}
