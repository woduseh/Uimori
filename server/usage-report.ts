import type { FastifyInstance } from 'fastify';
import { personalWorkspaceEndpoints } from '#contracts';
import {
  personalWorkspaceOperations,
  type UsagePeriod,
  type UsageReport,
  type UsageTotals,
  usageExportQuery,
} from '#contracts/operations';
import type { UiLocale } from '../core/ui-locale.js';
import type { Store } from './store.js';
import { parseInput, registerEndpoint } from './endpoint.js';

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

const USAGE_TIME_ZONE = 'Asia/Seoul';
const USAGE_UTC_OFFSET_HOURS = 9;
const usageOffset = `+${String(USAGE_UTC_OFFSET_HOURS).padStart(2, '0')}:00`;

export function usageReportDate(at: string) {
  return {
    date: new Date(Date.parse(at) + USAGE_UTC_OFFSET_HOURS * 3600_000).toISOString().slice(0, 10),
    timeZone: USAGE_TIME_ZONE,
  } as const;
}

function period({ from, to }: UsagePeriod) {
  const after = new Date(`${from}T00:00:00${usageOffset}`).toISOString();
  const until = new Date(Date.parse(`${to}T00:00:00${usageOffset}`) + 86400_000).toISOString();
  return { from, to, after, until };
}
export const USAGE_BREAKDOWNS = ['days', 'models', 'kinds'] as const;
type Breakdown = (typeof USAGE_BREAKDOWNS)[number];
type SelectedUsageReport = Omit<UsageReport, Breakdown> & Partial<Pick<UsageReport, Breakdown>>;

export function usageReport(store: Store, range: UsagePeriod): UsageReport;
export function usageReport(
  store: Store,
  range: UsagePeriod,
  breakdowns: readonly Breakdown[]
): SelectedUsageReport;
export function usageReport(
  store: Store,
  range: UsagePeriod,
  breakdowns: readonly Breakdown[] = USAGE_BREAKDOWNS
): SelectedUsageReport {
  const { from, to, after, until } = period(range);
  const predicate = 'is_synthetic=0 AND started_at>=? AND started_at<?';
  const db = store.db;
  return {
    from,
    to,
    timeZone: USAGE_TIME_ZONE,
    totals: db
      .prepare(`SELECT ${aggregates} FROM attempts WHERE ${predicate}`)
      .get(after, until) as UsageTotals,
    ...(breakdowns.includes('days')
      ? {
          days: db
            .prepare(
              `SELECT date(started_at,'+${USAGE_UTC_OFFSET_HOURS} hours') AS day,${aggregates} FROM attempts WHERE ${predicate} GROUP BY day ORDER BY day`
            )
            .all(after, until) as UsageReport['days'],
        }
      : {}),
    ...(breakdowns.includes('models')
      ? {
          models: db
            .prepare(
              `SELECT model_id AS modelId,connection_id AS connectionId,${aggregates} FROM attempts WHERE ${predicate} GROUP BY connection_id,model_id ORDER BY reportedUsd+estimatedUsd+partialUsd DESC,calls DESC,connection_id,model_id`
            )
            .all(after, until) as UsageReport['models'],
        }
      : {}),
    ...(breakdowns.includes('kinds')
      ? {
          kinds: db
            .prepare(
              `SELECT usage_kind AS kind,${aggregates} FROM attempts WHERE ${predicate} GROUP BY usage_kind ORDER BY calls DESC,usage_kind`
            )
            .all(after, until) as UsageReport['kinds'],
        }
      : {}),
    undated: db
      .prepare(`SELECT ${aggregates} FROM attempts WHERE is_synthetic=0 AND started_at IS NULL`)
      .get() as UsageTotals,
    coverageSince: String(
      db.prepare("SELECT value FROM app_metadata WHERE key='usage-coverage-since'").get()!.value
    ),
  };
}
const USAGE_CSV_HEADERS: Record<UiLocale, readonly string[]> = {
  ko: [
    '구분',
    '프로바이더 ID',
    '호출',
    '확인된 입력 토큰',
    '입력 미확인 호출',
    '확인된 출력 토큰',
    '출력 미확인 호출',
    '프로바이더 보고 USD',
    '완전 추정 USD',
    '부분 추정 USD',
    '부분 추정 호출',
    '비용 미확인 호출',
    '진행 중 호출',
  ],
  en: [
    'Group',
    'Provider ID',
    'Calls',
    'Known input tokens',
    'Calls with unknown input',
    'Known output tokens',
    'Calls with unknown output',
    'Provider-reported USD',
    'Full estimate USD',
    'Partial estimate USD',
    'Partial estimate calls',
    'Calls with unknown cost',
    'Calls in progress',
  ],
  ja: [
    '区分',
    'プロバイダー ID',
    '呼び出し',
    '確認済み入力トークン',
    '入力未確認の呼び出し',
    '確認済み出力トークン',
    '出力未確認の呼び出し',
    'プロバイダー報告 USD',
    '完全推定 USD',
    '部分推定 USD',
    '部分推定の呼び出し',
    '費用未確認の呼び出し',
    '進行中の呼び出し',
  ],
  zh: [
    '分组',
    '提供商 ID',
    '调用',
    '已知输入 token',
    '输入未知的调用',
    '已知输出 token',
    '输出未知的调用',
    '提供商报告 USD',
    '完全估算 USD',
    '部分估算 USD',
    '部分估算调用',
    '成本未知的调用',
    '进行中的调用',
  ],
};
export function usageCsv(
  report: UsageReport,
  group: 'day' | 'model' | 'kind' = 'day',
  lang: UiLocale = 'ko'
): string {
  const csvCell = (value: unknown) => {
    let text = String(value ?? '');
    if (/^[\s]*[=+\-@]/u.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  const header = USAGE_CSV_HEADERS[lang];
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
  registerEndpoint(
    app,
    personalWorkspaceEndpoints.readUsage,
    personalWorkspaceOperations.readUsage,
    (range) => usageReport(store, range)
  );
  app.get('/api/usage/export', (request, reply) => {
    const { group, lang, ...range } = parseInput(usageExportQuery, request.query);
    return reply
      .type('text/csv; charset=utf-8')
      .header('Cache-Control', 'no-store')
      .header(
        'Content-Disposition',
        `attachment; filename="uimori-usage-${range.from}-${range.to}.csv"`
      )
      .send(usageCsv(usageReport(store, range), group, lang));
  });
}
