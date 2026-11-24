import { useContext, useEffect, useRef, useState } from 'react';
import {
  BookOpen,
  Check,
  Clock3,
  FileText,
  Image,
  Languages,
  Palette,
  PenLine,
  Settings2,
} from 'lucide-react';
import type {
  HelperChange,
  HelperStatus,
  HelperTaskAttemptUsage,
  HelperTaskResultTarget,
  HelperTaskResultsView,
} from '../core/helper.js';
import { api } from './api.js';
import { watchLive } from './live-stream.js';
import { helperPollDelay, helperRefreshSpacing } from './poll-delays.js';
import { HelperChangeCard } from './HelperChangeCard.js';
import { HelperQuestionCard } from './HelperQuestionCard.js';
import { rollbackCovers, useHelperRollback } from './HelperTaskRollback.js';
import {
  HelperConfirmations,
  type HelperConfirmationGrant,
  type HelperConfirmationTarget,
} from './HelperConfirmations.js';
import { settingsLabels } from './helper-change-location.js';
import { isStoryUiStyle } from '../core/story-ui-style.js';
import { formatNumber, t, useI18n } from './i18n.js';
import { LoadingState } from './LoadingState.js';
import { NoticeBanner } from './NoticeBanner.js';
import { usageCompact, usageUsd } from './usage-display.js';
import { SearchSuggestionsFrame } from './SearchSuggestionsFrame.js';
import { StoryUiThemePreview } from './StoryBoardPanel.js';
import { ThemeContext } from './ThemeContext.js';
import './helper-task-results.css';
import './scene-usage.css';
import './run-task-details.css';
import { useRetryableEffect } from './useRetryableEffect.js';

type RecordedAmount = { value: number; reported: number; unknown: number };
const usageFields = [
  'inputTokens',
  'outputTokens',
  'cachedInputTokens',
  'reasoningTokens',
  'costUsd',
  'internalModelCalls',
] as const;

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

const targetIcons = {
  content: BookOpen,
  'prompt-preset': FileText,
  'prompt-workspace': FileText,
  theme: Palette,
  'illustration-preset': Image,
  illustration: Image,
  settings: Settings2,
  chat: PenLine,
  translation: Languages,
  scene: BookOpen,
};
const workOutcomes: Record<string, string> = {
  'illustration.generate': 'helperResults.illustrationQueued',
  'illustration.cut.redraw': 'helperResults.illustrationRedrawQueued',
  'illustration.cuts.place': 'helperResults.illustrationPlaced',
  'illustration.continuity.save': 'helperResults.illustrationContinuitySaved',
  'scene.request': 'helperResults.sceneQueued',
  'scene.translate': 'helperResults.translationQueued',
  'scene.title': 'helperResults.sceneNamed',
};
const queuedOperations = new Set([
  'illustration.generate',
  'illustration.cut.redraw',
  'scene.request',
  'scene.translate',
]);
const active = (status: HelperStatus) => status === 'running' || status === 'queued';
const resourceKinds = new Set<HelperTaskResultTarget['kind']>([
  'content',
  'prompt-preset',
  'prompt-workspace',
  'theme',
  'illustration-preset',
]);

function recordedByChange(
  target: HelperTaskResultTarget,
  operation: string,
  changes: readonly HelperChange[]
) {
  if (resourceKinds.has(target.kind))
    return changes.some((change) => change.domain === 'resource' && change.targetId === target.id);
  if (operation === 'scene.title')
    return changes.some(
      (change) => change.domain === 'scene' && change.targetId === `${target.id}:title`
    );
  return false;
}

function settingRecorded(change: HelperChange, results: HelperTaskResultsView['results']) {
  return results.some((result) =>
    result.targets.some(
      (target) => target.kind === 'settings' && `${target.setting}:${target.id}` === change.targetId
    )
  );
}

