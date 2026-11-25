import { useState } from 'react';
import type { HelperChange, HelperTaskResultTarget } from '../core/helper.js';
import { labels } from './api.js';
import {
  HelperActivityTimeline,
  useHelperActivity,
  type HelperActivityView,
} from './HelperActivity.js';
import { helperTaskError } from './helper-task-error.js';
import {
  HelperTaskResultItems,
  HelperTaskUsageRecord,
  helperTaskHasResults,
  useHelperTaskResults,
} from './HelperTaskResults.js';
import { formatNumber, t, translateMessage, useI18n } from './i18n.js';
import { LoadingState } from './LoadingState.js';
import {
  matchesTaskHistoryFilter,
  sumTaskHistoryValues,
  TaskHistoryDuration,
  TaskHistoryFilters,
  TaskHistoryRow,
  TaskHistorySection,
  TaskHistorySummary,
  TaskHistoryTime,
  taskHistoryTotalLabel,
  taskStatusTone,
  type TaskHistoryFilter,
} from './TaskHistory.js';
import { usageCompact } from './usage-display.js';
import type { HelperTaskView } from './useHelperConversation.js';
import type { TraceCostTotal } from '../core/task-trace.js';
import { formatUsdSummary } from './pricing-display.js';
import { traceCostSummary } from './task-trace.js';
import { TraceCallTable, TraceDisclosure, TraceFooter } from './TaskTrace.js';

type ResultActions = {
  onOpenTarget?: (target: HelperTaskResultTarget) => void | Promise<void>;
  onOpenChange?: (change: HelperChange) => void | Promise<void>;
  rollbackUnavailable: boolean;
};

const running = (task: HelperTaskView) => task.status === 'queued' || task.status === 'running';

function helperTaskTotals(tasks: HelperTaskView[], partial: boolean) {
  const count = formatNumber(tasks.length);
  return [
    {
      label: t('chatsettings.taskHistoryCount'),
      value: partial ? t('chatsettings.taskHistoryAtLeast', { value: count }) : count,
    },
    {
      label: t('chatsettings.taskHistoryTokens'),
      value: t('chatsettings.taskHistoryTokenValue', {
        input: taskHistoryTotalLabel(
          sumTaskHistoryValues(
            tasks.map((task) => task.usage.inputTokens),
            partial
          ),
          formatNumber
        ),
        output: taskHistoryTotalLabel(
          sumTaskHistoryValues(
            tasks.map((task) => task.usage.outputTokens),
            partial
          ),
          formatNumber
        ),
      }),
    },
    {
      label: t('chatsettings.taskHistoryCost'),
      value: taskHistoryTotalLabel(
        sumTaskHistoryValues(
          tasks.flatMap((task) => {
            const cost = taskCost(task);
            if (!cost) return [];
            return [cost.usd ?? (cost.subtotalUsd > 0 ? cost.subtotalUsd : null)];
          }),
          partial ||
            tasks.some((task) => {
              const cost = taskCost(task);
              return !!cost && cost.usd === null && cost.subtotalUsd > 0;
            })
        ),
        formatUsdSummary
      ),
    },
  ];
}

function taskCost(task: HelperTaskView): TraceCostTotal | null {
  if (task.estimatedCost) return task.estimatedCost.attemptCount ? task.estimatedCost : null;
  if (!task.usage.modelCalls) return null;
  return {
    usd: task.usage.costUsd,
    subtotalUsd: task.usage.costUsd ?? 0,
    unknownCount: task.usage.costUsd === null ? task.usage.modelCalls : 0,
    attemptCount: task.usage.modelCalls,
  };
}

function HelperTaskHistoryDetail({
  task,
  visible,
  activity,
  ...actions
}: ResultActions & {
  task: HelperTaskView;
  visible: boolean;
  activity?: HelperActivityView;
}) {
  useI18n();
  const results = useHelperTaskResults(task.id, task.status, visible);
  const own = useHelperActivity(task.id, task.status, visible && !activity);
  const steps = activity ?? own;
  const [copyFailed, setCopyFailed] = useState(false);
  const data = results.data;
  const raw = () => JSON.stringify({ task, results: data, activity: steps.data }, null, 2);
  const calls = data?.usage.attempts ?? [];
  return (
    <div className="task-history-sections">
      <TaskHistorySection title={t('helpers.historyChanges')}>
        {data && (
          <HelperTaskResultItems
            taskId={task.id}
            status={task.status}
            data={data}
            onOpenTarget={actions.onOpenTarget}
            onOpenChange={actions.onOpenChange}
            rollbackUnavailable={actions.rollbackUnavailable}
          />
        )}
        {data && !running(task) && !helperTaskHasResults(data) && (
          <p>{t('helpers.historyNoChanges')}</p>
        )}
        {data && data.unrecordedOperations > 0 && (
          <p className="helper-result-note">
            {t('helperResults.unrecorded', { count: data.unrecordedOperations })}
          </p>
        )}
        <LoadingState
          presentation="inline"
          loading={results.reading}
          error={
            results.failed
              ? t(data ? 'helperResults.refreshFailed' : 'helperResults.loadFailed')
              : ''
          }
          errorLabel={t('helperResults.title')}
          label={t('helperResults.loading')}
          onRetry={results.retry}
        />
      </TaskHistorySection>
      <TaskHistorySection title={t('visuals.historyCalls')}>
        {data ? (
          <HelperTaskUsageRecord usage={data.usage} />
        ) : (
          <p>
            {task.usage.outputTokens == null
              ? t('helpers.m311Unknown', { calls: formatNumber(task.usage.modelCalls) })
              : t('helpers.m311', {
                  calls: formatNumber(task.usage.modelCalls),
                  output: usageCompact(task.usage.outputTokens),
                })}
          </p>
        )}
      </TaskHistorySection>
      <TaskHistorySection title={t('taskTrace.flow')}>
        <HelperActivityTimeline status={task.status} source={steps} />
        {calls.length > 0 && (
          <TraceDisclosure
            title={t('taskTrace.callsCount', { count: calls.length })}
            testId="helper-call-list"
          >
            <TraceCallTable calls={calls} revision={task.updatedAt} label={t('taskTrace.calls')} />
          </TraceDisclosure>
        )}
      </TaskHistorySection>
      {copyFailed && <p className="error">{t('visuals.historyCopyFailed')}</p>}
      <TraceFooter id={task.id} raw={raw} onCopyFailed={() => setCopyFailed(true)} />
    </div>
  );
}

