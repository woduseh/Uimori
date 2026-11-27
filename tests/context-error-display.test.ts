import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import type { ReaderRun } from '../core/types.js';
import { ContextSummaryStatus } from '../web/ContextSummaryStatus.js';
import { contextErrorMessage } from '../web/context-error.js';
import { RunNotices } from '../web/RunTaskDetails.js';
import { formatUiMessage } from '../web/ui-message.js';

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

test('a stored context failure code renders its message, and text stored before codes renders verbatim', () => {
  expect(summaryText('CONTEXT_COMPACTION_TIMEOUT')).toContain(
    '요약이 제시간에 끝나지 않았어요. 다시 요청해 주세요.'
  );
  expect(summaryText('CONTEXT_COMPACTION_TIMEOUT')).not.toContain('CONTEXT_COMPACTION_TIMEOUT');
  expect(summaryText('MODEL_REQUIRED:context')).toContain(
    '설정 &gt; 역할별 모델에서 컨텍스트 압축 모델을 선택해 주세요.'
  );
  expect(summaryText('Provider said no')).toContain('Provider said no');
});

test('an interrupted context job stored before the code existed reads as interrupted', () => {
  expect(formatUiMessage(contextErrorMessage('Server stopped; explicit retry required'))).toBe(
    formatUiMessage(contextErrorMessage('CONTEXT_JOB_INTERRUPTED'))
  );
  expect(formatUiMessage(contextErrorMessage('CONTEXT_JOB_INTERRUPTED'))).toBe(
    '서버가 멈춰서 압축이 끝나지 않았어요. 다시 요청해 주세요.'
  );
});

test('a run that stopped on a context code shows its message once, beside the matching summary', () => {
  const run = (error: string, contextSummary?: ReaderRun['contextSummary']) =>
    renderToStaticMarkup(
      createElement(RunNotices, {
        run: { status: 'failed', error, contextSummary } as ReaderRun,
      })
    );
  const changed = run('CONTEXT_DEPENDENCIES_CHANGED');
  expect(changed).toContain('컨텍스트를 준비하는 동안 장면이나 설정이 바뀌었어요.');
  expect(changed).not.toContain('CONTEXT_DEPENDENCIES_CHANGED');
  const timedOut = run('CONTEXT_COMPACTION_TIMEOUT', failedSummary('CONTEXT_COMPACTION_TIMEOUT'));
  expect(timedOut.split('요약이 제시간에 끝나지 않았어요.')).toHaveLength(2);
});
