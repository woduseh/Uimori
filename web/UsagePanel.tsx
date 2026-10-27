import { t, useI18n, translateMessage, formatNumber, formatDate } from './i18n.js';
import { LoadingState } from './LoadingState.js';
import { useEffect, useState } from 'react';
import { CalendarDays, Download, RefreshCw } from 'lucide-react';
import { USAGE_KIND_LABELS, type UsageReport, type UsageTotals } from '../core/usage-report.js';
import { api } from './api.js';
import { ActionMenu } from './ActionMenu.js';
import { IconButton } from './IconButton.js';
import { NoticeBanner } from './NoticeBanner.js';
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
  useI18n();
  return (
    <div className="usage-table-wrap">
      <table aria-label={label}>
        <thead>
          <tr>
            <th scope="col">{label}</th>
            <th scope="col">{t('visualpanels.calls')}</th>
            <th scope="col">{t('visualpanels.tokens')}</th>
            <th scope="col">{t('visualpanels.cost')}</th>
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
                title={t('visualpanels.inputOutput', {
                  v0: usageNumber(item.inputTokens),
                  v1: usageNumber(item.outputTokens),
                })}
              >
                {item.calls === item.unknownInputCalls && item.calls === item.unknownOutputCalls
                  ? t('visualpanels.unknown')
                  : usageCompact(item.inputTokens + item.outputTokens)}
                <small>
                  {t('visualpanels.inputOutput', {
                    v0:
                      item.calls === item.unknownInputCalls
                        ? t('visualpanels.unknown')
                        : usageCompact(item.inputTokens),
                    v1:
                      item.calls === item.unknownOutputCalls
                        ? t('visualpanels.unknown')
                        : usageCompact(item.outputTokens),
                  })}
                </small>
                {(item.unknownInputCalls > 0 || item.unknownOutputCalls > 0) && (
                  <small>
                    {t('visualpanels.unknownInputOutputCalls', {
                      v0: item.unknownInputCalls,
                      v1: item.unknownOutputCalls,
                    })}
                  </small>
                )}
              </td>
              <td title={exactCost(item)}>
                {usageCost(item)}
                {item.unknownCostCalls > 0 && (
                  <small>
                    {t('visualpanels.unknownInVPluralOneOther', { v0: item.unknownCostCalls })}
                  </small>
                )}
                {item.partialCalls > 0 && (
                  <small>
                    {t('visualpanels.partialEstimateInVPluralOneOther', { v0: item.partialCalls })}
                  </small>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && (
        <p className="usage-empty">{t('visualpanels.noRecordsForTheSelectedPeriod')}</p>
      )}
    </div>
  );
}
export function UsagePanel({
  connections = [],
}: {
  connections?: { id: string; title: string }[];
}) {
  useI18n();
  const [range, setRange] = useState(() => usagePeriod('calendar'));
  const [draft, setDraft] = useState(range);
  const [period, setPeriod] = useState<'today' | 'week' | 'month' | 'calendar' | 'custom'>(
    'calendar'
  );
  const [refresh, setRefresh] = useState(0);
  const [report, setReport] = useState<UsageReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ query: string; message: string } | null>(null);
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
    void api<UsageReport>(`/usage?${query}`, undefined, 'GET', controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) {
          setReport(value);
          setFailure(null);
        }
      })
      .catch((caught) => {
        if (!controller.signal.aborted) setFailure({ query, message: caught.message });
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
  const error = failure?.query === query ? failure.message : '';
  const retry = () => setRefresh((value) => value + 1);
  const invalid = period === 'custom' && !validUsageRange(draft);
  const exports = (group: string) =>
    `/api/usage/export?${new URLSearchParams({ ...range, group })}`;
  const rows: Row[] = (current?.models ?? []).map((item) => ({
    ...item,
    id: JSON.stringify([item.connectionId, item.modelId]),
    label: item.modelId,
    detail:
      connections.find((connection) => connection.id === item.connectionId)?.title ??
      t('visualpanels.noConnectionInformation'),
  }));
  const totalCost = current ? knownCost(current.totals) : 0;
  return (
    <section className="usage-panel" aria-label={t('visualpanels.workspaceUsage')}>
      <div className="usage-toolbar">
        <div className="usage-presets" aria-label={t('visualpanels.usageReportPeriod')}>
          {(
            [
              ['today', t('visualpanels.today')],
              ['week', t('visualpanels.days')],
              ['month', t('visualpanels.days2')],
              ['calendar', t('visualpanels.thisMonth')],
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
            <CalendarDays size={15} aria-hidden="true" /> {t('visualpanels.customRange')}{' '}
          </button>
        </div>
        <div className="usage-toolbar-actions">
          <IconButton
            icon={RefreshCw}
            label={t('visualpanels.refreshUsage')}
            disabled={busy}
            onClick={retry}
          />
          {current && !busy && !error && (
            <ActionMenu label={t('visualpanels.exportCsv')} icon={Download} viewport>
              {(
                [
                  ['model', t('visualpanels.byModel')],
                  ['day', t('visualpanels.byDay')],
                  ['kind', t('visualpanels.byPurpose')],
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
            {t('visualpanels.startDate')}{' '}
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
            {t('visualpanels.endDate')}{' '}
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
          {t('visualpanels.checkTheStartAndEndDates')}
        </p>
      )}
      <p className="usage-period-label">
        {t('visualpanels.koreaTime', {
          v0: formatDate(new Date(range.from + 'T00:00:00+09:00'), { timeZone: 'Asia/Seoul' }),
          v1: formatDate(new Date(range.to + 'T00:00:00+09:00'), { timeZone: 'Asia/Seoul' }),
        })}
      </p>
      {!current && (
        <LoadingState
          loading={busy}
          error={translateMessage(error)}
          label={t('visualpanels.loadingUsage')}
          errorLabel={t('visualpanels.couldNotLoadUsage')}
          onRetry={retry}
        />
      )}
      {current && busy && (
        <LoadingState presentation="inline" label={t('visualpanels.refreshingUsage')} />
      )}
      {current && error && (
        <NoticeBanner
          tone="error"
          actions={
            <button type="button" className="secondary" disabled={busy} onClick={retry}>
              {t('visualpanels.reload')}
            </button>
          }
        >
          <p>{t('visualpanels.refreshFailedShowingPreviousResults')}</p>
          <p>{translateMessage(error)}</p>
        </NoticeBanner>
      )}
      {current && (
        <div className="usage-results" aria-busy={busy}>
          <div className="usage-cards">
            <section aria-label={t('visualpanels.usageCost')}>
              <h4>{t('visualpanels.usageCost')}</h4>
              <strong title={exactCost(current.totals)}>{usageCost(current.totals)}</strong>
              {current.totals.calls > 0 && <small>{t('visualpanels.reportedEstimated')}</small>}
              {(current.totals.unknownCostCalls > 0 || current.totals.partialCalls > 0) && (
                <small className="usage-incomplete">
                  {t('visualpanels.unknownPartialEstimateInCalls', {
                    v0: usageNumber(current.totals.unknownCostCalls),
                    v1: usageNumber(current.totals.partialCalls),
                  })}
                </small>
              )}
            </section>
            <section aria-label={t('visualpanels.usageCalls')}>
              <h4>{t('visualpanels.calls')}</h4>
              <strong>{usageNumber(current.totals.calls)}</strong>
              {current.totals.runningCalls > 0 && (
                <small>
                  {t('visualpanels.includesVPluralOneOtherInProgress', {
                    v0: current.totals.runningCalls,
                  })}
                </small>
              )}
            </section>
            <section aria-label={t('visualpanels.usedTokens')}>
              <h4>{t('visualpanels.knownTokens')}</h4>
              <strong
                title={t('visualpanels.inputOutput', {
                  v0: usageNumber(current.totals.inputTokens),
                  v1: usageNumber(current.totals.outputTokens),
                })}
              >
                {current.totals.calls > 0 &&
                current.totals.calls === current.totals.unknownInputCalls &&
                current.totals.calls === current.totals.unknownOutputCalls
                  ? t('visualpanels.unknown')
                  : usageCompact(current.totals.inputTokens + current.totals.outputTokens)}
              </strong>
              <small>
                {t('visualpanels.inputOutput', {
                  v0:
                    current.totals.calls > 0 &&
                    current.totals.calls === current.totals.unknownInputCalls
                      ? t('visualpanels.unknown')
                      : usageCompact(current.totals.inputTokens),
                  v1:
                    current.totals.calls > 0 &&
                    current.totals.calls === current.totals.unknownOutputCalls
                      ? t('visualpanels.unknown')
                      : usageCompact(current.totals.outputTokens),
                })}
              </small>
              {(current.totals.unknownInputCalls > 0 || current.totals.unknownOutputCalls > 0) && (
                <small>
                  {t('visualpanels.unknownInputOutputCalls', {
                    v0: current.totals.unknownInputCalls,
                    v1: current.totals.unknownOutputCalls,
                  })}
                </small>
              )}
            </section>
          </div>
          {current.totals.calls === 0 ? (
            <p className="usage-period-empty" role="status">
              {t('visualpanels.noRecordsForTheSelectedPeriod')}
            </p>
          ) : (
            <>
              <UsageChart key={`${current.from}:${current.to}`} report={current} />
              <section className="usage-models" aria-label={t('visualpanels.costByModel')}>
                <header className="usage-section-heading">
                  <h3>{t('visualpanels.costByModel')}</h3>
                  <small>{t('visualpanels.topBasedOnKnownAmounts')}</small>
                </header>
                {rows.slice(0, 5).map((item) => (
                  <div className="usage-model-row" key={item.id}>
                    <div className="usage-model-name">
                      <strong title={item.label}>{item.label}</strong>
                      <small>
                        {t('visualpanels.calls2', {
                          v0: item.detail ?? '',
                          v1: item.calls,
                        })}
                      </small>
                    </div>
                    <div className="usage-model-meter" aria-hidden="true">
                      <span
                        style={{
                          width: `${totalCost > 0 ? (knownCost(item) / totalCost) * 100 : 0}%`,
                        }}
                      />
                    </div>
                    <div className="usage-model-cost" title={exactCost(item)}>
                      <strong>{usageCost(item)}</strong>
                      <small>
                        {totalCost > 0 && knownCost(item) > 0
                          ? formatNumber(knownCost(item) / totalCost, {
                              style: 'percent',
                              minimumFractionDigits: 1,
                              maximumFractionDigits: 1,
                            })
                          : '—'}
                        {item.unknownCostCalls || item.partialCalls
                          ? t('visualpanels.partiallyUnknown')
                          : ''}
                      </small>
                    </div>
                  </div>
                ))}
                {!rows.length && (
                  <p className="usage-empty">{t('visualpanels.noRecordsForTheSelectedPeriod')}</p>
                )}
              </section>
              <details className="usage-section">
                <summary>
                  {t('visualpanels.modelDetails')}{' '}
                  <span>{t('visualpanels.vPluralOneOther2', { v0: rows.length })}</span>
                </summary>
                <TotalsTable label={t('visualpanels.model')} rows={rows} />
              </details>
              <details className="usage-section">
                <summary>{t('visualpanels.dailyAndPurposeDetails')}</summary>
                <h4>{t('visualpanels.byDay')}</h4>
                <TotalsTable
                  label={t('visualpanels.date')}
                  rows={current.days.map((item) => ({
                    ...item,
                    id: item.day,
                    label: formatDate(new Date(item.day + 'T00:00:00+09:00'), {
                      timeZone: 'Asia/Seoul',
                    }),
                  }))}
                />
                <h4>{t('visualpanels.byPurpose')}</h4>
                <TotalsTable
                  label={t('visualpanels.purpose')}
                  rows={current.kinds.map((item) => ({
                    ...item,
                    id: item.kind,
                    label:
                      translateMessage(USAGE_KIND_LABELS[item.kind] ?? '') ||
                      t('visualpanels.uncategorizedPurpose'),
                  }))}
                />
              </details>
            </>
          )}
          <p className="usage-note">
            {t('visualpanels.detailedTrackingBeganDeletedHistoricalRecordsAre', {
              v0: formatDate(new Date(current.coverageSince), { timeZone: 'Asia/Seoul' }),
            })}
          </p>
          {current.undated.calls > 0 && (
            <p className="usage-note">
              {t('visualpanels.callsWithUnknownTimeExcludedFromPeriod', {
                v0: current.undated.calls,
                v1: usageCost(current.undated),
              })}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