function useSeen<T extends Element>(eager: boolean) {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(eager);
  useEffect(() => {
    if (eager) setSeen(true);
  }, [eager]);
  useEffect(() => {
    const node = ref.current;
    if (seen || !node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setSeen(true);
      },
      { rootMargin: '50% 0px' }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [seen]);
  return [ref, seen || eager] as const;
}

type ResultsRead = {
  taskId: string;
  data: HelperTaskResultsView | null;
  reading: boolean;
  failed: boolean;
};

export function useHelperTaskResults(taskId: string, status: HelperStatus, visible: boolean) {
  const [view, setView] = useState<ResultsRead | null>(null);
  const retry = useRetryableEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    let currentStatus = status;
    const read = async () => {
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
      }
    };
    const live = watchLive({
      match: (frame) => frame.event === 'helper' && frame.taskId === taskId,
      refresh: read,
      fallbackMs: () => (active(currentStatus) ? helperPollDelay.task : undefined),
      minIntervalMs: helperRefreshSpacing,
    });
    live.request();
    return () => {
      controller.abort();
      live.dispose();
    };
  }, [taskId, status, visible]);
  return {
    ...(view?.taskId === taskId ? view : { data: null, reading: visible, failed: false }),
    retry,
  };
}

function settingValue(
  value: HelperTaskResultTarget['before'],
  label?: string | null,
  setting?: string
) {
  if (label !== undefined && label !== null) return label;
  if (
    (setting === 'chat.storyUiStyle' || setting === 'newChat.storyUiStyle') &&
    (value === 'auto' || isStoryUiStyle(value))
  )
    return t(`storyUi.style.${value}`);
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
  const globalSetting = target.id === 'global' && target.kind === 'settings';
  const title = globalSetting ? t(settingLabel || 'helperResults.globalSettings') : target.title;
  const subtitle = target.setting?.startsWith('newChat.')
    ? t('settings.newChatDefaults')
    : !globalSetting && settingLabel
      ? t(settingLabel)
      : undefined;
  const outcome =
    target.kind === 'illustration' ||
    target.kind === 'chat' ||
    target.kind === 'translation' ||
    target.kind === 'scene'
      ? workOutcomes[operation]
      : undefined;
  const queued = queuedOperations.has(operation);
  const content = (
    <>
      <Icon size={16} aria-hidden="true" />
      <span className="helper-result-identity">
        <span>{title}</span>
        {subtitle && <small>{subtitle}</small>}
      </span>
      {!deleted && target.before !== undefined && target.after !== undefined ? (
        <span className="helper-result-values">
          <span>{settingValue(target.before, target.beforeLabel, target.setting)}</span>
          <span aria-hidden="true">→</span>
          <span className="sr-only">{t('helperResults.changedTo')}</span>
          <span>{settingValue(target.after, target.afterLabel, target.setting)}</span>
        </span>
      ) : (
        <span className="helper-result-saved">
          {outcome ? (
            <>
              {queued ? (
                <Clock3 size={16} aria-hidden="true" />
              ) : (
                <Check size={16} aria-hidden="true" />
              )}
              {t(outcome)}
            </>
          ) : deleted ? (
            t('helperResults.deleted')
          ) : (
            <>
              <Check size={16} aria-hidden="true" />
              <span className="sr-only">{t('helperResults.saved')}</span>
            </>
          )}
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
          title: subtitle ? `${title} ${subtitle}` : title,
        })}
        aria-description={outcome ? t(outcome) : undefined}
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
  const inputEstimate = usage.latestInputEstimate;
  const lastInput = usage.latestInputTokens ?? null;
  const outputUnknown = totals.outputTokens.reported === 0 && totals.outputTokens.unknown > 0;
  const partial = [totals.inputTokens, totals.outputTokens].some(
    (amount) => amount.reported > 0 && amount.unknown > 0
  );
  return (
    <div className="helper-result-usage">
      <details className="execution-record scene-usage">
        <summary>
          <span className="ui-meta-row">
            <span className="sr-only">{t('helperResults.usage')}</span>
            {(lastInput !== null || inputEstimate !== null) && (
              <span>
                {t(
                  lastInput !== null
                    ? 'helperResults.inputSummary'
                    : 'helperResults.inputEstimateSummary',
                  { count: usageCompact(lastInput ?? inputEstimate!) }
                )}
              </span>
            )}
            <span>
              {outputUnknown
                ? t('helperResults.outputUnknown')
                : t('helperResults.outputSummary', {
                    count: usageCompact(totals.outputTokens.value),
                  })}
            </span>
            {usage.toolExecutions > 0 && (
              <span>
                {t('helperResults.toolSummary', { count: formatNumber(usage.toolExecutions) })}
              </span>
            )}
            {partial && <span>{t('helperResults.partialUsage')}</span>}
          </span>
        </summary>
        <HelperTaskUsageRecord usage={usage} />
      </details>
    </div>
  );
}

