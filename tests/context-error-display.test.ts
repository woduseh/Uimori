import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import type { ReaderRun } from '../core/types.js';
import { ContextSummaryStatus } from '../web/ContextSummaryStatus.js';
import { ContextFailure } from '../web/context-error.js';
import { RunNotices } from '../web/RunTaskDetails.js';

const failedSummary = (error: string | null): ReaderRun['contextSummary'] => ({
  status: 'failed',
  inputTokenLimit: 8192,
  estimatedInputTokens: null,
  compactedSources: 0,
  summaryCalls: 1,
  error,
});
const summaryText = (error: string | null) =>
  renderToStaticMarkup(createElement(ContextSummaryStatus, { summary: failedSummary(error) }));
const runText = (error: string, contextSummary?: ReaderRun['contextSummary']) =>
  renderToStaticMarkup(
    createElement(RunNotices, { run: { status: 'failed', error, contextSummary } as ReaderRun })
  );

test('a stored context failure code renders its message, not the code', () => {
  expect(summaryText('CONTEXT_COMPACTION_TIMEOUT')).toContain(
    '요약이 제시간에 끝나지 않았어요. 다시 요청해 주세요.'
  );
  expect(summaryText('CONTEXT_COMPACTION_TIMEOUT')).not.toContain('CONTEXT_COMPACTION_TIMEOUT');
  expect(summaryText('MODEL_REQUIRED:context')).toContain(
    '설정 &gt; 역할별 모델에서 컨텍스트 압축 모델을 선택해 주세요.'
  );
  expect(summaryText('PROMPT_CACHE_UNSUPPORTED:block=system:index=0:model=m')).not.toContain(
    'block=system'
  );
});

test('text an older build stored renders the generic failure with the raw text under the details', () => {
  const markup = summaryText('Provider said no');
  expect(markup).toContain('컨텍스트를 압축하지 못했어요. 다시 요청해 주세요.');
  expect(markup).toMatch(
    /<details><summary>오류 상세<\/summary><pre[^>]*>Provider said no<\/pre>/u
  );
  expect(
    renderToStaticMarkup(
      createElement(ContextFailure, { error: 'Provider said no', collapsed: true })
    )
  ).not.toContain('<details>');
});

test('an interrupted context job stored before the code existed reads as interrupted', () => {
  const interrupted = '서버가 멈춰서 압축이 끝나지 않았어요. 다시 요청해 주세요.';
  for (const error of ['Server stopped; explicit retry required', 'CONTEXT_JOB_INTERRUPTED'])
    expect(renderToStaticMarkup(createElement(ContextFailure, { error }))).toBe(
      `<span>${interrupted}</span>`
    );
});

test('a run that stopped on a context code shows its message once, beside the matching summary', () => {
  const changed = runText('CONTEXT_DEPENDENCIES_CHANGED');
  expect(changed).toContain('컨텍스트를 준비하는 동안 장면이나 설정이 바뀌었어요.');
  expect(changed).not.toContain('CONTEXT_DEPENDENCIES_CHANGED');
  const timedOut = runText(
    'CONTEXT_COMPACTION_TIMEOUT',
    failedSummary('CONTEXT_COMPACTION_TIMEOUT')
  );
  expect(timedOut.split('요약이 제시간에 끝나지 않았어요.')).toHaveLength(2);
  expect(runText('CONNECTION_NOT_AUTHORIZED')).toContain('모델 연결을 쓸 수 없어요.');
  expect(runText('CONTEXT_WINDOW_EXCEEDED')).toContain('모델의 컨텍스트 창이 가득 차서');
  expect(runText('CONTEXT_TOOL_COMPACTION_FIXED_INPUT_TOO_LARGE')).toContain(
    '입력 한도가 더 큰 컨텍스트 압축 모델을 선택해 주세요.'
  );
});

test('an image the model cannot take, stored by compaction, is worded in the summary the run defers to', () => {
  const markup = runText(
    'IMAGE_INPUT_UNSUPPORTED_MODEL',
    failedSummary('IMAGE_INPUT_UNSUPPORTED_MODEL')
  );
  expect(markup).not.toContain('IMAGE_INPUT_UNSUPPORTED_MODEL');
  expect(markup).toContain('선택한 모델은 이미지 입력을 지원하지 않아요. 본문 모델을 바꿔 주세요.');
  expect(markup.split('<p class="error">')).toHaveLength(1);
});
