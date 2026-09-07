import { LazyDiagnostics } from './LazyDiagnostics.js';
import type { Attempt } from '../core/product.js';
import type { Run } from '../core/types.js';
import { providerCacheUsage } from '../core/provider-cache-usage.js';

const roleLabels: Record<Attempt['role'], string> = { main: '원문', translation: '번역', status: '표시 상태', image: '이미지 선택', state: '서사 상태', memory: '장기 기억' };
type AttemptSummary = Omit<Attempt,'request'|'response'|'rawUsage'>;
const total = (attempts: AttemptSummary[], field: 'inputTokens' | 'outputTokens' | 'costUsd') => attempts.length === 0 || attempts.some(attempt => attempt[field] === null) ? null : attempts.reduce((sum, attempt) => sum + (attempt[field] ?? 0), 0);

function CacheUsage({attempt}:{attempt:Attempt}) {
  const request=attempt.request as {protocol?:unknown}|null;
  const usage=providerCacheUsage(request?.protocol,attempt.rawUsage);
  if(!usage)return null;
  return <p className="muted">공급자 보고 캐시 토큰 · 읽기 {usage.readTokens??'미확인'} / 쓰기 {usage.writeTokens??'미확인'}
    {usage.write5mTokens!==undefined&&<> · 5분 쓰기 {usage.write5mTokens??'미확인'} / 60분 쓰기 {usage.write1hTokens??'미확인'}</>}
    <small>읽기 토큰이 보고돼야 캐시 재사용을 확인할 수 있어요. 설정만으로 hit나 절감액을 추정하지 않아요.</small></p>;
}

export function AttemptInspector({ chatId, revision, runs }: { chatId:string; revision:number; runs:Pick<Run,'status'>[] }) {
  return <div data-testid="usage-inspector"><LazyDiagnostics<AttemptSummary[]> path={`/chats/${chatId}/attempts`} revision={revision} title={<>전체 역할의 호출과 비용 <small>후보 · 보조 작업 · 재시도 포함</small></>}>{attempts => <AttemptTable attempts={attempts} runs={runs} revision={revision}/>}</LazyDiagnostics></div>;
}

function AttemptTable({ attempts, runs, revision }: { attempts:AttemptSummary[]; runs:Pick<Run,'status'>[]; revision:number }) {
  const totals = { input: total(attempts, 'inputTokens'), output: total(attempts, 'outputTokens'), cost: total(attempts, 'costUsd') };
  return <div>
    <p>전송 시도 {attempts.length}회 · 입력 {totals.input ?? '미확인'} / 출력 {totals.output ?? '미확인'} 토큰 · 비용 {totals.cost === null ? '미확인' : `$${totals.cost}`}</p>
    <p className="muted">비용이나 토큰이 없는 호출은 0으로 계산하지 않아요. 외부 전송이 없는 scripted mock은 아래 원문 실행 기록에서 확인할 수 있어요.</p>
    <div className="table-scroll"><table><thead><tr><th>역할</th><th>전송 시도</th><th>입력 토큰</th><th>출력 토큰</th><th>비용</th></tr></thead><tbody>{(['main', 'translation', 'status', 'image', 'state', 'memory'] as Attempt['role'][]).map(role => {
      const selected = attempts.filter(attempt => attempt.role === role); const cost = total(selected, 'costUsd');
      return <tr key={role}><th>{roleLabels[role]}</th><td>{selected.length}</td><td>{total(selected, 'inputTokens') ?? '미확인'}</td><td>{total(selected, 'outputTokens') ?? '미확인'}</td><td>{cost === null ? '미확인' : `$${cost}`}</td></tr>;
    })}</tbody></table></div>
    <p className="muted">보관된 원문 Run {runs.length}개 · 완료 {runs.filter(run => run.status === 'completed').length}개 · 거절 {runs.filter(run => run.status === 'refused').length}개 · 부분 {runs.filter(run => run.status === 'partial').length}개</p>
    {attempts.map(summary => <LazyDiagnostics<Attempt> key={summary.id} path={`/attempts/${summary.id}`} revision={revision} title={`${roleLabels[summary.role]} · ${summary.modelId} · ${summary.status}`}>{attempt => <><p>{attempt.runId ? `Run ${attempt.runId}` : `Job ${attempt.storyJobId ?? attempt.jobId}`} · 비용 기준 {attempt.priceRevision ?? '미확인'}</p><CacheUsage attempt={attempt}/><pre>{JSON.stringify({ id: attempt.id, role: attempt.role, request: attempt.request, response: attempt.response, usage: { inputTokens: attempt.inputTokens, outputTokens: attempt.outputTokens, costUsd: attempt.costUsd, raw: attempt.rawUsage }, error: attempt.error }, null, 2)}</pre></>}</LazyDiagnostics>)}
  </div>;
}
