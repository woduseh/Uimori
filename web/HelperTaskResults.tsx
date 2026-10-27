import { useCallback, useEffect, useRef, useState } from 'react';
import { BookOpen, Check, FileText, Image, Palette, Settings2 } from 'lucide-react';
import type {
  HelperStatus,
  HelperTaskAttemptUsage,
  HelperTaskResultTarget,
  HelperTaskResultsView,
} from '../core/helper.js';
import { api } from './api.js';
import { formatNumber, t, useI18n } from './i18n.js';
import { LoadingState } from './LoadingState.js';
import { NoticeBanner } from './NoticeBanner.js';
import { usageUsd } from './usage-display.js';
import './helper-task-results.css';

type RecordedAmount = { value: number; reported: number; unknown: number };
const usageFields = [
  'inputTokens',
  'outputTokens',
  'cachedInputTokens',
  'reasoningTokens',
  'costUsd',
  'internalModelCalls',
] as const;

/** Unknown provider reports stay separate from reported zeroes and partial totals. */
export function helperTaskUsageTotals(attempts: HelperTaskAttemptUsage[]) {
  return Object.fromEntries(
    usageFields.map((field) => {
      const amount: RecordedAmount = { value: 0, reported: 0, unknown: 0 };
      for (const attempt of attempts) {
        const value = attempt[field];
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

const settingsLabels: Record<string, string> = {
  'global.mainModel': 'helperResults.globalMainModel',
  'global.translationModel': 'helperResults.globalTranslationModel',
  'global.helperModel': 'helperResults.globalHelperModel',
  'global.contextModel': 'helperResults.globalContextModel',
  'global.scriptModel': 'helperResults.globalScriptModel',
  'global.titleModel': 'helperResults.globalTitleModel',
  'chat.mainModel': 'helperResults.chatMainModel',
  'chat.mainPromptPreset': 'helperResults.chatMainPromptPreset',
  'chat.maxCalls': 'helperResults.chatMaxCalls',
  'model.pricing': 'helperResults.modelPricing',
};
const targetIcons = {
  content: BookOpen,
  'prompt-preset': FileText,
  'prompt-workspace': FileText,
  theme: Palette,
  'illustration-preset': Image,
  settings: Settings2,
};
const active = (status: HelperStatus) => status === 'running' || status === 'queued';

type ResultsRead = {
  taskId: string;
  data: HelperTaskResultsView | null;
  reading: boolean;
  failed: boolean;
};

function useTaskResults(taskId: string, status: HelperStatus, visible: boolean) {
  const [view, setView] = useState<ResultsRead | null>(null);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt explicitly retries the same result read.
  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    let pending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let currentStatus = status;
    const read = async () => {
      if (pending || controller.signal.aborted || document.hidden) return;
      pending = true;
      clearTimeout(timer);
      setView((old) => ({
        taskId,
        data: old?.taskId === taskId ? old.data : null,
        failed: old?.taskId === taskId && old.failed,
        reading: true,
      }));
      try {
        const data = await api<HelperTaskResultsView>(
          `/helper/tasks/${encodeURIComponent(taskId)}/results`,
          undefined,
          'GET',
          controller.signal
        );
        currentStatus = data.status;
        if (!controller.signal.aborted) setView({ taskId, data, reading: false, failed: false });
      } catch {
        if (!controller.signal.aborted)
          setView((old) => ({
            taskId,
            data: old?.taskId === taskId ? old.data : null,
            reading: false,
            failed: true,
          }));
      } finally {
        pending = false;
        if (!controller.signal.aborted && active(currentStatus) && !document.hidden)
          timer = setTimeout(() => void read(), 1200);
      }
    };
    const visibilityChanged = () => {
      clearTimeout(timer);
      if (!document.hidden) void read();
    };
    void read();
    document.addEventListener('visibilitychange', visibilityChanged);
    return () => {
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', visibilityChanged);
    };
  }, [taskId, status, visible, attempt]);
  return {
    ...(view?.taskId === taskId ? view : { data: null, reading: visible, failed: false }),
    retry,
  };
}

function settingValue(value: HelperTaskResultTarget['before'], label?: string | null) {
  if (label !== undefined && label !== null) return label;
  if (value === null) return t('helperResults.unset');
  if (typeof value === 'boolean') return t(`helperResults.${value ? 'enabled' : 'disabled'}`);
  return typeof value === 'number' ? formatNumber(value) : value;
}

function ResultTarget({
  target,
  operation,
  onOpen,
}: {
  target: HelperTaskResultTarget;
  operation: string;
  onOpen?: (target: HelperTaskResultTarget) => Promise<void> | void;
}) {
  const [opening, setOpening] = useState(false);
  const [failed, setFailed] = useState(false);
  const pending = useRef(false);
  const deleted = operation === 'resource.delete';
  async function open() {
    if (!onOpen || pending.current) return;
    pending.current = true;
    setOpening(true);
    setFailed(false);
    try {
      await onOpen(target);
    } catch {
      setFailed(true);
    } finally {
      pending.current = false;
      setOpening(false);
    }
  }
  const Icon = targetIcons[target.kind];
  const settingLabel = target.setting && settingsLabels[target.setting];
  const title =
    target.id === 'global' && target.kind === 'settings'
      ? t('helperResults.globalSettings')
      : target.title;
  const content = (
    <>
      <Icon size={16} aria-hidden="true" />
      <span className="helper-result-identity">
        <span>{title}</span>
        {settingLabel && <small>{t(settingLabel)}</small>}
      </span>
      {!deleted && target.before !== undefined && target.after !== undefined ? (
        <span className="helper-result-values">
          <span>{settingValue(target.before, target.beforeLabel)}</span>
          <span aria-hidden="true">→</span>
          <span className="sr-only">{t('helperResults.changedTo')}</span>
          <span>{settingValue(target.after, target.afterLabel)}</span>
        </span>
      ) : (
        <span className="helper-result-saved">
          {t(deleted ? 'helperResults.deleted' : 'helperResults.saved')}
        </span>
      )}
    </>
  );
  return onOpen && !deleted ? (
    <>
      <button
        type="button"
        className="helper-result-target"
        aria-label={t('helperResults.openTarget', {
          title: settingLabel ? `${title} ${t(settingLabel)}` : title,
        })}
        disabled={opening}
        aria-busy={opening}
        onClick={() => void open()}
      >
        {content}
      </button>
      {failed && <NoticeBanner tone="error">{t('helperResults.openFailed')}</NoticeBanner>}
    </>
  ) : (
    <div className="helper-result-target">{content}</div>
  );
}

function UsageAmount({ amount, cost = false }: { amount: RecordedAmount; cost?: boolean }) {
  return (
    <>
      <span>
        {amount.reported === 0 && amount.unknown > 0
          ? t('helperResults.unknown')
          : cost
            ? usageUsd(amount.value)
            : formatNumber(amount.value)}
      </span>
      {amount.unknown > 0 && amount.reported > 0 && (
        <small>{t('helperResults.missingRequests', { count: formatNumber(amount.unknown) })}</small>
      )}
    </>
  );
}

function TaskUsage({ usage }: { usage: HelperTaskResultsView['usage'] }) {
  const totals = helperTaskUsageTotals(usage.attempts);
  return (
    <details className="helper-result-usage">
      <summary>{t('helperResults.usage')}</summary>
      <dl>
        <dt>{t('helperResults.executions')}</dt>
        <dd>{formatNumber(usage.attempts.length)}</dd>
        <dt>{t('helperResults.tools')}</dt>
        <dd>{formatNumber(usage.toolExecutions)}</dd>
        {totals.internalModelCalls.reported > 0 && (
          <>
            <dt>{t('helperResults.internalCalls')}</dt>
            <dd>
              <UsageAmount amount={totals.internalModelCalls} />
            </dd>
          </>
        )}
        <dt>{t('helperResults.input')}</dt>
        <dd>
          <UsageAmount amount={totals.inputTokens} />
        </dd>
        {totals.cachedInputTokens.reported > 0 && (
          <>
            <dt>{t('helperResults.cached')}</dt>
            <dd>
              <UsageAmount amount={totals.cachedInputTokens} />
            </dd>
          </>
        )}
        <dt>{t('helperResults.output')}</dt>
        <dd>
          <UsageAmount amount={totals.outputTokens} />
        </dd>
        {totals.reasoningTokens.reported > 0 && (
          <>
            <dt>{t('helperResults.reasoning')}</dt>
            <dd>
              <UsageAmount amount={totals.reasoningTokens} />
            </dd>
          </>
        )}
        <dt>{t('helperResults.cost')}</dt>
        <dd>
          <UsageAmount amount={totals.costUsd} cost />
        </dd>
        {usage.latestInputEstimate !== null && (
          <>
            <dt>{t('helperResults.latestEstimate')}</dt>
            <dd>{formatNumber(usage.latestInputEstimate)}</dd>
          </>
        )}
      </dl>
    </details>
  );
}

export function HelperTaskResults({
  taskId,
  status,
  visible = true,
  onOpenTarget,
}: {
  taskId: string;
  status: HelperStatus;
  visible?: boolean;
  onOpenTarget?: (target: HelperTaskResultTarget) => Promise<void> | void;
}) {
  useI18n();
  const { data, reading, failed, retry } = useTaskResults(taskId, status, visible);
  const noOp =
    data && data.results.length > 0 && data.results.every((result) => result.changedTargets === 0);
  return (
    <section
      className="helper-task-results"
      aria-label={t('helperResults.title')}
      data-testid="helper-task-results"
    >
      {data && (
        <>
          <ul className="helper-result-list">
            {data.results.flatMap((result) =>
              result.targets.map((target, index) => (
                <li key={`${result.eventSeq}:${target.kind}:${target.id}:${index}`}>
                  <ResultTarget
                    target={target}
                    operation={result.operation}
                    onOpen={onOpenTarget}
                  />
                </li>
              ))
            )}
          </ul>
          {noOp && (
            <p className="helper-result-note">
              <Check size={16} aria-hidden="true" />
              {t('helperResults.noOp')}
            </p>
          )}
          {data.unrecordedOperations > 0 && (
            <p className="helper-result-note">
              {t('helperResults.unrecorded', { count: formatNumber(data.unrecordedOperations) })}
            </p>
          )}
          <TaskUsage usage={data.usage} />
        </>
      )}
      <LoadingState
        presentation="inline"
        loading={reading}
        error={failed ? t(data ? 'helperResults.refreshFailed' : 'helperResults.loadFailed') : ''}
        errorLabel={t('helperResults.title')}
        label={t('helperResults.loading')}
        onRetry={retry}
      />
    </section>
  );
}
