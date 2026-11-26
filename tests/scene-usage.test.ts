import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { SceneReceipt } from '../web/SceneUsage.js';
import { sceneCostLabels } from '../web/pricing-display.js';
import type { SceneUsageReceipt } from '../core/scene-usage.js';

const context = { estimatedInputTokens: 2048, inputTokenLimit: 8192 };
const receipt = (usage: SceneUsageReceipt) =>
  renderToStaticMarkup(createElement(SceneReceipt, { usage }));

test.each([0, 4096])(
  'provider input %s takes precedence over the local admission estimate',
  (inputTokens) => {
    const usage = { inputTokens, outputTokens: 100, inputScope: 'request' as const, context };
    const percent = inputTokens === 0 ? 0 : 50;
    expect(receipt(usage)).toContain(
      `컨텍스트 ${percent}% (${inputTokens.toLocaleString('ko-KR')} / 8,192)`
    );
    expect(receipt(usage)).toContain(`--usage-share:${percent / 100}`);
  }
);

test('an unreported input uses its retained local estimate and retains its fallback explanation', () => {
  const usage = {
    inputTokens: null,
    outputTokens: 100,
    context: { ...context, tokenizer: 'claude-legacy' as const, tokenizerFallback: true },
  };
  expect(receipt(usage)).toContain('컨텍스트 약 25% (2,048 / 8,192)');
  expect(receipt(usage)).toContain('일반 로컬 추정치를 사용했어요');
});

test('Codex turn-wide input remains usage accounting rather than request occupancy', () => {
  const usage = { inputTokens: 50000, outputTokens: 100, inputScope: 'turn' as const, context };
  expect(receipt(usage)).toContain('컨텍스트 약 25% (2,048 / 8,192)');
});

test('the receipt omits fields without a record', () => {
  const html = receipt({
    inputTokens: 10,
    outputTokens: 5,
    context: null,
    receipt: {
      version: 1,
      model: { modelId: 'writer', title: 'Writer' },
      prompt: null,
      persona: null,
      summary: null,
    },
  });
  expect(html).toContain('<dt>페르소나</dt><dd>선택 없음</dd>');
  expect(html).not.toContain('프롬프트');
  expect(html).not.toContain('대화 요약');
  expect(html).not.toContain('기록이 없어요');
  expect(html).not.toContain('scene-context');
});

test('the run text cost keeps a known subtotal apart from unpriced calls', () => {
  expect(
    sceneCostLabels({ usd: 0.0025, subtotalUsd: 0.0025, unknownCount: 0, attemptCount: 1 })
  ).toEqual({ short: '$0.0025', full: '$0.0025' });
  expect(
    sceneCostLabels({ usd: null, subtotalUsd: 0.004995, unknownCount: 1, attemptCount: 2 })
  ).toEqual({
    short: '$0.005+',
    full: '확인된 금액 합계 $0.004995, 미확인 1회 포함',
  });
  expect(
    sceneCostLabels({ usd: null, subtotalUsd: 0, unknownCount: 1, attemptCount: 1 })
  ).toBeNull();
  expect(sceneCostLabels({ usd: 0, subtotalUsd: 0, unknownCount: 0, attemptCount: 0 })).toBeNull();
  const short = (usd: number) =>
    sceneCostLabels({ usd, subtotalUsd: usd, unknownCount: 0, attemptCount: 1 })?.short;
  expect([0.3059483, 12.3456, 0.0004, 1].map(short)).toEqual([
    '$0.306',
    '$12.35',
    '< $0.001',
    '$1.00',
  ]);
});

test('a run with measured parts draws its categories and a legend instead of the single bar', () => {
  const html = receipt({
    inputTokens: null,
    outputTokens: 100,
    context: {
      ...context,
      parts: {
        prompt: 400,
        history: 1200,
        request: 48,
        appInstructions: 200,
        tools: 100,
        other: 100,
      },
    },
  });
  expect(html).toContain('컨텍스트 약 25% (2,048 / 8,192)');
  expect(html).not.toContain('scene-context-bar');
  expect(html.match(/class="context-breakdown-segment"/g)).toHaveLength(6);
  expect(html).toContain('data-tone="app"');
  for (const label of ['프롬프트', '이전 대화', '이번 요청', '앱 지시문', '도구 설명', '기타'])
    expect(html).toContain(label);
  expect(html).not.toContain('대화 요약');
  expect(html).toContain('구분 보기');
});
