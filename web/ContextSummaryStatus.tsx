import type { ReaderRun } from '../core/types.js';
import './context-summary.css';

export function ContextSummaryStatus({summary}:{summary:ReaderRun['contextSummary']}) {
  if(!summary)return null;
  const amount=(value:number)=>value.toLocaleString('ko-KR');
  const input=summary.estimatedInputTokens===null?'입력 추정치 미확인':`입력 약 ${amount(summary.estimatedInputTokens)}`;
  return <aside className={`context-summary${summary.status==='failed'?' context-summary-error':''}`} data-testid="context-summary" data-context-status={summary.status} aria-label="입력 컨텍스트 상태" role={summary.status==='failed'?'alert':'status'}>
    {summary.status==='pending'?<span>컨텍스트 확인 중</span>:summary.status==='failed'?<><strong>컨텍스트 확인에 실패했어요.</strong><span>{summary.error||'입력 컨텍스트 한도와 모델 연결을 확인해 주세요.'}</span></>:<span>{summary.compactedSources>0&&`앞선 ${amount(summary.compactedSources)}개 원문 요약 · `}{input} / {amount(summary.inputTokenLimit)} 토큰{(summary.compactedSources>0||summary.summaryCalls>0)&&` · 요약 ${amount(summary.summaryCalls)}회`}</span>}
  </aside>;
}
