import { useContext, useEffect, useId, useRef, useState } from 'react';
import {
  BookMarked,
  BookOpen,
  Check,
  Clock3,
  FileText,
  Image,
  Languages,
  ListTree,
  Palette,
  PenLine,
  Settings2,
  StickyNote,
} from 'lucide-react';
import {
  HELPER_COMPACTION_INPUT_RATIO,
  type HelperStatus,
  type HelperTaskResultTarget,
  type HelperTaskResultsView,
} from '../core/helper.js';
import { api } from './api.js';
import { watchLive } from './live-stream.js';
import { helperPollDelay, helperRefreshSpacing } from './poll-delays.js';
import { HelperQuestionCard } from './HelperQuestionCard.js';
import {
  HelperConfirmations,
  type HelperConfirmationGrant,
  type HelperConfirmationTarget,
} from './HelperConfirmations.js';
import { isStoryUiStyle } from '../core/story-ui-style.js';
import { ContextBar, ContextLegend, ContextTable } from './ContextBreakdown.js';
import { helperInputBreakdown } from './HelperContextUsage.js';
import { formatNumber, t, useI18n } from './i18n.js';
import { uiMessage } from './ui-message.js';
import { DropdownIcon } from './ui-icons.js';
import { LoadingState } from './LoadingState.js';
import { NoticeBanner } from './NoticeBanner.js';
import { usageCompact } from './usage-display.js';
import type { ModelPricing, TokenRates } from '../core/pricing-types.js';
import { formatUsd, pricingRateLabels } from './pricing-display.js';
import { TraceSummary, traceUsageTotals } from './TaskTrace.js';
import { StoryUiThemePreview } from './StoryBoardPanel.js';
import { ThemeContext } from './ThemeContext.js';
import './helper-task-results.css';
import './scene-usage.css';
import './run-task-details.css';
import { useRetryableEffect } from './useRetryableEffect.js';

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
  'chat.storyUi': 'storyUi.enable',
  'chat.storyUiStyle': 'storyUi.style',
  'newChat.maxCalls': 'settings.m92',
  'newChat.storyUi': 'storyUi.enable',
  'newChat.storyUiStyle': 'storyUi.style',
  'bot.storyUiTheme': 'storyUi.botDefault',
  'chat.illustrationProfiles': 'visuals.characterProfiles',
  'chat.illustrationReferences': 'visuals.m028',
  'model.pricing': 'helperResults.modelPricing',
  'judgment.pricing': 'helperResults.judgmentPricing',
  'vertex.location': 'helperResults.vertexLocation',
  'chat.variables': 'helperResults.chatVariables',
  'chat.options': 'helperResults.chatOptions',
  'chat.storyGuide': 'helperResults.storyGuide',
  'model.parameters': 'helperResults.modelParameters',
  'global.mainPromptPreset': 'helperResults.globalMainPromptPreset',
  'global.translationPromptPreset': 'helperResults.globalTranslationPromptPreset',
  'global.autoTranslate': 'helperResults.globalAutoTranslate',
  'global.translationLanguage': 'settings.autoTranslationLanguage',
  'newChat.autoRefusalRetryEnabled': 'helperResults.newChatAutoRefusalRetry',
  'newChat.autoRefusalMaxRetries': 'helperResults.newChatAutoRefusalMaxRetries',
  'newChat.loreContext': 'helperResults.newChatLoreContext',
  'model.register': 'helperResults.modelRegistered',
  'model.delete': 'helperResults.modelDeleted',
  'prompt.combination.save': 'helperResults.promptCombinationSaved',
  'prompt.combination.update': 'helperResults.promptCombinationUpdated',
  'prompt.combination.delete': 'helperResults.promptCombinationDeleted',
  'prompt.combination.apply': 'helperResults.promptCombinationApplied',
  'illustrationPreset.global': 'helperResults.illustrationPreset',
  'bot.illustrationPreset': 'helperResults.illustrationPreset',
  'chat.illustrationPreset': 'helperResults.illustrationPreset',
  'chat.attachments': 'helperResults.chatAttachments',
  'chat.loreContext': 'helperResults.chatLoreContext',
  'chat.authorNote': 'helperResults.chatAuthorNote',
  'scene.context': 'helperResults.sceneContext',
  'chat.bookmark': 'helperResults.chatBookmark',
};
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
  outline: ListTree,
  notes: StickyNote,
  'chat-lore': BookMarked,
};
const workOutcomes: Record<string, string> = {
  'illustration.generate': 'helperResults.illustrationQueued',
  'illustration.cut.redraw': 'helperResults.illustrationRedrawQueued',
  'illustration.cuts.place': 'helperResults.illustrationPlaced',
  'illustration.continuity.save': 'helperResults.illustrationContinuitySaved',
  'scene.request': 'helperResults.sceneQueued',
  'scene.translate': 'helperResults.translationQueued',
  'scene.title': 'helperResults.sceneNamed',
  'scene.patch': 'helperResults.sceneSaved',
  'scene.patchMany': 'helperResults.sceneSaved',
  'scene.save': 'helperResults.sceneSaved',
  'scene.restore': 'helperResults.sceneRestored',
  'outline.write': 'helperResults.outlineSaved',
  'notes.write': 'helperResults.notesSaved',
  'chat.lore': 'helperResults.chatLoreSaved',
  'chat.create': 'helperResults.chatCreated',
};
const savedTranslation = new Set(['scene.patch', 'scene.patchMany']);
const deletingOperations = new Set(['resource.delete', 'chat.delete', 'prompt.combination.delete']);
const queuedOperations = new Set([
  'illustration.generate',
  'illustration.cut.redraw',
  'scene.request',
  'scene.translate',
]);
const active = (status: HelperStatus) => status === 'running' || status === 'queued';

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

