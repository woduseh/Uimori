import { LazyDiagnostics } from './LazyDiagnostics.js';
import type { Attempt } from '../core/product.js';
import type { Run } from '../core/types.js';
import { providerCacheUsage } from '../core/provider-cache-usage.js';
import { formatUsd, pricingRateLabels, pricingNote } from './pricing-display.js';
import './model-pricing.css';

const roleLabels: Record<Attempt['role'], string> = {
  main: '원문',
  translation: '번역',
  status: '표시 상태',
  image: '이미지 배치',
  state: '서사 상태',
  context: '문맥 압축',
  helper: '도우미',
  title: '채팅 제목',
  illustration: '삽화',
};
type AttemptSummary = Omit<Attempt, 'request' | 'response' | 'rawUsage'>;
const total = (attempts: AttemptSummary[], field: 'inputTokens' | 'outputTokens' | 'costUsd') =>
  attempts.length === 0 || attempts.some((attempt) => attempt[field] === null)
    ? null
    : attempts.reduce((sum, attempt) => sum + (attempt[field] ?? 0), 0);

function estimatedTotal(attempts: AttemptSummary[]): string {
  if (!attempts.length) return '미확인';
  const complete = attempts.every(
    (attempt) => attempt.estimatedCost?.status === 'estimated' && attempt.estimatedCost.usd !== null
  );
  if (complete)
    return formatUsd(attempts.reduce((sum, attempt) => sum + attempt.estimatedCost!.usd!, 0));
  const known = attempts.filter((attempt) =>
    attempt.estimatedCost?.lines.some((line) => line.usd !== null)
  );
  if (!known.length) return '미확인';
  const subtotal = known.reduce((sum, attempt) => sum + attempt.estimatedCost!.subtotalUsd, 0);
  const incomplete = attempts.filter(
    (attempt) => attempt.estimatedCost?.status !== 'estimated' || attempt.estimatedCost.usd === null
  ).length;
  return `확인분 부분합 ${formatUsd(subtotal)} · ${incomplete}회 미확인 항목 포함`;
}

