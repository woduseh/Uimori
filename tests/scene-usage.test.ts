import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { SceneUsage } from '../web/SceneUsage.js';
import type { SceneUsageReceipt } from '../core/scene-usage.js';

const context = { estimatedInputTokens: 2048, inputTokenLimit: 8192 };
const render = (usage: SceneUsageReceipt) =>
  renderToStaticMarkup(createElement(SceneUsage, { usage }));

test.each([0, 4096])(
  'provider input %s takes precedence over the local admission estimate',
  (inputTokens) => {
    const html = render({ inputTokens, outputTokens: 100, inputScope: 'request', context });
    expect(html).toContain(`컨텍스트 사용량 ${inputTokens === 0 ? 0 : 50}%`);
    expect(html).toContain('aria-label="컨텍스트 한도 대비 입력"');
    expect(html).toContain(`value="${inputTokens}"`);
    expect(html).toContain(`입력 ${inputTokens.toLocaleString('ko-KR')} / 컨텍스트 한도 8,192`);
  }
);

test('an unreported input uses its retained local estimate and retains its fallback explanation', () => {
  const html = render({
    inputTokens: null,
    outputTokens: 100,
    context: { ...context, tokenizer: 'claude-legacy', tokenizerFallback: true },
  });
  expect(html).toContain('요청 미확인');
  expect(html).toContain('컨텍스트 사용량 약 25%');
  expect(html).toContain('입력 약 2,048 / 컨텍스트 한도 8,192');
  expect(html).toContain('aria-label="컨텍스트 한도 대비 추정 입력"');
  expect(html).toContain('value="2048"');
  expect(html).toContain('일반 로컬 추정치를 사용했어요');
});

test('Codex turn-wide input remains usage accounting rather than request occupancy', () => {
  const html = render({ inputTokens: 50000, outputTokens: 100, inputScope: 'turn', context });
  expect(html).toContain('요청 50,000');
  expect(html).toContain('컨텍스트 사용량 약 25%');
  expect(html).toContain('value="2048"');
  expect(html).toContain('aria-label="컨텍스트 한도 대비 추정 입력"');
  expect(html).not.toContain('aria-label="컨텍스트 한도 대비 입력"');
});

test('the run text cost keeps a known subtotal apart from unpriced calls', () => {
  const usage = { inputTokens: 10, outputTokens: 5, context };
  const cost = (estimatedCost: {
    usd: number | null;
    subtotalUsd: number;
    unknownCount: number;
    attemptCount: number;
  }) => renderToStaticMarkup(createElement(SceneUsage, { usage, estimatedCost }));
  expect(cost({ usd: 0.0025, subtotalUsd: 0.0025, unknownCount: 0, attemptCount: 1 })).toContain(
    '본문 추정 비용: $0.0025'
  );
  expect(cost({ usd: null, subtotalUsd: 0.004995, unknownCount: 1, attemptCount: 2 })).toContain(
    '본문 추정 비용: 확인된 금액 합계 $0.004995, 미확인 1회 포함'
  );
  expect(cost({ usd: null, subtotalUsd: 0, unknownCount: 1, attemptCount: 1 })).toContain(
    '확인된 금액 합계 미확인, 미확인 1회 포함'
  );
  expect(cost({ usd: 0, subtotalUsd: 0, unknownCount: 0, attemptCount: 0 })).not.toContain(
    '본문 추정 비용'
  );
});
