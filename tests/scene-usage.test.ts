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
  expect(html).toContain('누적 사용량');
  expect(html).toContain('aria-label="입력 한도 대비 추정 문맥"');
  expect(html).not.toContain('보고 문맥');
});

test('recorded identities and tokenizer are shown without filling historical gaps', () => {
  const html = render({
    inputTokens: 100,
    outputTokens: 20,
    context: { ...context, tokenizer: 'gemini-gemma4' },
    receipt: {
      version: 1,
      model: { modelId: 'frozen-writer', title: '당시 모델' },
      prompt: { id: 'prompt', revision: 4, title: '당시 프롬프트' },
      persona: { id: 'persona', revision: 2, title: '당시 페르소나', name: '미라' },
      summary: { status: 'included', coveredSources: 3 },
    },
  });
  expect(html).toContain('이번 생성');
  expect(html).toContain('당시 모델 · frozen-writer');
  expect(html).toContain('프롬프트 선택');
  expect(html).toContain('당시 프롬프트 · 수정 4');
  expect(html).toContain('미라 · 수정 2');
  expect(html).toContain('3개 장면 요약 포함 확인');
  expect(html).toContain('Gemini · Gemma 4 토크나이저');
  expect(render({ inputTokens: null, outputTokens: null, context: null })).toContain(
    '모델·프롬프트·페르소나·요약 기록이 없어요'
  );
});
