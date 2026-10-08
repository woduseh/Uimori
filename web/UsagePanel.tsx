import { LoadingState } from './LoadingState.js';
import { useEffect, useState } from 'react';
import { CalendarDays, Download, RefreshCw } from 'lucide-react';
import { USAGE_KIND_LABELS, type UsageReport, type UsageTotals } from '../core/usage-report.js';
import { api } from './api.js';
import { ActionMenu } from './ActionMenu.js';
import { IconButton } from './IconButton.js';
import { UsageChart } from './UsageChart.js';
import {
  exactCost,
  knownCost,
  usageCompact,
  usageCost,
  usageNumber,
  usagePeriod,
  validUsageRange,
} from './usage-display.js';
import './usage-report.css';

type Row = UsageTotals & { id: string; label: string; detail?: string };
function TotalsTable({ rows, label }: { rows: Row[]; label: string }) {
  return (
    <div className="usage-table-wrap">
      <table aria-label={label}>
        <thead>
          <tr>
            <th scope="col">{label}</th>
            <th scope="col">호출</th>
            <th scope="col">토큰</th>
            <th scope="col">비용</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((item) => (
            <tr key={item.id}>
              <th scope="row">
                {item.label}
                {item.detail && <small>{item.detail}</small>}
              </th>
              <td>{usageNumber(item.calls)}</td>
              <td
                title={`입력 ${usageNumber(item.inputTokens)} · 출력 ${usageNumber(item.outputTokens)}`}
              >
                {item.calls === item.unknownInputCalls && item.calls === item.unknownOutputCalls
                  ? '미확인'
                  : usageCompact(item.inputTokens + item.outputTokens)}
                <small>
                  입력{' '}
                  {item.calls === item.unknownInputCalls
                    ? '미확인'
                    : usageCompact(item.inputTokens)}{' '}
                  · 출력{' '}
                  {item.calls === item.unknownOutputCalls
                    ? '미확인'
                    : usageCompact(item.outputTokens)}
                </small>
                {(item.unknownInputCalls > 0 || item.unknownOutputCalls > 0) && (
                  <small>
                    미확인: 입력 {item.unknownInputCalls} · 출력 {item.unknownOutputCalls}회
                  </small>
                )}
              </td>
              <td title={exactCost(item)}>
                {usageCost(item)}
                {item.unknownCostCalls > 0 && (
                  <small>미확인 {usageNumber(item.unknownCostCalls)}회</small>
                )}
                {item.partialCalls > 0 && (
                  <small>부분 추정 {usageNumber(item.partialCalls)}회</small>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && <p className="usage-empty">선택한 기간에 기록이 없어요.</p>}
    </div>
  );
}
export function UsagePanel({
  connections = [],
}: {
  connections?: { id: string; title: string }[];
}) {
  const [range, setRange] = useState(() => usagePeriod('calendar'));
  const [draft, setDraft] = useState(range);
  const [period, setPeriod] = useState<'today' | 'week' | 'month' | 'calendar' | 'custom'>(
    'calendar'
  );
  const [refresh, setRefresh] = useState(0);
  const [report, setReport] = useState<UsageReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (
      period !== 'custom' ||
      !validUsageRange(draft) ||
      (draft.from === range.from && draft.to === range.to)
    )
      return;
    const timer = setTimeout(() => setRange(draft), 300);
    return () => clearTimeout(timer);
  }, [period, draft, range.from, range.to]);
  const query = new URLSearchParams(range).toString();
  // biome-ignore lint/correctness/useExhaustiveDependencies: explicit retry repeats the same read.
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
  function choose(kind: Exclude<typeof period, 'custom'>) {
    const next = usagePeriod(kind);
    setPeriod(kind);
    setRange(next);
    setDraft(next);
  }
  const current = report?.from === range.from && report.to === range.to ? report : null;
  const invalid = period === 'custom' && !validUsageRange(draft);
  const exports = (group: string) =>
    `/api/usage/export?${new URLSearchParams({ ...range, group })}`;
  const rows: Row[] = (current?.models ?? []).map((item) => ({
    ...item,
    id: JSON.stringify([item.connectionId, item.modelId]),
    label: item.modelId,
    detail:
      connections.find((connection) => connection.id === item.connectionId)?.title ??
      '연결 정보 없음',
  }));
  const totalCost = current ? knownCost(current.totals) : 0;
  return (
    <section className="usage-panel" aria-label="작업실 사용량">
      <div className="usage-toolbar">
        <div className="usage-presets" aria-label="사용량 조회 기간">
          {(
            [
              ['today', '오늘'],
              ['week', '7일'],
              ['month', '30일'],
              ['calendar', '이번 달'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={period === value}
              onClick={() => choose(value)}
            >
              {label}
            </button>
          ))}
          <button
            type="button"
            aria-pressed={period === 'custom'}
            onClick={() => {
              setPeriod('custom');
              setDraft(range);
            }}
          >
            <CalendarDays size={15} aria-hidden="true" /> 직접 선택
          </button>
        </div>
        <div className="usage-toolbar-actions">
          <IconButton
            icon={RefreshCw}
            label="사용량 새로고침"
            disabled={busy}
            onClick={() => setRefresh((value) => value + 1)}
          />
          {current && !busy && !error && (
            <ActionMenu label="CSV 내보내기" icon={Download} viewport>
              {(
                [
                  ['model', '모델별'],
                  ['day', '일별'],
                  ['kind', '용도별'],
                ] as const
              ).map(([group, label]) => (
                <a key={group} href={exports(group)} download>
                  <Download size={16} aria-hidden="true" /> {label} CSV
                </a>
              ))}
            </ActionMenu>
          )}
        </div>
      </div>
      {period === 'custom' && (
        <form
          className="usage-range"
          onSubmit={(event) => {
            event.preventDefault();
            if (!invalid) setRange(draft);
          }}
        >
          <label>
            시작일
            <input
              type="date"
              value={draft.from}
              required
              aria-invalid={invalid}
              onChange={(event) => setDraft({ ...draft, from: event.target.value })}
              onBlur={() => {
                if (validUsageRange(draft)) setRange(draft);
              }}
            />
          </label>
          <label>
            종료일
            <input
              type="date"
              value={draft.to}
              required
              aria-invalid={invalid}
              onChange={(event) => setDraft({ ...draft, to: event.target.value })}
              onBlur={() => {
                if (validUsageRange(draft)) setRange(draft);
              }}
            />
          </label>
        </form>
      )}
      {invalid && (
        <p role="alert" className="error">
          시작일과 종료일을 확인해 주세요.
        </p>
      )}
      <p className="usage-period-label">
        {range.from} — {range.to} · 한국 시간
      </p>
      {busy && !error && <LoadingState compact label="사용량을 불러오는 중이에요…" />}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {current && !error && (
        <div className="usage-results" aria-busy={busy}>
          <div className="usage-cards">
            <section aria-label="사용 비용">
              <h4>사용 비용</h4>
              <strong title={exactCost(current.totals)}>{usageCost(current.totals)}</strong>
              <small>{current.totals.calls ? '보고액 + 추정액' : '기록 없음'}</small>
              {(current.totals.unknownCostCalls > 0 || current.totals.partialCalls > 0) && (
                <small className="usage-incomplete">
                  미확인 {usageNumber(current.totals.unknownCostCalls)} · 부분 추정{' '}
                  {usageNumber(current.totals.partialCalls)}회
                </small>
              )}
            </section>
            <section aria-label="사용량 호출">
              <h4>호출</h4>
              <strong>{usageNumber(current.totals.calls)}</strong>
              <small>
                {current.totals.runningCalls
                  ? `진행 중 ${usageNumber(current.totals.runningCalls)}회 포함`
                  : '실제 전송 기준'}
              </small>
            </section>
            <section aria-label="사용 토큰">
              <h4>확인된 토큰</h4>
              <strong
                title={`입력 ${usageNumber(current.totals.inputTokens)} · 출력 ${usageNumber(current.totals.outputTokens)}`}
              >
                {current.totals.calls > 0 &&
                current.totals.calls === current.totals.unknownInputCalls &&
                current.totals.calls === current.totals.unknownOutputCalls
                  ? '미확인'
                  : usageCompact(current.totals.inputTokens + current.totals.outputTokens)}
              </strong>
              <small>
                입력{' '}
                {current.totals.calls > 0 &&
                current.totals.calls === current.totals.unknownInputCalls
                  ? '미확인'
                  : usageCompact(current.totals.inputTokens)}{' '}
                · 출력{' '}
                {current.totals.calls > 0 &&
                current.totals.calls === current.totals.unknownOutputCalls
                  ? '미확인'
                  : usageCompact(current.totals.outputTokens)}
              </small>
              {(current.totals.unknownInputCalls > 0 || current.totals.unknownOutputCalls > 0) && (
                <small>
                  미확인: 입력 {current.totals.unknownInputCalls} · 출력{' '}
                  {current.totals.unknownOutputCalls}회
                </small>
              )}
            </section>
          </div>
          <p className="usage-note">비용은 호출 당시 기록 기준이며 실제 청구액과 다를 수 있어요.</p>
          <UsageChart key={`${current.from}:${current.to}`} report={current} />
          <section className="usage-models" aria-label="모델별 비용">
            <header className="usage-section-heading">
              <h3>모델별 비용</h3>
              <small>상위 5개 · 확인된 금액 기준</small>
            </header>
            {rows.slice(0, 5).map((item) => (
              <div className="usage-model-row" key={item.id}>
                <div className="usage-model-name">
                  <strong title={item.label}>{item.label}</strong>
                  <small>
                    {item.detail} · {usageNumber(item.calls)}회
                  </small>
                </div>
                <div className="usage-model-meter" aria-hidden="true">
                  <span
                    style={{ width: `${totalCost > 0 ? (knownCost(item) / totalCost) * 100 : 0}%` }}
                  />
                </div>
                <div className="usage-model-cost" title={exactCost(item)}>
                  <strong>{usageCost(item)}</strong>
                  <small>
                    {totalCost > 0 && knownCost(item) > 0
                      ? `${((knownCost(item) / totalCost) * 100).toFixed(1)}%`
                      : '—'}
                    {item.unknownCostCalls || item.partialCalls ? ' · 일부 미확인' : ''}
                  </small>
                </div>
              </div>
            ))}
            {!rows.length && <p className="usage-empty">선택한 기간에 기록이 없어요.</p>}
          </section>
          <details className="usage-section">
            <summary>
              모델별 상세 <span>{rows.length}개</span>
            </summary>
            <TotalsTable label="모델" rows={rows} />
          </details>
          <details className="usage-section">
            <summary>일별·용도별 상세</summary>
            <h4>일별</h4>
            <TotalsTable
              label="날짜"
              rows={current.days.map((item) => ({ ...item, id: item.day, label: item.day }))}
            />
            <h4>용도별</h4>
            <TotalsTable
              label="용도"
              rows={current.kinds.map((item) => ({
                ...item,
                id: item.kind,
                label: USAGE_KIND_LABELS[item.kind] ?? '용도 미분류',
              }))}
            />
          </details>
          <details className="usage-section usage-help">
            <summary>집계 기준</summary>
            <p>
              프로바이더 보고액을 우선하며, 없으면 호출 당시 요금으로 추정해요. 부분 추정·미확인은
              무료가 아니에요.
            </p>
            <p>
              실제 전송된 재시도·실패·취소도 포함해요. 모델별·일별·용도별은 같은 기록이므로 서로
              더하지 않아요.
            </p>
            <p>
              상세 집계 시작:{' '}
              {new Date(current.coverageSince).toLocaleDateString('ko-KR', {
                timeZone: 'Asia/Seoul',
              })}
              . 삭제된 과거 기록은 복원하지 않아요.
            </p>
            <p>
              채팅 삭제 후에도 시각·모델·토큰·금액은 남으며, 원고와 요청 내용은 보관하지 않아요.
            </p>
          </details>
          {current.undated.calls > 0 && (
            <p className="usage-note">
              시각 미확인 {usageNumber(current.undated.calls)}회 · {usageCost(current.undated)}는
              기간 합계에서 제외했어요.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
