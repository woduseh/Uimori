import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import type {
  HelperChange,
  HelperTaskAttemptUsage,
  HelperTaskResultsView,
} from '../core/helper.js';
import { diffText } from '../core/text-diff.js';
import { HelperTaskResultItems, HelperTaskUsageRecord } from '../web/HelperTaskResults.js';
import { traceUsageTotals as helperTaskUsageTotals } from '../web/TaskTrace.js';
import { helperChangeLocationParts } from '../web/helper-change-location.js';

const attempt = (overrides: Partial<HelperTaskAttemptUsage>): HelperTaskAttemptUsage => ({
  id: 'execution',
  kind: 'helper',
  owner: 'helper',
  sceneRunId: null,
  purpose: 'helper',
  modelId: 'fixture-helper',
  status: 'completed',
  startedAt: null,
  elapsedMs: null,
  firstByteMs: null,
  inputTokens: null,
  outputTokens: null,
  cachedInputTokens: null,
  reasoningTokens: null,
  internalModelCalls: null,
  costUsd: null,
  estimatedUsd: null,
  estimatedSubtotalUsd: 0,
  tools: [],
  ...overrides,
});

test('helper usage preserves partial totals and unknown requests without counting subsets twice', () => {
  const totals = helperTaskUsageTotals([
    attempt({
      inputTokens: 300,
      outputTokens: 40,
      cachedInputTokens: 200,
      reasoningTokens: 10,
      costUsd: 0.02,
      internalModelCalls: 3,
    }),
    attempt({ inputTokens: 100, outputTokens: 0, costUsd: 0 }),
    attempt({}),
  ]);
  expect(totals.inputTokens).toEqual({ value: 400, reported: 2, unknown: 1 });
  expect(totals.outputTokens).toEqual({ value: 40, reported: 2, unknown: 1 });
  expect(totals.cachedInputTokens).toEqual({ value: 200, reported: 1, unknown: 2 });
  expect(totals.reasoningTokens).toEqual({ value: 10, reported: 1, unknown: 2 });
  expect(totals.costUsd).toEqual({ value: 0.02, reported: 2, unknown: 1 });
  expect(totals.internalModelCalls).toEqual({ value: 3, reported: 1, unknown: 2 });
});

test('missing provider usage is distinguishable from a reported zero and no requests', () => {
  expect(helperTaskUsageTotals([attempt({})]).costUsd).toEqual({
    value: 0,
    reported: 0,
    unknown: 1,
  });
  expect(helperTaskUsageTotals([attempt({ costUsd: 0 })]).costUsd).toEqual({
    value: 0,
    reported: 1,
    unknown: 0,
  });
  expect(helperTaskUsageTotals([]).costUsd).toEqual({ value: 0, reported: 0, unknown: 0 });
});

test('package settings a helper change names read as the editor sections that hold them', () => {
  const name = (path: string[]) =>
    helperChangeLocationParts({ kind: 'resource-field', path }).map((part) => part.text);
  expect(name(['package', 'portraitImageId'])).toEqual(['기본 정보']);
  expect(name(['package', 'loreActivation', 'mode'])).toEqual(['로어북']);
  expect(name(['package', 'modules'])).toEqual(['함께 쓰는 모듈']);
  expect(name(['package', 'imageHandoff', 'enabled'])).toEqual(['배경 HTML과 CSS']);
  expect(name(['package', 'nativeRisu', 'card', 'creator_notes'])).toEqual([
    '기본 정보',
    '제작 정보',
  ]);
});

const changed = (targetId: string, title: string): HelperChange => ({
  domain: 'resource',
  targetId,
  title,
  location: { kind: 'resource-field', path: ['description'] },
  action: 'update',
  diff: diffText('등대지기는 잠들었다.', '등대지기는 깨어 있었다.', 'prose'),
  anchor: null,
});
const items = (changes: HelperChange[], review: boolean) =>
  renderToStaticMarkup(
    createElement(HelperTaskResultItems, {
      taskId: 'task',
      status: 'completed',
      rollbackUnavailable: false,
      review,
      data: {
        taskId: 'task',
        status: 'completed',
        results: [],
        changes,
        confirmations: [],
        unrecordedOperations: 0,
        usage: { attempts: [], toolExecutions: 0, latestInputEstimate: null },
      },
    })
  );
const openDiffs = (html: string) => html.match(/aria-expanded="true"/g)?.length ?? 0;

test('the latest finished task opens the diff of its only change and leaves several closed', () => {
  const single = items([changed('bot-a', '하린')], true);
  expect(openDiffs(single)).toBe(1);
  expect(single).toContain('깨어');
  expect(openDiffs(items([changed('bot-a', '하린')], false))).toBe(0);
  expect(openDiffs(items([changed('bot-a', '하린'), changed('bot-b', '서윤')], true))).toBe(0);
});

const record = (usage: Partial<HelperTaskResultsView['usage']>) =>
  renderToStaticMarkup(
    createElement(HelperTaskUsageRecord, {
      usage: { attempts: [], toolExecutions: 0, latestInputEstimate: null, ...usage },
    })
  );

test('the usage record shows cumulative shares and hides an unknown cost', () => {
  const html = record({
    attempts: [
      attempt({ inputTokens: 1000, outputTokens: 90, cachedInputTokens: 600, reasoningTokens: 30 }),
    ],
    toolExecutions: 2,
  });
  expect(html).toContain('모델 1회');
  expect(html).toContain('도구 2회');
  expect(html).toContain('(캐시 600, 60%)');
  expect(html).toContain('(추론 30, 33%)');
  expect(html).not.toContain('data-row="cost"');
  expect(html).not.toContain('미확인');
});

test('a partly priced task reads as a lower bound with its unpriced calls', () => {
  const html = record({
    attempts: [attempt({ inputTokens: 10, outputTokens: 5, costUsd: 0.02 }), attempt({})],
  });
  expect(html).toContain('data-row="cost"');
  expect(html).toContain('$0.02+');
  expect(html).toContain('미확인 1회');
});

test('the summary prices a call by its reported cost before its estimate and keeps three digits', () => {
  const html = record({
    attempts: [
      attempt({ inputTokens: 10, outputTokens: 5, costUsd: 0.012345, estimatedUsd: 0.5 }),
      attempt({ inputTokens: 10, outputTokens: 5, estimatedUsd: 0.0004321 }),
    ],
  });
  expect(html).toContain('<dt>비용</dt>');
  expect(html).toContain('$0.0128');
  expect(html).not.toContain('이상');
});

test('the latest request context shows its parts against the budget', () => {
  const html = record({
    latestInputEstimate: 1000,
    latestInputTokens: 980,
    latestInputLimit: 4000,
    latestInputExecution: 'provider-tool-loop',
    latestInputParts: {
      instructions: 100,
      toolSchemas: 200,
      history: 500,
      source: null,
      toolResults: null,
    },
  });
  expect(html).toContain('마지막 요청 컨텍스트 약 1,000 / 4,000');
  expect(html).toContain('보고된 입력 980');
  expect(html.match(/class="context-breakdown-segment"/g)).toHaveLength(4);
  expect(html).toContain('data-part="other"');
  expect(html).toContain('구분 보기');
});

test('a native Codex task reports its exact input without a bar', () => {
  const html = record({
    latestInputEstimate: 1000,
    latestInputTokens: 90_040,
    latestInputLimit: 4000,
    latestInputExecution: 'codex-native',
    latestInputParts: null,
  });
  expect(html).toContain('마지막 요청 입력 90,040');
  expect(html).not.toContain('context-breakdown-bar');
  expect(html).not.toContain('약 1,000');
});
