import { Fragment, useId, useState, type CSSProperties, type ReactNode } from 'react';
import { Info } from 'lucide-react';
import {
  sumTraceCosts,
  TRACE_CALL_KINDS,
  traceCostGroup,
  type ChatTraceCall,
  type TraceCall,
  type TraceCostGroup,
} from '../core/task-trace.js';
import type { Attempt } from '../core/product.js';
import { AttemptDetail } from './AttemptInspector.js';
import { formatNumber, t, useI18n } from './i18n.js';
import { uiMessage, legacyUiMessage } from './ui-message.js';
import { IconButton } from './IconButton.js';
import { LazyDiagnostics } from './LazyDiagnostics.js';
import { LoadingState } from './LoadingState.js';
import { useApiRecord } from './useApiRecord.js';
import { formatUsd, formatUsdSubtotal, formatUsdSummary } from './pricing-display.js';
import { CopyTextButton } from './TaskHistory.js';
import {
  formatDurationMs,
  formatShare,
  traceCostGroupLabel,
  traceCostSummary,
  traceKindLabel,
  traceStatusLabel,
} from './task-trace.js';
import { DropdownIcon } from './ui-icons.js';
import './model-pricing.css';
import './task-trace.css';

type RecordedAmount = { value: number; reported: number; unknown: number };
const usageFields = [
  'inputTokens',
  'outputTokens',
  'cachedInputTokens',
  'reasoningTokens',
  'costUsd',
  'internalModelCalls',
] as const;

export function traceUsageTotals(calls: readonly TraceCall[]) {
  return Object.fromEntries(
    usageFields.map((field) => {
      const amount: RecordedAmount = { value: 0, reported: 0, unknown: 0 };
      for (const call of calls) {
        const value = call[field];
        if (value === null) amount.unknown++;
        else {
          amount.value += value;
          amount.reported++;
        }
      }
      return [field, amount];
    })
  ) as Record<(typeof usageFields)[number], RecordedAmount>;
}

function UsageAmount({
  amount,
  format = formatNumber,
}: {
  amount: RecordedAmount;
  format?: (value: number) => string;
}) {
  return (
    <>
      <span>
        {amount.reported === 0 && amount.unknown > 0
          ? t('helperResults.unknown')
          : format(amount.value)}
      </span>
      {amount.unknown > 0 && amount.reported > 0 && (
        <small>{t('helperResults.missingRequests', { count: formatNumber(amount.unknown) })}</small>
      )}
    </>
  );
}

function UsageShare({
  label,
  part,
  whole,
}: {
  label: 'helperResults.cachedShare' | 'helperResults.reasoningShare';
  part: RecordedAmount;
  whole: RecordedAmount;
}) {
  if (part.reported === 0 || part.value === 0 || whole.value === 0) return null;
  return (
    <small>
      {t(label, { count: formatNumber(part.value), share: formatShare(part.value, whole.value) })}
    </small>
  );
}

const costGroups: TraceCostGroup[] = ['writing', 'translation', 'image', 'title', 'other'];

