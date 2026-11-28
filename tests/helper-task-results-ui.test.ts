import { createElement, type ContextType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import type { HelperTaskAttemptUsage, HelperTaskResultsView } from '../core/helper.js';
import { HelperTaskResultItems, HelperTaskUsageRecord } from '../web/HelperTaskResults.js';
import { ThemeContext } from '../web/ThemeContext.js';
import { traceUsageTotals as helperTaskUsageTotals } from '../web/TaskTrace.js';

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

const record = (usage: Partial<HelperTaskResultsView['usage']>) =>
  renderToStaticMarkup(
    createElement(HelperTaskUsageRecord, {
      usage: { attempts: [], toolExecutions: 0, latestInputEstimate: null, ...usage },
    })
  );

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

test('a theme saved twice in one task shows its Story UI preview once', () => {
  const theme = (operation: string, eventSeq: number) => ({
    eventSeq,
    receiptId: `receipt-${eventSeq}`,
    operation,
    requestedTargets: 1,
    changedTargets: 1,
    targets: [{ kind: 'theme' as const, id: 'harbor-theme', title: 'Harbor', revision: eventSeq }],
  });
  const data: HelperTaskResultsView = {
    taskId: 'task',
    status: 'completed',
    results: [theme('resource.save', 1), theme('resource.patch', 2)],
    confirmations: [],
    unrecordedOperations: 0,
    usage: { attempts: [], toolExecutions: 2, latestInputEstimate: null },
  };
  const html = renderToStaticMarkup(
    createElement(
      ThemeContext.Provider,
      {
        value: {
          catalog: {
            themes: [{ id: 'harbor-theme', storyUi: { baseStyle: 'classic', css: '.story-ui{}' } }],
          },
        } as unknown as ContextType<typeof ThemeContext>,
      },
      createElement(HelperTaskResultItems, { data })
    )
  );
  expect(html.match(/helper-story-ui-preview/gu)).toHaveLength(1);
});
