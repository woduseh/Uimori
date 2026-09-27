import { useEffect, useState } from 'react';
import { USAGE_KIND_LABELS, type UsageReport, type UsageTotals } from '../core/usage-report.js';
import { api } from './api.js';
import './usage-report.css';

const number = (value: number) => value.toLocaleString('ko-KR');
const usd = (value: number) =>
  value > 0 && value < 0.000001
    ? '<US$0.000001'
    : new Intl.NumberFormat('ko-KR', {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: 6,
      }).format(value);
const known = (item: UsageTotals) => item.reportedUsd + item.estimatedUsd + item.partialUsd;
const cost = (item: UsageTotals) =>
  item.calls > 0 && item.calls === item.unknownCostCalls ? '미확인' : usd(known(item));
function today() {
  return new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
}
function preset(kind: 'today' | 'week' | 'month' | 'calendar') {
  const to = today();
  const from =
    kind === 'calendar'
      ? `${to.slice(0, 7)}-01`
      : new Date(
          Date.parse(`${to}T00:00:00Z`) -
            (kind === 'today' ? 0 : kind === 'week' ? 6 : 29) * 86400_000
        )
          .toISOString()
          .slice(0, 10);
  return { from, to };
}
function TotalsTable({
  rows,
  label,
  exportUrl,
}: {
  rows: (UsageTotals & { id: string; label: string; detail?: string })[];
  label: string;
  exportUrl: string;
}) {
  return (
    <section className="usage-section">
      <header>
        <h3>{label}</h3>
        <a href={exportUrl} download>
          {label} CSV
        </a>
      </header>
      <div className="usage-table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">{label}</th>
              <th scope="col">호출</th>
              <th scope="col">입력 토큰</th>
              <th scope="col">출력 토큰</th>
              <th scope="col">확인·추정 USD</th>
              <th scope="col">금액 미확인</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((item) => (
              <tr key={item.id}>
                <th scope="row">
                  {item.label}
                  {item.detail && <small>{item.detail}</small>}
                </th>
                <td>{number(item.calls)}</td>
                <td>
                  {number(item.inputTokens)}
                  {item.unknownInputCalls > 0 && (
                    <small>+ {number(item.unknownInputCalls)}건 미확인</small>
                  )}
                </td>
                <td>
                  {number(item.outputTokens)}
                  {item.unknownOutputCalls > 0 && (
                    <small>+ {number(item.unknownOutputCalls)}건 미확인</small>
                  )}
                </td>
                <td>
                  {cost(item)}
                  {item.partialCalls > 0 && <small>부분 추정 {item.partialCalls}건</small>}
                </td>
                <td>{number(item.unknownCostCalls)}건</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!rows.length && <p className="muted">선택한 기간에 기록된 호출이 없어요.</p>}
    </section>
  );
}
export function UsagePanel({
  connections = [],
}: {
  connections?: { id: string; title: string }[];
}) {
  const [range, setRange] = useState(() => preset('calendar'));
  const [draft, setDraft] = useState(range);
  const [refresh, setRefresh] = useState(0);
  const [report, setReport] = useState<UsageReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const query = new URLSearchParams(range).toString();
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh is the user's explicit repeat-read intent.
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true);
    setError('');
    void api<UsageReport>(`/usage?${query}`, undefined, 'GET', controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setReport(value);
      })
      .catch((caught) => {
        if (!controller.signal.aborted) setError(caught.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [query, refresh]);
  function choose(kind: Parameters<typeof preset>[0]) {
    const next = preset(kind);
    setRange(next);
    setDraft(next);
  }
  const exports = (group: string) =>
    `/api/usage/export?${new URLSearchParams({ from: report?.from ?? range.from, to: report?.to ?? range.to, group })}`;
  return (
    <section className="usage-panel" aria-label="작업실 사용량">
      <h3>작업실 사용량</h3>
      <p className="muted">
        실제 호출 기록을 한국 시간으로 합산해요. 공급자의 청구서가 아니며, 보고액이 없을 때만 당시
        기준의 추정액을 사용해요.
      </p>
      <div className="usage-presets">
        {(
          [
            ['today', '오늘'],
            ['week', '최근 7일'],
            ['month', '최근 30일'],
            ['calendar', '이번 달'],
          ] as const
        ).map(([value, label]) => (
          <button key={value} type="button" onClick={() => choose(value)}>
            {label}
          </button>
        ))}
      </div>
      <form
        className="usage-range"
        onSubmit={(event) => {
          event.preventDefault();
          setRange(draft);
          setRefresh((value) => value + 1);
        }}
      >
        <label>
          시작일
          <input
            type="date"
            value={draft.from}
            onChange={(event) => setDraft({ ...draft, from: event.target.value })}
            required
          />
        </label>
        <label>
          종료일
          <input
            type="date"
            value={draft.to}
            onChange={(event) => setDraft({ ...draft, to: event.target.value })}
            required
          />
        </label>
        <button type="submit" disabled={busy}>
          사용량 조회
        </button>
      </form>
      {busy && <p role="status">사용량을 읽고 있어요…</p>}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {report && (
        <>
          <p>
            {report.from} ~ {report.to} · 한국 시간 · {number(report.totals.calls)}회 호출
          </p>
          <div className="usage-cards">
            <section>
              <h4>확인·추정 금액</h4>
              <strong>{cost(report.totals)}</strong>
              <small>
                보고 {usd(report.totals.reportedUsd)} · 추정 {usd(report.totals.estimatedUsd)}
                {report.totals.partialCalls > 0 && ` · 부분 ${usd(report.totals.partialUsd)}`}
              </small>
            </section>
            <section>
              <h4>확인된 입력 / 출력 토큰</h4>
              <strong>
                {number(report.totals.inputTokens)} / {number(report.totals.outputTokens)}
              </strong>
              <small>
                입력 {report.totals.unknownInputCalls}건 · 출력 {report.totals.unknownOutputCalls}건
                미확인
              </small>
            </section>
            <section>
              <h4>전체 금액이 확인되지 않은 호출</h4>
              <strong>
                {number(report.totals.unknownCostCalls + report.totals.partialCalls)}건
              </strong>
              <small>
                그중 부분 추정 {report.totals.partialCalls}건 · 진행 중 {report.totals.runningCalls}
                건
              </small>
            </section>
          </div>
          <TotalsTable
            label="일별"
            exportUrl={exports('day')}
            rows={report.days.map((item) => ({ ...item, id: item.day, label: item.day }))}
          />
          <TotalsTable
            label="모델별"
            exportUrl={exports('model')}
            rows={report.models.map((item) => ({
              ...item,
              id: JSON.stringify([item.connectionId, item.modelId]),
              label: item.modelId,
              detail:
                connections.find((connection) => connection.id === item.connectionId)?.title ??
                '연결 정보 없음',
            }))}
          />
          <TotalsTable
            label="용도별"
            exportUrl={exports('kind')}
            rows={report.kinds.map((item) => ({
              ...item,
              id: item.kind,
              label: USAGE_KIND_LABELS[item.kind] ?? '용도 미분류',
            }))}
          />
          {report.undated.calls > 0 && (
            <aside className="usage-coverage">
              <strong>시각 미확인 과거 호출 {number(report.undated.calls)}건</strong>
              <p>
                날짜를 추측하지 않아 위 기간 합계에는 넣지 않았어요. 확인·추정 금액:{' '}
                {cost(report.undated)}.
              </p>
            </aside>
          )}
          <p className="muted">
            상세 집계 도입:{' '}
            {new Date(report.coverageSince).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}.
            이미 삭제된 과거 실행이나 남아 있지 않은 용도는 복원할 수 없어요. 구독 실행·로컬 이미지
            작업에서 금액이 제공되지 않으면 무료로 표시하지 않아요. 생성하지 않은 모의 실행은
            제외해요.
          </p>
          <p className="muted">
            채팅·도우미·삽화를 삭제해도 비용 합계는 유지해요. 삭제된 내용과 요청은 남기지 않고
            최소한의 호출 시각·모델·토큰·금액만 보관해요.
          </p>
        </>
      )}
    </section>
  );
}