function receiptPricing(pricing: ModelPricing | undefined, rates: TokenRates | null | undefined) {
  return (
    pricing ??
    (rates === undefined
      ? undefined
      : rates === null
        ? { mode: 'official' as const }
        : { mode: 'manual' as const, rates })
  );
}

function pricingFields(pricing: ModelPricing) {
  const fields = new Map<string, string>();
  fields.set(
    t('providers.m502'),
    pricing.mode === 'official'
      ? t('taskTrace.catalogRates')
      : t('visualpanels.manuallyEnteredPrice')
  );
  if (pricing.mode !== 'manual') return fields;
  const addRates = (tier: string, rates: TokenRates | undefined) => {
    if (!rates) return;
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'cacheWrite1h'] as const) {
      if (rates[key] != null)
        fields.set(
          t('providers.m595', { value0: tier, value1: pricingRateLabels[key] }),
          formatUsd(rates[key])
        );
    }
  };
  for (const [tier, rates, long] of [
    ['Standard', pricing.rates, pricing.longContext],
    ['Flex', pricing.flexRates, pricing.flexLongContext],
    ['Batch', pricing.batchRates, pricing.batchLongContext],
  ] as const) {
    addRates(tier, rates);
    if (long) {
      fields.set(t('providers.m598', { value0: tier }), formatNumber(long.aboveInputTokens));
      addRates(t('providers.m599', { value0: tier }), long.rates);
    }
  }
  return fields;
}

function rateChanges(target: HelperTaskResultTarget) {
  const before = receiptPricing(target.beforePricing, target.beforeRates);
  const after = receiptPricing(target.afterPricing, target.afterRates);
  if (!before || !after) return [];
  const previous = pricingFields(before);
  const current = pricingFields(after);
  return [...new Set([...previous.keys(), ...current.keys()])]
    .filter((key) => previous.get(key) !== current.get(key))
    .map((label) => ({
      label,
      before: previous.get(label) ?? t('visualpanels.unknown'),
      after: current.get(label) ?? t('visualpanels.unknown'),
    }));
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
  const deleted = deletingOperations.has(operation);
  const rates = rateChanges(target);
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
    target.kind === 'translation' && savedTranslation.has(operation)
      ? 'helperResults.translationSaved'
      : target.kind === 'illustration' ||
          target.kind === 'chat' ||
          target.kind === 'translation' ||
          target.kind === 'scene' ||
          target.kind === 'outline' ||
          target.kind === 'notes' ||
          target.kind === 'chat-lore'
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
      {!deleted && rates.length > 0 ? (
        <span className="helper-result-pricing">
          {rates.map((change) => (
            <span key={change.label} className="helper-result-values">
              <strong>{change.label}</strong>
              <span>{change.before}</span>
              <span aria-hidden="true">→</span>
              <span className="sr-only">{t('helperResults.changedTo')}</span>
              <span>{change.after}</span>
            </span>
          ))}
        </span>
      ) : !deleted && target.before !== undefined && target.after !== undefined ? (
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

function TaskUsage({ usage }: { usage: HelperTaskResultsView['usage'] }) {
  const totals = traceUsageTotals(usage.attempts);
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
  return (
    <div className="helper-usage-record">
      <TaskContext usage={usage} />
      <TraceSummary calls={usage.attempts} toolExecutions={usage.toolExecutions} />
    </div>
  );
}

export function helperTaskHasResults(data: HelperTaskResultsView) {
  return data.results.some((result) => result.targets.length > 0);
}

export function HelperTaskResultItems({
  data,
  onOpenTarget,
}: {
  data: HelperTaskResultsView;
  onOpenTarget?: (target: HelperTaskResultTarget) => Promise<void> | void;
}) {
  useI18n();
  return (
    <ul className="helper-result-list">
      {data.results.flatMap((result) =>
        result.targets.map((target, index) => (
          <li key={`${result.eventSeq}:${target.kind}:${target.id}:${index}`}>
            <ResultTarget target={target} operation={result.operation} onOpen={onOpenTarget} />
            {target.kind === 'theme' && result.operation !== 'resource.delete' && (
              <ChangedStoryUiTheme themeId={target.id} />
            )}
          </li>
        ))
      )}
    </ul>
  );
}

export function HelperTaskResults({
  taskId,
  status,
  visible = true,
  eager = false,
  onOpenTarget,
  onUsage,
  confirmation,
  questionAnswer,
}: {
  taskId: string;
  status: HelperStatus;
  visible?: boolean;
  eager?: boolean;
  onOpenTarget?: (target: HelperTaskResultTarget) => Promise<void> | void;
  onUsage?: (taskId: string, usage: HelperTaskResultsView['usage']) => void;
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
          <HelperTaskResultItems data={data} onOpenTarget={onOpenTarget} />
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
        error={
          failed
            ? uiMessage(data ? 'helperResults.refreshFailed' : 'helperResults.loadFailed')
            : null
        }
        errorLabel={uiMessage('helperResults.title')}
        label={uiMessage('helperResults.loading')}
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