export function HelperTaskHistory({
  tasks,
  focusedTaskId,
  visible,
  hasOlder,
  loadingOlder,
  onLoadOlder,
  onShowAll,
  inConversation,
  onShowInConversation,
  liveActivity,
  ...actions
}: ResultActions & {
  tasks: HelperTaskView[];
  focusedTaskId?: string;
  visible: boolean;
  hasOlder: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  onShowAll: () => void;
  inConversation: (taskId: string) => boolean;
  onShowInConversation: (taskId: string) => void;
  liveActivity?: { taskId: string; view: HelperActivityView };
}) {
  useI18n();
  const [filter, setFilter] = useState<TaskHistoryFilter>('all');
  const tone = (task: HelperTaskView) => taskStatusTone(task.status);
  const scoped = focusedTaskId ? tasks.filter((task) => task.id === focusedTaskId) : tasks;
  const shown = focusedTaskId
    ? scoped
    : scoped.filter((task) => matchesTaskHistoryFilter(tone(task), filter));
  const counts = {
    all: tasks.length,
    running: tasks.filter((task) => matchesTaskHistoryFilter(tone(task), 'running')).length,
    issue: tasks.filter((task) => matchesTaskHistoryFilter(tone(task), 'issue')).length,
  };
  return (
    <>
      {focusedTaskId ? (
        <div className="task-history-toolbar">
          <button type="button" className="secondary" onClick={onShowAll}>
            {t('helpers.m066')}
          </button>
        </div>
      ) : (
        tasks.length > 0 && (
          <div className="task-history-toolbar">
            <TaskHistoryFilters value={filter} counts={counts} onChange={setFilter} />
            <TaskHistorySummary items={helperTaskTotals(tasks, hasOlder)} />
          </div>
        )
      )}
      {!scoped.length && (
        <p className="muted" role="status">
          {t('helpers.m071')}
        </p>
      )}
      {scoped.length > 0 && !shown.length && (
        <div className="task-history-empty" role="status">
          <p className="muted">{t('chatsettings.taskHistoryNoMatch')}</p>
          <button type="button" className="secondary" onClick={() => setFilter('all')}>
            {t('chatsettings.taskHistoryShowAll')}
          </button>
        </div>
      )}
      {shown.length > 0 && (
        <div className="task-history-list">
          {shown.map((task) => {
            const calls = task.usage.modelCalls;
            const tokens =
              calls > 0 && task.usage.inputTokens != null && task.usage.outputTokens != null
                ? t('visualpanels.vPluralOneOther', {
                    v0: task.usage.inputTokens + task.usage.outputTokens,
                  })
                : null;
            const estimate = taskCost(task);
            const cost = estimate ? traceCostSummary(estimate) : null;
            return (
              <TaskHistoryRow
                key={task.id}
                tone={tone(task)}
                statusLabel={labels[task.status] ?? task.status}
                request={task.request}
                focused={task.id === focusedTaskId}
                dataProps={{ 'data-testid': 'helper-task-record', 'data-task-id': task.id }}
                meta={[
                  { key: 'model', value: task.modelTitle || null },
                  {
                    key: 'duration',
                    value: (
                      <TaskHistoryDuration
                        startedAt={task.startedAt ?? task.createdAt}
                        finishedAt={running(task) ? null : task.updatedAt}
                      />
                    ),
                  },
                  {
                    key: 'calls',
                    value: calls > 0 ? t('helpers.m314', { count: formatNumber(calls) }) : null,
                  },
                  { key: 'tokens', value: tokens },
                  { key: 'cost', value: cost },
                  { key: 'time', value: <TaskHistoryTime at={task.createdAt} /> },
                ]}
                notice={
                  <>
                    {task.error && <p className="error">{helperTaskError(task.error)}</p>}
                    {task.completedEffects && (
                      <p>
                        {t('helpers.m315', {
                          count: formatNumber(task.completedEffects.count),
                          labels: task.completedEffects.labels.map(translateMessage).join(', '),
                        })}
                      </p>
                    )}
                  </>
                }
                actions={
                  inConversation(task.id) && (
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => onShowInConversation(task.id)}
                    >
                      {t('helpers.showInConversation')}
                    </button>
                  )
                }
              >
                <HelperTaskHistoryDetail
                  task={task}
                  visible={visible}
                  activity={liveActivity?.taskId === task.id ? liveActivity.view : undefined}
                  {...actions}
                />
              </TaskHistoryRow>
            );
          })}
        </div>
      )}
      {!focusedTaskId && hasOlder && (
        <button type="button" className="secondary" disabled={loadingOlder} onClick={onLoadOlder}>
          {t('helpers.m072')}
        </button>
      )}
    </>
  );
}