export function HelperTaskUsageRecord({ usage }: { usage: HelperTaskResultsView['usage'] }) {
  useI18n();
  const totals = helperTaskUsageTotals(usage.attempts);
  const inputLimit = usage.latestInputLimit;
  const inputEstimate = usage.latestInputEstimate;
  const lastInput = usage.latestInputTokens ?? null;
  const hasInputBudget = inputEstimate !== null && typeof inputLimit === 'number' && inputLimit > 0;
  const repeatedInput =
    usage.attempts.length > 1 ||
    totals.internalModelCalls.value > 1 ||
    totals.cachedInputTokens.value > 0;
  return (
    <>
      <dl className="scene-receipt">
        {lastInput !== null && (
          <>
            <dt>{t('helperResults.latestInput')}</dt>
            <dd>{formatNumber(lastInput)}</dd>
          </>
        )}
        {inputEstimate !== null && (
          <>
            <dt>{t('helperResults.latestEstimate')}</dt>
            <dd>
              {formatNumber(inputEstimate)}
              {hasInputBudget && ` / ${formatNumber(inputLimit)}`}
              {hasInputBudget && (
                <meter
                  className="helper-input-budget"
                  min={0}
                  max={inputLimit}
                  value={Math.min(inputEstimate, inputLimit)}
                  aria-label={t('helperResults.inputBudgetMeter')}
                  aria-valuetext={t('helperResults.inputBudgetValue', {
                    input: formatNumber(inputEstimate),
                    limit: formatNumber(inputLimit),
                  })}
                />
              )}
            </dd>
          </>
        )}
        {(usage.unmeasuredFileCount ?? 0) > 0 && (
          <>
            <dt>{t('helperResults.latestEstimate')}</dt>
            <dd>
              {usage.knownInputEstimate != null && (
                <span>
                  {t('helperConversation.measuredInput', {
                    count: formatNumber(usage.knownInputEstimate),
                  })}
                </span>
              )}
              <span>
                {t('helperConversation.unmeasuredFiles', {
                  count: usage.unmeasuredFileCount!,
                })}
              </span>
            </dd>
          </>
        )}
        <dt>{t('helperResults.executions')}</dt>
        <dd>{formatNumber(usage.attempts.length)}</dd>
        {usage.toolExecutions > 0 && (
          <>
            <dt>{t('helperResults.tools')}</dt>
            <dd>{formatNumber(usage.toolExecutions)}</dd>
          </>
        )}
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
      </dl>
      {repeatedInput && (
        <p className="helper-usage-note">{t('helperResults.cumulativeExplanation')}</p>
      )}
    </>
  );
}

export function helperTaskHasResults(data: HelperTaskResultsView) {
  return data.changes.length > 0 || data.results.some((result) => result.targets.length > 0);
}

export function HelperTaskResultItems({
  taskId,
  status,
  data,
  onOpenTarget,
  onOpenChange,
  rollbackUnavailable,
}: {
  taskId: string;
  status: HelperStatus;
  data: HelperTaskResultsView;
  onOpenTarget?: (target: HelperTaskResultTarget) => Promise<void> | void;
  onOpenChange?: (change: HelperChange) => Promise<void> | void;
  rollbackUnavailable: boolean;
}) {
  useI18n();
  const changes = data.changes.filter(
    (change) => change.domain !== 'settings' || !settingRecorded(change, data.results)
  );
  const rollback = useHelperRollback({
    taskId,
    changes: data.changes,
    enabled: !active(data.status) && rollbackCovers(data.changes),
    unavailable: rollbackUnavailable || active(status),
  });
  return (
    <>
      <ul className="helper-result-list">
        {changes.map((change, index) => (
          <li key={`change:${change.domain}:${change.targetId}:${index}`}>
            <HelperChangeCard
              change={change}
              onOpen={onOpenChange}
              rollback={rollback.action(change)}
              outcome={rollback.status(change)}
            />
            {change.domain === 'resource' &&
              !changes
                .slice(index + 1)
                .some(
                  (later) => later.domain === 'resource' && later.targetId === change.targetId
                ) && <ChangedStoryUiTheme themeId={change.targetId} />}
          </li>
        ))}
        {data.results.flatMap((result) =>
          result.targets
            .filter((target) => !recordedByChange(target, result.operation, data.changes))
            .map((target, index) => (
              <li key={`${result.eventSeq}:${target.kind}:${target.id}:${index}`}>
                <ResultTarget target={target} operation={result.operation} onOpen={onOpenTarget} />
              </li>
            ))
        )}
      </ul>
      {rollback.footer}
    </>
  );
}