export function TraceSummary({
  calls,
  toolExecutions,
  groups = false,
}: {
  calls: readonly TraceCall[];
  toolExecutions?: number;
  groups?: boolean;
}) {
  useI18n();
  const totals = traceUsageTotals(calls);
  const tools = toolExecutions ?? calls.reduce((count, call) => count + call.tools.length, 0);
  const repeatedInput =
    calls.length > 1 || totals.internalModelCalls.value > 1 || totals.cachedInputTokens.value > 0;
  const cost = sumTraceCosts(calls);
  const costLabel = traceCostSummary(cost);
  const kinds = TRACE_CALL_KINDS.flatMap((kind) => {
    const count = calls.filter((call) => call.kind === kind).length;
    return count ? [{ kind, count }] : [];
  });
  const parts = groups
    ? costGroups.flatMap((group) => {
        const selected = calls.filter((call) => traceCostGroup(call) === group);
        const total = sumTraceCosts(selected);
        return selected.length
          ? [{ group, label: traceCostSummary(total) ?? t('visualpanels.unknown') }]
          : [];
      })
    : [];
  return (
    <dl className="trace-summary" aria-label={t('taskTrace.summary')}>
      <div data-row="calls">
        <dt>{t('helperResults.runs')}</dt>
        <dd>
          <span className="trace-meta">
            <span>{t('helperResults.modelCalls', { count: formatNumber(calls.length) })}</span>
            {tools > 0 && (
              <span>{t('helperResults.toolSummary', { count: formatNumber(tools) })}</span>
            )}
            {totals.internalModelCalls.reported > 0 && (
              <span>
                {t('helperResults.internalCallsShort', {
                  count: formatNumber(totals.internalModelCalls.value),
                })}
              </span>
            )}
          </span>
          {kinds.length > 1 && (
            <small className="trace-meta trace-summary-kinds">
              {kinds.map((item) => (
                <span key={item.kind}>
                  {t('taskTrace.kindCount', {
                    label: traceKindLabel(item.kind),
                    count: item.count,
                  })}
                </span>
              ))}
            </small>
          )}
        </dd>
      </div>
      <div data-row="input">
        <dt>
          <span>{t('helperResults.cumulativeInput')}</span>
          {repeatedInput && (
            <IconButton
              className="trace-summary-help"
              icon={Info}
              size={14}
              label={t('helperResults.cumulativeHelp')}
              title={t('helperResults.cumulativeExplanation')}
            />
          )}
        </dt>
        <dd>
          <UsageAmount amount={totals.inputTokens} />
          <UsageShare
            label="helperResults.cachedShare"
            part={totals.cachedInputTokens}
            whole={totals.inputTokens}
          />
        </dd>
      </div>
      <div data-row="output">
        <dt>{t('helperResults.cumulativeOutput')}</dt>
        <dd>
          <UsageAmount amount={totals.outputTokens} />
          <UsageShare
            label="helperResults.reasoningShare"
            part={totals.reasoningTokens}
            whole={totals.outputTokens}
          />
        </dd>
      </div>
      {(costLabel || (groups && parts.length > 1)) && (
        <div data-row="cost">
          <dt>{t(totals.costUsd.reported ? 'chatsettings.taskHistoryCost' : 'taskTrace.cost')}</dt>
          <dd>
            <span title={costLabel ? formatUsd(cost.usd ?? cost.subtotalUsd) : undefined}>
              {costLabel ?? t('visualpanels.unknown')}
            </span>
            {cost.unknownCount > 0 && (
              <small>
                {t('helperResults.missingRequests', { count: formatNumber(cost.unknownCount) })}
              </small>
            )}
            {parts.length > 1 && (
              <small className="trace-meta trace-summary-parts">
                {parts.map((part) => (
                  <span key={part.group}>
                    {t('taskTrace.costPart', {
                      label: traceCostGroupLabel(part.group),
                      value: part.label,
                    })}
                  </span>
                ))}
              </small>
            )}
          </dd>
        </div>
      )}
    </dl>
  );
}

function Absent() {
  return (
    <>
      <span className="trace-absent" aria-hidden="true">
        –
      </span>
      <span className="sr-only">{t('visualpanels.unknown')}</span>
    </>
  );
}

function CallCost({ call, whole }: { call: TraceCall; whole: number }) {
  const cost = { usd: call.estimatedUsd, known: call.estimatedUsd ?? call.estimatedSubtotalUsd };
  const share = whole > 0 ? cost.known / whole : 0;
  return (
    <>
      {cost.usd !== null ? (
        <span>{formatUsd(cost.usd)}</span>
      ) : cost.known > 0 ? (
        <span>
          {t('reader.inspectorCostAtLeast', {
            value: cost.known < 0.00000001 ? formatUsdSubtotal(cost.known) : formatUsd(cost.known),
          })}
        </span>
      ) : (
        <Absent />
      )}
      {cost.known > 0 && whole > 0 && (
        <>
          <span
            className="trace-cost-bar"
            aria-hidden="true"
            style={{ '--trace-share': Math.min(1, share) } as CSSProperties}
          />
          <span className="sr-only">
            {t('taskTrace.costShare', { share: formatShare(cost.known, whole) })}
          </span>
        </>
      )}
    </>
  );
}

