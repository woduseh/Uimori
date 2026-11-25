import { useContext, useEffect, useId, useRef, useState } from 'react';
import {
  BookOpen,
  Check,
  Clock3,
  FileText,
  Image,
  Info,
  Languages,
  Palette,
  PenLine,
  Settings2,
} from 'lucide-react';
import {
  HELPER_COMPACTION_INPUT_RATIO,
  type HelperChange,
  type HelperStatus,
  type HelperTaskAttemptUsage,
  type HelperTaskResultTarget,
  type HelperTaskResultsView,
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
import { ContextBar, ContextLegend, ContextTable } from './ContextBreakdown.js';
import { helperInputBreakdown } from './HelperContextUsage.js';
import { formatNumber, t, useI18n } from './i18n.js';
import { IconButton } from './IconButton.js';
import { DropdownIcon } from './ui-icons.js';
import { LoadingState } from './LoadingState.js';
import { NoticeBanner } from './NoticeBanner.js';
import { usageCompact, usageUsd } from './usage-display.js';
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

function UsageAmount({ amount }: { amount: RecordedAmount }) {
  return (
    <>
      <span>
        {amount.reported === 0 && amount.unknown > 0
          ? t('helperResults.unknown')
          : formatNumber(amount.value)}
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
  if (part.reported === 0 || part.value === 0) return null;
  return (
    <small>
      {t(label, {
        count: formatNumber(part.value),
        share: formatNumber(whole.value > 0 ? part.value / whole.value : 0, {
          style: 'percent',
          maximumFractionDigits: 0,
        }),
      })}
    </small>
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
        <div className="helper-usage-body">
          <HelperTaskUsageRecord usage={usage} />
        </div>
      </details>
    </div>
  );
}

function TaskContext({ usage }: { usage: HelperTaskResultsView['usage'] }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const native = usage.latestInputExecution === 'codex-native';
  const reported = usage.latestInputTokens ?? null;
  const estimate = native ? null : usage.latestInputEstimate;
  const limit = native ? null : (usage.latestInputLimit ?? null);
  const threshold = limit ? Math.floor(limit * HELPER_COMPACTION_INPUT_RATIO) : null;
  const parts = estimate === null ? null : (usage.latestInputParts ?? null);
  const { rows, segments } = helperInputBreakdown(parts, estimate);
  const unmeasured = (usage.unmeasuredFileCount ?? 0) > 0;
  if (estimate === null && reported === null && !unmeasured) return null;
  return (
    <div className="helper-usage-context">
      <p className="helper-usage-headline">
        {estimate !== null ? (
          <span>
            {limit
              ? t('helperResults.contextHeadline', {
                  input: usageCompact(estimate),
                  limit: usageCompact(limit),
                })
              : t('helperResults.contextHeadlineNoLimit', { input: usageCompact(estimate) })}
          </span>
        ) : unmeasured ? (
          <span>{t('helperResults.contextUnmeasured')}</span>
        ) : (
          <span>{t('helperResults.contextExact', { count: formatNumber(reported!) })}</span>
        )}
        {estimate !== null && reported !== null && (
          <small>{t('helperResults.contextReported', { count: formatNumber(reported) })}</small>
        )}
        {unmeasured && usage.knownInputEstimate != null && (
          <small>
            {t('helperConversation.measuredInput', {
              count: formatNumber(usage.knownInputEstimate),
            })}
          </small>
        )}
        {unmeasured && (
          <small>
            {t('helperConversation.unmeasuredFiles', { count: usage.unmeasuredFileCount! })}
          </small>
        )}
      </p>
      {parts && estimate !== null && (
        <>
          {limit !== null && (
            <ContextBar segments={segments} total={estimate} limit={limit} threshold={threshold} />
          )}
          <div className="context-breakdown-summary">
            <ContextLegend segments={segments} />
            <button
              type="button"
              className="scene-receipt-expand"
              aria-expanded={open}
              aria-controls={`${id}-parts`}
              onClick={() => setOpen(!open)}
            >
              <DropdownIcon size={14} aria-hidden="true" />
              {t(open ? 'contextBreakdown.hide' : 'contextBreakdown.show')}
            </button>
          </div>
          {open && (
            <div id={`${id}-parts`}>
              <ContextTable
                label={t('helperResults.contextTable')}
                rows={rows}
                total={estimate}
                limit={limit}
                threshold={threshold}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function HelperTaskUsageRecord({ usage }: { usage: HelperTaskResultsView['usage'] }) {
  useI18n();
  const totals = helperTaskUsageTotals(usage.attempts);
  const repeatedInput =
    usage.attempts.length > 1 ||
    totals.internalModelCalls.value > 1 ||
    totals.cachedInputTokens.value > 0;
  const cost = totals.costUsd;
  return (
    <div className="helper-usage-record">
      <TaskContext usage={usage} />
      <dl className="helper-usage-rows">
        <div data-row="calls">
          <dt>{t('helperResults.runs')}</dt>
          <dd>
            <span>
              {t('helperResults.modelCalls', { count: formatNumber(usage.attempts.length) })}
            </span>
            {usage.toolExecutions > 0 && (
              <span>
                {t('helperResults.toolSummary', { count: formatNumber(usage.toolExecutions) })}
              </span>
            )}
            {totals.internalModelCalls.reported > 0 && (
              <span>
                {t('helperResults.internalCallsShort', {
                  count: formatNumber(totals.internalModelCalls.value),
                })}
              </span>
            )}
          </dd>
        </div>
        <div data-row="input">
          <dt>
            <span>{t('helperResults.cumulativeInput')}</span>
            {repeatedInput && (
              <IconButton
                className="helper-usage-help"
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
        {cost.reported > 0 && (
          <div data-row="cost">
            <dt>{t('helperResults.costShort')}</dt>
            <dd>
              <span>
                {cost.unknown > 0
                  ? t('reader.inspectorCostAtLeast', { value: usageUsd(cost.value) })
                  : usageUsd(cost.value)}
              </span>
              {cost.unknown > 0 && (
                <small>
                  {t('helperResults.missingRequests', { count: formatNumber(cost.unknown) })}
                </small>
              )}
            </dd>
          </div>
        )}
      </dl>
    </div>
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
  review = false,
}: {
  taskId: string;
  status: HelperStatus;
  data: HelperTaskResultsView;
  onOpenTarget?: (target: HelperTaskResultTarget) => Promise<void> | void;
  onOpenChange?: (change: HelperChange) => Promise<void> | void;
  rollbackUnavailable: boolean;
  review?: boolean;
}) {
  useI18n();
  const changes = data.changes.filter(
    (change) => change.domain !== 'settings' || !settingRecorded(change, data.results)
  );
  const undoable = !active(data.status) && rollbackCovers(data.changes);
  const rollback = useHelperRollback({
    taskId,
    changes: data.changes,
    enabled: undoable,
    unavailable: rollbackUnavailable || active(status),
    review,
  });
  const expandSingle = review && undoable && changes.length === 1;
  return (
    <>
      {rollback.strip}
      <ul className="helper-result-list">
        {changes.map((change, index) => (
          <li key={`change:${change.domain}:${change.targetId}:${index}`}>
            <HelperChangeCard
              change={change}
              expanded={expandSingle}
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
  review = false,
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
  review?: boolean;
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
            review={review}
          />
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