function AttemptPricing({ attempt }: { attempt: Attempt }) {
  const estimate = attempt.estimatedCost;
  return (
    <section className="attempt-pricing" aria-label="호출 추정 비용">
      <p>공급자 보고 비용: {formatUsd(attempt.costUsd)}</p>
      <p>
        <strong>추정 비용: {estimatedTotal([attempt])}</strong>
      </p>
      <p className="muted">
        호출 후 공급자가 보고한 토큰과 호출에 고정된 요금으로 계산해요. 참고용 추정 금액이며 실제
        청구액과 다를 수 있어요.
      </p>
      {attempt.pricingSnapshot ? (
        <>
          <p>
            호출에 고정된 등급: {attempt.pricingSnapshot.serviceTier} · 요금 기준일:{' '}
            {attempt.pricingSnapshot.checkedAt.slice(0, 10)}
          </p>
          <p>
            {attempt.pricingSnapshot.source === 'manual'
              ? '직접 입력 요금'
              : attempt.pricingSnapshot.source === 'catalog'
                ? '공급자 목록 요금'
                : '공식 요금'}
            {attempt.pricingSnapshot.sourceUrl && (
              <>
                {' '}
                ·{' '}
                <a href={attempt.pricingSnapshot.sourceUrl} target="_blank" rel="noreferrer">
                  요금 출처
                </a>
              </>
            )}
          </p>
          {attempt.pricingSnapshot.notes.length > 0 && (
            <ul className="model-pricing-notes">
              {attempt.pricingSnapshot.notes.map((note, index) => (
                <li key={`${index}:${note}`}>{pricingNote(note)}</li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <p className="muted">이 호출에 고정된 요금이 없어 추정 비용을 확인할 수 없어요.</p>
      )}
      {attempt.pricingStartedAt && <small>호출 기준 시각: {attempt.pricingStartedAt}</small>}
      {estimate && (
        <>
          <div className="table-scroll">
            <table aria-label="호출 추정 비용 계산 내역">
              <thead>
                <tr>
                  <th>항목</th>
                  <th>공급자 토큰</th>
                  <th>USD / 100만 토큰</th>
                  <th>추정 비용</th>
                </tr>
              </thead>
              <tbody>
                {estimate.lines.map((line) => (
                  <tr key={line.kind}>
                    <th>{pricingRateLabels[line.kind]}</th>
                    <td>{line.tokens === null ? '미확인' : line.tokens.toLocaleString('ko-KR')}</td>
                    <td>{formatUsd(line.rate)}</td>
                    <td>{formatUsd(line.usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {estimate.notes.length > 0 && (
            <ul className="model-pricing-notes">
              {estimate.notes.map((note, index) => (
                <li key={`${index}:${note}`}>{pricingNote(note)}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function CacheUsage({ attempt }: { attempt: Attempt }) {
  const request = attempt.request as { protocol?: unknown } | null;
  const usage = providerCacheUsage(request?.protocol, attempt.rawUsage);
  if (!usage) return null;
  return (
    <p className="muted">
      공급자 보고 캐시 토큰 · 읽기 {usage.readTokens ?? '미확인'} / 쓰기{' '}
      {usage.writeTokens ?? '미확인'}
      {usage.write5mTokens !== undefined && (
        <>
          {' '}
          · 5분 쓰기 {usage.write5mTokens ?? '미확인'} / 60분 쓰기 {usage.write1hTokens ?? '미확인'}
        </>
      )}
      <small>
        읽기 토큰이 보고돼야 캐시 재사용을 확인할 수 있어요. 설정만으로 hit나 절감액을 추정하지
        않아요.
      </small>
    </p>
  );
}

export function AttemptInspector({
  chatId,
  revision,
  runs,
}: {
  chatId: string;
  revision: number;
  runs: Pick<Run, 'status'>[];
}) {
  return (
    <div className="usage-inspector" data-testid="usage-inspector">
      <LazyDiagnostics<AttemptSummary[]>
        path={`/chats/${chatId}/attempts`}
        revision={revision}
        title={
          <>
            전체 역할의 호출과 비용 <small>후보 · 보조 작업 · 재시도 포함</small>
          </>
        }
      >
        {(attempts) => <AttemptTable attempts={attempts} runs={runs} revision={revision} />}
      </LazyDiagnostics>
    </div>
  );
}

function AttemptTable({
  attempts,
  runs,
  revision,
}: {
  attempts: AttemptSummary[];
  runs: Pick<Run, 'status'>[];
  revision: number;
}) {
  const totals = {
    input: total(attempts, 'inputTokens'),
    output: total(attempts, 'outputTokens'),
    cost: total(attempts, 'costUsd'),
  };
  return (
    <div>
      <p>
        전송 시도 {attempts.length}회 · 입력 {totals.input ?? '미확인'} / 출력{' '}
        {totals.output ?? '미확인'} 토큰 · 공급자 보고 비용{' '}
        {totals.cost === null ? '미확인' : `$${totals.cost}`}
      </p>
      <p>
        <strong>추정 비용: {estimatedTotal(attempts)}</strong>
      </p>
      <p className="muted">
        호출 후 공급자가 보고한 토큰으로 계산해요. 참고용 추정 금액이며 실제 청구액과 다를 수
        있어요.
      </p>
      <p className="muted">
        비용이나 토큰이 없는 호출은 0으로 계산하지 않아요. 외부 전송이 없는 scripted mock은 아래
        원문 실행 기록에서 확인할 수 있어요.
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>역할</th>
              <th>전송 시도</th>
              <th>입력 토큰</th>
              <th>출력 토큰</th>
              <th>공급자 보고 비용</th>
              <th>추정 비용</th>
            </tr>
          </thead>
          <tbody>
            {(
              [
                'main',
                'translation',
                'status',
                'image',
                'state',
                'context',
                'helper',
                'title',
              ] as Attempt['role'][]
            ).map((role) => {
              const selected = attempts.filter((attempt) => attempt.role === role);
              const cost = total(selected, 'costUsd');
              return (
                <tr key={role}>
                  <th>{roleLabels[role]}</th>
                  <td>{selected.length}</td>
                  <td>{total(selected, 'inputTokens') ?? '미확인'}</td>
                  <td>{total(selected, 'outputTokens') ?? '미확인'}</td>
                  <td>{cost === null ? '미확인' : `$${cost}`}</td>
                  <td>{estimatedTotal(selected)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="muted">
        보관된 원문 Run {runs.length}개 · 완료{' '}
        {runs.filter((run) => run.status === 'completed').length}개 · 거절{' '}
        {runs.filter((run) => run.status === 'refused').length}개 · 부분{' '}
        {runs.filter((run) => run.status === 'partial').length}개
      </p>
      {attempts.map((summary) => (
        <LazyDiagnostics<Attempt>
          key={summary.id}
          path={`/attempts/${summary.id}`}
          revision={revision}
          title={`${roleLabels[summary.role]} · ${summary.modelId} · ${summary.status}`}
        >
          {(attempt) => (
            <>
              <p>
                {attempt.runId
                  ? `Run ${attempt.runId}`
                  : `Job ${attempt.storyJobId ?? attempt.jobId}`}{' '}
                · 비용 기준 {attempt.priceRevision ?? '미확인'}
              </p>
              <CacheUsage attempt={attempt} />
              <AttemptPricing attempt={attempt} />
              <pre>
                {JSON.stringify(
                  {
                    id: attempt.id,
                    role: attempt.role,
                    request: attempt.request,
                    response: attempt.response,
                    usage: {
                      inputTokens: attempt.inputTokens,
                      outputTokens: attempt.outputTokens,
                      costUsd: attempt.costUsd,
                      raw: attempt.rawUsage,
                    },
                    error: attempt.error,
                  },
                  null,
                  2
                )}
              </pre>
            </>
          )}
        </LazyDiagnostics>
      ))}
    </div>
  );
}
