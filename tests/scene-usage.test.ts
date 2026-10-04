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
    expect(html).toContain(`문맥 ${inputTokens === 0 ? 0 : 50}%`);
    expect(html).toContain('aria-label="입력 한도 대비 보고 문맥"');
    expect(html).toContain(`value="${inputTokens}"`);
    expect(html).toContain('전송 전 로컬 추정은 2,048 토큰');
  }
);

test('an unreported input uses its retained local estimate and makes tokenizer fallback visible', () => {
  const html = render({
    inputTokens: null,
    outputTokens: 100,
    context: { ...context, tokenizer: 'claude-legacy', tokenizerFallback: true },
  });
  expect(html).toContain('요청 미확인');
  expect(html).toContain('문맥 약 25%');
  expect(html).toContain('aria-label="입력 한도 대비 추정 문맥"');
  expect(html).toContain('value="2048"');
  expect(html).toContain('일반 로컬 추정치를 사용했어요');
});

test('Codex turn-wide input remains usage accounting rather than request occupancy', () => {
  const html = render({ inputTokens: 50000, outputTokens: 100, inputScope: 'turn', context });
  expect(html).toContain('요청 50,000');
  expect(html).toContain('문맥 약 25%');
  expect(html).toContain('value="2048"');
  expect(html).toContain('보고 누적 토큰');
  expect(html).toContain('공급자 내부 후속 작업은 포함하지 않아요');
  expect(html).not.toContain('보고 문맥');
});