function TokenCell({
  value,
  part,
  label,
}: {
  value: number | null;
  part: number | null;
  label: 'taskTrace.cacheShare' | 'taskTrace.reasoningShare';
}) {
  if (value === null) return <Absent />;
  return (
    <>
      <span>{formatNumber(value)}</span>
      {part !== null && part > 0 && value > 0 && (
        <small className="trace-quiet">{t(label, { share: formatShare(part, value) })}</small>
      )}
    </>
  );
}

export function TraceCallTable({
  calls,
  revision,
  label,
}: {
  calls: readonly TraceCall[];
  revision: number | string;
  label: string;
}) {
  useI18n();
  const id = useId();
  const [open, setOpen] = useState<string | null>(null);
  const reported = calls.some((call) => call.costUsd !== null);
  const timed = calls.some((call) => call.elapsedMs !== null);
  const whole = calls.reduce(
    (sum, call) => sum + (call.estimatedUsd ?? call.estimatedSubtotalUsd),
    0
  );
  const columns = 6 + Number(reported) + Number(timed);
  return (
    <div className="trace-calls">
      <table aria-label={label}>
        <thead>
          <tr>
            <th scope="col">{t('taskTrace.columnCall')}</th>
            <th scope="col">{t('taskTrace.columnStatus')}</th>
            <th scope="col" className="trace-number">
              {t('taskTrace.columnInput')}
            </th>
            <th scope="col" className="trace-number">
              {t('taskTrace.columnOutput')}
            </th>
            {timed && (
              <th scope="col" className="trace-number">
                {t('taskTrace.columnElapsed')}
              </th>
            )}
            <th scope="col" className="trace-number">
              {t('taskTrace.cost')}
            </th>
            {reported && (
              <th scope="col" className="trace-number">
                {t('taskTrace.columnReported')}
              </th>
            )}
            <th scope="col">
              <span className="sr-only">{t('visualpanels.attemptDetail')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {calls.map((call, index) => {
            const expanded = open === call.id;
            const detailId = `${id}-${index}`;
            const kindLabel = traceKindLabel(call.kind);
            return (
              <Fragment key={call.id}>
                <tr
                  className="trace-call-row"
                  data-attempt-id={call.id}
                  data-kind={call.kind}
                  data-expanded={expanded || undefined}
                >
                  <th scope="row">
                    <span className="trace-call-name">{kindLabel}</span>
                    <small className="trace-quiet trace-call-model">{call.modelId}</small>
                  </th>
                  <td data-label={t('taskTrace.columnStatus')}>
                    <span className="trace-status" data-status={call.status}>
                      {traceStatusLabel(call.status)}
                    </span>
                    {call.tools.length > 0 && (
                      <ul className="trace-tools">
                        {call.tools.map((tool, toolIndex) => (
                          <li
                            key={`${tool.name}:${toolIndex}`}
                            className="trace-meta trace-quiet"
                            data-failed={tool.failed || undefined}
                          >
                            <code>{tool.name}</code>
                            {tool.failed && <span>{traceStatusLabel('error')}</span>}
                            {tool.resultChars !== null && (
                              <span>{t('taskTrace.resultChars', { count: tool.resultChars })}</span>
                            )}
                            {tool.elapsedMs !== null && (
                              <span>{formatDurationMs(tool.elapsedMs)}</span>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td data-label={t('taskTrace.columnInput')} className="trace-number">
                    <TokenCell
                      value={call.inputTokens}
                      part={call.cachedInputTokens}
                      label="taskTrace.cacheShare"
                    />
                  </td>
                  <td data-label={t('taskTrace.columnOutput')} className="trace-number">
                    <TokenCell
                      value={call.outputTokens}
                      part={call.reasoningTokens}
                      label="taskTrace.reasoningShare"
                    />
                  </td>
                  {timed && (
                    <td data-label={t('taskTrace.columnElapsed')} className="trace-number">
                      {call.elapsedMs === null ? (
                        <Absent />
                      ) : (
                        <span>{formatDurationMs(call.elapsedMs)}</span>
                      )}
                      {call.firstByteMs !== null && (
                        <small className="trace-quiet">
                          {t('taskTrace.firstByte', { value: formatDurationMs(call.firstByteMs) })}
                        </small>
                      )}
                    </td>
                  )}
                  <td data-label={t('taskTrace.cost')} className="trace-number trace-cost">
                    <CallCost call={call} whole={whole} />
                  </td>
                  {reported && (
                    <td data-label={t('taskTrace.columnReported')} className="trace-number">
                      {call.costUsd === null ? <Absent /> : <span>{formatUsd(call.costUsd)}</span>}
                    </td>
                  )}
                  <td className="trace-action">
                    <button
                      type="button"
                      className="secondary"
                      aria-expanded={expanded}
                      aria-controls={detailId}
                      aria-label={t('visualpanels.attemptDetailFor', {
                        role: kindLabel,
                        model: call.modelId,
                      })}
                      onClick={() => setOpen(expanded ? null : call.id)}
                    >
                      <DropdownIcon size={14} aria-hidden="true" />
                      <span aria-hidden="true">
                        {expanded
                          ? t('visualpanels.attemptDetailHide')
                          : t('visualpanels.attemptDetailShow')}
                      </span>
                    </button>
                  </td>
                </tr>
                <tr id={detailId} className="trace-detail-row" hidden={!expanded}>
                  <td colSpan={columns}>
                    {expanded && (
                      <LazyDiagnostics<Attempt>
                        path={`/attempts/${call.id}`}
                        revision={revision}
                        disclosure={false}
                        title={t('visualpanels.attemptDetail')}
                      >
                        {(attempt) => <AttemptDetail attempt={attempt} label={kindLabel} />}
                      </LazyDiagnostics>
                    )}
                  </td>
                </tr>
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function TraceFooter({
  id,
  raw,
  onCopyFailed,
}: {
  id: string;
  raw?: () => string;
  onCopyFailed: () => void;
}) {
  useI18n();
  const [open, setOpen] = useState(false);
  return (
    <div className="trace-footer">
      <div className="trace-footer-row">
        <span className="trace-footer-id">
          <span>{t('taskTrace.recordId')}</span>
          <code>{id}</code>
        </span>
        {raw && (
          <span className="trace-footer-actions">
            <button
              type="button"
              className="secondary"
              aria-expanded={open}
              onClick={() => setOpen((old) => !old)}
            >
              {open ? t('taskTrace.rawHide') : t('taskTrace.rawShow')}
            </button>
            <CopyTextButton
              text={raw}
              label={t('visuals.historyCopy')}
              copiedLabel={t('visuals.historyCopied')}
              onFailure={onCopyFailed}
            />
          </span>
        )}
      </div>
      {raw && open && <pre className="task-history-raw">{raw()}</pre>}
    </div>
  );
}

export function TraceDisclosure({
  title,
  children,
  testId,
}: {
  title: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="trace-disclosure"
      data-testid={testId}
      onToggle={(event) => {
        if (event.target === event.currentTarget) setOpen(event.currentTarget.open);
      }}
    >
      <summary>
        <span>{title}</span>
      </summary>
      {open && <div className="trace-disclosure-body">{children}</div>}
    </details>
  );
}

export function useChatTrace(chatId: string, revision: number | string, enabled = true) {
  return useApiRecord<ChatTraceCall[]>(`/chats/${chatId}/attempts`, revision, enabled);
}

export function TraceLoading({ error, retry }: { error: string; retry: () => void }) {
  useI18n();
  return (
    <LoadingState
      presentation="inline"
      loading={!error}
      error={legacyUiMessage(error)}
      label={uiMessage('shared.loadingDetails')}
      onRetry={retry}
    />
  );
}

function ChatUsageBody({ chatId, revision }: { chatId: string; revision: number }) {
  const trace = useChatTrace(chatId, revision);
  return (
    <>
      {(!trace.value || trace.error) && <TraceLoading error={trace.error} retry={trace.retry} />}
      {trace.value && <ChatUsageTotals calls={trace.value} revision={revision} />}
    </>
  );
}

export function ChatUsage({ chatId, revision }: { chatId: string; revision: number }) {
  useI18n();
  return (
    <TraceDisclosure title={t('taskTrace.chatUsage')} testId="usage-inspector">
      <ChatUsageBody chatId={chatId} revision={revision} />
    </TraceDisclosure>
  );
}

export function ChatUsageTotals({
  calls,
  revision,
}: {
  calls: readonly ChatTraceCall[];
  revision: number | string;
}) {
  useI18n();
  const outside = calls.filter((call) => call.sceneRunId === null);
  const kinds = TRACE_CALL_KINDS.flatMap((kind) => {
    const selected = calls.filter((call) => call.kind === kind);
    return selected.length ? [{ kind, selected }] : [];
  });
  const reported = calls.some((call) => call.costUsd !== null);
  if (!calls.length) return <TraceSummary calls={calls} />;
  return (
    <div className="trace-chat-usage">
      <TraceSummary calls={calls} />
      <section className="trace-chat-section">
        <h4>{t('taskTrace.roleTotals')}</h4>
        <div className="trace-calls trace-totals">
          <table aria-label={t('taskTrace.roleTotals')}>
            <thead>
              <tr>
                <th scope="col">{t('taskTrace.columnCall')}</th>
                <th scope="col" className="trace-number">
                  {t('visualpanels.sendAttempts')}
                </th>
                <th scope="col" className="trace-number">
                  {t('taskTrace.columnInput')}
                </th>
                <th scope="col" className="trace-number">
                  {t('taskTrace.columnOutput')}
                </th>
                <th scope="col" className="trace-number">
                  {t('taskTrace.cost')}
                </th>
                {reported && (
                  <th scope="col" className="trace-number">
                    {t('taskTrace.columnReported')}
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {kinds.map(({ kind, selected }) => {
                const totals = traceUsageTotals(selected);
                const cost = traceCostSummary(
                  sumTraceCosts(selected.map((call) => ({ ...call, costUsd: null })))
                );
                return (
                  <tr key={kind} data-kind={kind}>
                    <th scope="row">{traceKindLabel(kind)}</th>
                    <td data-label={t('visualpanels.sendAttempts')} className="trace-number">
                      {formatNumber(selected.length)}
                    </td>
                    <td data-label={t('taskTrace.columnInput')} className="trace-number">
                      <UsageAmount amount={totals.inputTokens} />
                    </td>
                    <td data-label={t('taskTrace.columnOutput')} className="trace-number">
                      <UsageAmount amount={totals.outputTokens} />
                    </td>
                    <td data-label={t('taskTrace.cost')} className="trace-number">
                      {cost ?? <Absent />}
                    </td>
                    {reported && (
                      <td data-label={t('taskTrace.columnReported')} className="trace-number">
                        <UsageAmount
                          amount={totals.costUsd}
                          format={totals.costUsd.unknown ? formatUsdSubtotal : formatUsdSummary}
                        />
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
      {outside.length > 0 && (
        <section className="trace-chat-section">
          <h4>{t('taskTrace.outsideScenes', { count: outside.length })}</h4>
          <TraceCallTable
            calls={outside}
            revision={revision}
            label={t('taskTrace.outsideScenes', { count: outside.length })}
          />
        </section>
      )}
    </div>
  );
}
