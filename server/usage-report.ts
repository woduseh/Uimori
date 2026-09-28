import type { FastifyInstance } from 'fastify';
import type { UsageReport, UsageTotals } from '../core/usage-report.js';
import { fields, record, HttpError } from './request-validation.js';
import type { Store } from './store.js';

const aggregates = `COUNT(*) AS calls,
  COALESCE(SUM(CASE WHEN input_tokens>=0 THEN input_tokens END),0) AS inputTokens,
  COALESCE(SUM(CASE WHEN output_tokens>=0 THEN output_tokens END),0) AS outputTokens,
  COALESCE(SUM(input_tokens IS NULL OR input_tokens<0),0) AS unknownInputCalls,
  COALESCE(SUM(output_tokens IS NULL OR output_tokens<0),0) AS unknownOutputCalls,
  COALESCE(SUM(CASE WHEN cost_usd>=0 THEN cost_usd ELSE 0 END),0) AS reportedUsd,
  COALESCE(SUM(CASE WHEN (cost_usd IS NULL OR cost_usd<0) AND estimate_status='estimated' AND estimated_usd>=0 THEN estimated_usd ELSE 0 END),0) AS estimatedUsd,
  COALESCE(SUM(CASE WHEN (cost_usd IS NULL OR cost_usd<0) AND estimate_status='partial' AND estimated_subtotal_usd>=0 THEN estimated_subtotal_usd ELSE 0 END),0) AS partialUsd,
  COALESCE(SUM((cost_usd IS NULL OR cost_usd<0) AND estimate_status='partial' AND estimated_subtotal_usd>=0),0) AS partialCalls,
  COALESCE(SUM((cost_usd IS NULL OR cost_usd<0) AND NOT COALESCE((estimate_status='estimated' AND estimated_usd>=0) OR (estimate_status='partial' AND estimated_subtotal_usd>=0),0)),0) AS unknownCostCalls,
  COALESCE(SUM(status='running'),0) AS runningCalls`;

function period(value: unknown) {
  const query = record(value);
  fields(query, ['from', 'to', 'group']);
  for (const key of ['from', 'to']) {
    const date = query[key];
    if (
      typeof date !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(Date.parse(`${date}T00:00:00.000Z`)) ||
      new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) !== date
    )
      throw new HttpError(400, '조회 날짜를 확인해 주세요.');
  }
  const from = String(query.from),
    to = String(query.to);
  if (from > to) throw new HttpError(400, '시작일은 종료일보다 늦을 수 없어요.');
  const after = new Date(`${from}T00:00:00+09:00`).toISOString();
  const until = new Date(Date.parse(`${to}T00:00:00+09:00`) + 86400_000).toISOString();
  return { from, to, after, until, group: query.group };
}
/** A single attempt is a billable attempt. No run/helper rollups or live repricing are added. */
export function usageReport(store: Store, value: unknown): UsageReport {
  const { from, to, after, until } = period(value);
  const predicate = 'is_synthetic=0 AND started_at>=? AND started_at<?';
  const db = store.db;
  return {
    from,
    to,
    timeZone: 'Asia/Seoul',
    totals: db
      .prepare(`SELECT ${aggregates} FROM attempts WHERE ${predicate}`)
      .get(after, until) as UsageTotals,
    days: db
      .prepare(
        `SELECT date(started_at,'+9 hours') AS day,${aggregates} FROM attempts WHERE ${predicate} GROUP BY day ORDER BY day`
      )
      .all(after, until) as UsageReport['days'],
    models: db
      .prepare(
        `SELECT model_id AS modelId,connection_id AS connectionId,${aggregates} FROM attempts WHERE ${predicate} GROUP BY connection_id,model_id ORDER BY reportedUsd+estimatedUsd+partialUsd DESC,calls DESC,connection_id,model_id`
      )
      .all(after, until) as UsageReport['models'],
    kinds: db
      .prepare(
        `SELECT usage_kind AS kind,${aggregates} FROM attempts WHERE ${predicate} GROUP BY usage_kind ORDER BY calls DESC,usage_kind`
      )
      .all(after, until) as UsageReport['kinds'],
    undated: db
      .prepare(`SELECT ${aggregates} FROM attempts WHERE is_synthetic=0 AND started_at IS NULL`)
      .get() as UsageTotals,
    coverageSince: String(
      db.prepare("SELECT value FROM app_metadata WHERE key='usage-coverage-since'").get()!.value
    ),
  };
}
export function usageCsv(report: UsageReport, group: 'day' | 'model' | 'kind' = 'day'): string {
  const csvCell = (value: unknown) => {
    let text = String(value ?? '');
    if (/^[\s]*[=+\-@]/u.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  const header = [
    '구분',
    '프로바이더 ID',
    '호출',
    '확인된 입력 토큰',
    '입력 미확인 호출',
    '확인된 출력 토큰',
    '출력 미확인 호출',
    '공급자 보고 USD',
    '완전 추정 USD',
    '부분 추정 USD',
    '부분 추정 호출',
    '비용 미확인 호출',
    '진행 중 호출',
  ];
  const row = (label: string, provider: string, item: UsageTotals) =>
    [
      label,
      provider,
      item.calls,
      item.inputTokens,
      item.unknownInputCalls,
      item.outputTokens,
      item.unknownOutputCalls,
      item.reportedUsd,
      item.estimatedUsd,
      item.partialUsd,
      item.partialCalls,
      item.unknownCostCalls,
      item.runningCalls,
    ]
      .map(csvCell)
      .join(',');
  const rows =
    group === 'model'
      ? report.models.map((item) => row(item.modelId, item.connectionId, item))
      : group === 'kind'
        ? report.kinds.map((item) => row(item.kind, '', item))
        : report.days.map((item) => row(item.day, '', item));
  return `\uFEFF${header.map(csvCell).join(',')}\r\n${rows.join('\r\n')}\r\n`;
}
export function usageRoutes(app: FastifyInstance, store: Store) {
  app.get('/api/usage', (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return usageReport(store, request.query);
  });
  app.get('/api/usage/export', (request, reply) => {
    const { group, from, to } = period(request.query);
    if (group !== undefined && !['day', 'model', 'kind'].includes(String(group)))
      throw new HttpError(400, '내보내기 기준을 확인해 주세요.');
    const report = usageReport(store, request.query);
    return reply
      .type('text/csv; charset=utf-8')
      .header('Cache-Control', 'no-store')
      .header('Content-Disposition', `attachment; filename="uimori-usage-${from}-${to}.csv"`)
      .send(usageCsv(report, (group ?? 'day') as 'day' | 'model' | 'kind'));
  });
}