export function HelperTaskResults({
  taskId,
  status,
  visible = true,
  eager = false,
  onOpenTarget,
  onOpenChange,
  onUsage,
  rollbackUnavailable = false,
  confirmation,
  questionAnswer,
}: {
  taskId: string;
  status: HelperStatus;
  visible?: boolean;
  eager?: boolean;
  onOpenTarget?: (target: HelperTaskResultTarget) => Promise<void> | void;
  onOpenChange?: (change: HelperChange) => Promise<void> | void;
  onUsage?: (taskId: string, usage: HelperTaskResultsView['usage']) => void;
  rollbackUnavailable?: boolean;
  confirmation?: {
    nameTarget: (target: HelperConfirmationTarget) => string;
    pending: readonly string[];
    latestTaskId?: string;
    onConfirm?: (grant: HelperConfirmationGrant) => void;
  };
  questionAnswer?: {
    isLatest: boolean;
    disabled: boolean;
    onAnswer: (choice: string) => void;
  };
}) {
  useI18n();
  const [sentinel, shown] = useSeen<HTMLSpanElement>(eager);
  const { data, reading, failed, retry } = useHelperTaskResults(taskId, status, visible && shown);
  const awaitingLaterTask = !!data?.confirmations?.some(
    (held) => held.grantable && !held.grantedBy
  );
  const laterTaskId =
    confirmation?.latestTaskId !== taskId ? confirmation?.latestTaskId : undefined;
  useEffect(() => {
    if (awaitingLaterTask && laterTaskId) retry();
  }, [awaitingLaterTask, laterTaskId, retry]);
  useEffect(() => {
    if (data) onUsage?.(taskId, data.usage);
  }, [data, taskId, onUsage]);
  return (
    <section
      className="helper-task-results"
      aria-label={t('helperResults.title')}
      data-testid="helper-task-results"
    >
      {!shown && <span ref={sentinel} className="helper-results-sentinel" aria-hidden="true" />}
      {data && (
        <>
          {confirmation && (data.confirmations ?? []).length > 0 && (
            <HelperConfirmations confirmations={data.confirmations} {...confirmation} />
          )}
          {data.question && (
            <HelperQuestionCard
              question={data.question}
              open={Boolean(questionAnswer?.isLatest && !active(data.status))}
              disabled={Boolean(questionAnswer?.disabled)}
              onAnswer={questionAnswer?.onAnswer}
            />
          )}
          <HelperTaskResultItems
            taskId={taskId}
            status={status}
            data={data}
            onOpenTarget={onOpenTarget}
            onOpenChange={onOpenChange}
            rollbackUnavailable={rollbackUnavailable}
          />
          {data.webSearchSuggestions?.map((html, index) => (
            <SearchSuggestionsFrame key={index} html={html} />
          ))}
          {data.unrecordedOperations > 0 && (
            <p className="helper-result-note">
              {t('helperResults.unrecorded', { count: data.unrecordedOperations })}
            </p>
          )}
          <TaskUsage usage={data.usage} />
        </>
      )}
      <LoadingState
        presentation="inline"
        loading={reading && shown}
        error={failed ? t(data ? 'helperResults.refreshFailed' : 'helperResults.loadFailed') : ''}
        errorLabel={t('helperResults.title')}
        label={t('helperResults.loading')}
        onRetry={retry}
      />
    </section>
  );
}

function ChangedStoryUiTheme({ themeId }: { themeId: string }) {
  const storyUi = useContext(ThemeContext)?.catalog.themes.find(
    (theme) => theme.id === themeId
  )?.storyUi;
  if (!storyUi) return null;
  return (
    <div className="helper-story-ui-preview">
      <strong>{t('storyUi.preview')}</strong>
      <StoryUiThemePreview storyUi={storyUi} />
    </div>
  );
}
