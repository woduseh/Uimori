import { t, useI18n, translateMessage, message as legacyDescriptor } from './i18n.js';
import { uiMessage, legacyUiMessage } from './ui-message.js';
import { LoadingState } from './LoadingState.js';
import { NoticeBanner } from './NoticeBanner.js';
import { useRef, useState } from 'react';
import type { HelperActivity as Activity, HelperActivityEvent } from '../core/helper-activity.js';
import type { HelperStatus } from '../core/helper.js';
import { api, labels } from './api.js';
import { helperActivityStages, helperRetrySentence } from './helper-activity.js';
import {
  groupHelperActivity,
  type HelperActivityRow,
  type HelperActivityStage,
  type HelperActivityState,
} from './helper-activity-groups.js';
import { requestFileError } from './request-file-errors.js';
import { TaskHistoryTimeline, type TaskHistoryStep } from './TaskHistory.js';
import { formatDurationMs } from './task-trace.js';
import { statusGlyph, type StatusTone } from './TurnStatus.js';
import { useRetryableEffect } from './useRetryableEffect.js';
import { useBottomFollow } from './useBottomFollow.js';
import { watchLive } from './live-stream.js';
import { helperPollDelay, helperRefreshSpacing } from './poll-delays.js';

export type HelperActivityView = {
  taskId?: string;
  data: Activity | null;
  error: string;
  reading?: boolean;
  retry?: () => void;
};

export function useHelperActivity(
  taskId: string | undefined,
  status: HelperStatus | undefined,
  visible: boolean
): HelperActivityView {
  useI18n();
  const [view, setView] = useState<HelperActivityView>({ data: null, error: '' });
  const retry = useRetryableEffect(() => {
    if (!taskId || !visible) return;
    let disposed = false;
    const read = async () => {
      setView((old) => ({
        taskId,
        data: old.taskId === taskId ? old.data : null,
        error: old.taskId === taskId ? old.error : '',
        reading: true,
      }));
      try {
        const data = await api<Activity>(`/helper/tasks/${encodeURIComponent(taskId)}/activity`);
        if (!disposed) setView({ taskId, data, error: '' });
      } catch (cause) {
        if (!disposed)
          setView((old) => ({
            taskId,
            data: old.data?.taskId === taskId ? old.data : null,
            error: cause instanceof Error ? cause.message : legacyDescriptor('helpers.m112'),
          }));
      } finally {
        if (!disposed) setView((old) => ({ ...old, reading: false }));
      }
    };
    const live = watchLive({
      match: (frame) => frame.event === 'helper' && frame.taskId === taskId,
      refresh: read,
      fallbackMs: () => (status === 'running' ? helperPollDelay.task : undefined),
      minIntervalMs: helperRefreshSpacing,
    });
    live.request();
    return () => {
      disposed = true;
      live.dispose();
    };
  }, [taskId, status, visible]);
  return { ...(view.taskId === taskId ? view : { data: null, error: '' }), retry };
}

const stateLabels = {
  running: 'helpers.m113',
  completed: 'helpers.m114',
  issue: 'helpers.m115',
  stopped: 'helpers.m116',
  recorded: 'helpers.m117',
};

function StageGlyph({ state }: { state: HelperActivityState }) {
  const Glyph =
    statusGlyph[
      state === 'running'
        ? 'running'
        : state === 'issue'
          ? 'issue'
          : state === 'stopped'
            ? 'cancelled'
            : 'done'
    ];
  return (
    <Glyph
      size={14}
      aria-hidden="true"
      className={state === 'running' ? 'activity-spinner' : undefined}
    />
  );
}

function recordOutcome(stage: HelperActivityStage, event: HelperActivityEvent) {
  if (event.kind === 'attempt.finished')
    return t('helpers.activityAttemptOutcome', { status: event.status ?? 'error' });
  if (event.kind === 'attempt.started')
    return stage.state === 'running'
      ? t('helpers.activityAttemptOutcome', { status: 'waiting' })
      : undefined;
  if (event.retry) return helperRetrySentence(event.retry);
  return event.name && event.status ? labels[event.status] : undefined;
}

function stageRecords(stage: HelperActivityStage) {
  return stage.events.flatMap((event) => {
    const name = event.kind.startsWith('tool.') ? event.name : undefined;
    const outcome = recordOutcome(stage, event);
    const applied =
      event.applied === undefined ? undefined : t(event.applied ? 'helpers.m124' : 'helpers.m125');
    return name || outcome || applied ? [{ seq: event.seq, name, outcome, applied }] : [];
  });
}

function StageRow({ stage }: { stage: HelperActivityStage }) {
  const toolCount = stage.events.filter((event) => event.kind === 'tool.finished').length;
  const records = stageRecords(stage);
  const head = (
    <>
      <StageGlyph state={stage.state} />
      <span>{stage.label}</span>
      {stage.target && <small>{stage.target}</small>}
      <span className="sr-only">{t(stateLabels[stage.state])}</span>
      {toolCount > 1 && (
        <small>
          {t('helperConversation.executions', {
            count: toolCount,
          })}
        </small>
      )}
    </>
  );
  return (
    <li data-state={stage.state}>
      {records.length ? (
        <details className="helper-activity-stage">
          <summary className="helper-activity-stage-head">{head}</summary>
          <ul className="helper-activity-records">
            {records.map((record) => (
              <li key={record.seq} className="ui-meta-row">
                {record.name && <code>{record.name}</code>}
                {record.outcome && <span>{record.outcome}</span>}
                {record.applied && <span>{record.applied}</span>}
              </li>
            ))}
          </ul>
        </details>
      ) : (
        <div className="helper-activity-stage helper-activity-stage-head helper-activity-stage-plain">
          {head}
        </div>
      )}
      {stage.events.map((event) =>
        event.error || event.denied ? (
          <NoticeBanner tone="error" key={event.seq}>
            {event.name ? `${event.name}: ` : ''}
            {requestFileError(event.error) ??
              (event.error ? translateMessage(event.error) : t('helpers.m126'))}
          </NoticeBanner>
        ) : event.text ? (
          <p key={event.seq}>
            {event.text}
            {event.textTruncated ? t('helpers.m127') : ''}
          </p>
        ) : null
      )}
    </li>
  );
}

export function HelperLiveActivity(props: {
  taskId: string;
  status: HelperStatus;
  visible: boolean;
  source: HelperActivityView;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const { onScroll } = useBottomFollow(scroller, content, props.visible, true);
  return (
    <div className="helper-current-activity-details" ref={scroller} onScroll={onScroll}>
      <div ref={content}>
        <HelperActivityDetails inline {...props} />
      </div>
    </div>
  );
}

export function HelperActivityDetails({
  taskId,
  status,
  visible,
  source,
  inline = false,
}: {
  taskId: string;
  status: HelperStatus;
  visible: boolean;
  source?: HelperActivityView;
  inline?: boolean;
}) {
  useI18n();
  const [open, setOpen] = useState(false);
  const active = inline ? visible : visible && open;
  const own = useHelperActivity(taskId, status, active && !source);
  const { data, error, reading, retry } = source ?? own;
  const body = (
    <>
      {(!data || error) && (
        <LoadingState
          presentation="inline"
          loading={reading || (!data && !error)}
          error={legacyUiMessage(error)}
          errorLabel={uiMessage('helpers.m119')}
          label={uiMessage('helpers.m120')}
          onRetry={retry}
        />
      )}
      {data && !data.events.length && <p className="muted">{t('helpers.m122')}</p>}
      {data?.hasEarlier && <p className="muted">{t('helpers.activityEarlierOmitted')}</p>}
      {data && (
        <ol className="helper-activity-stages">
          {groupHelperActivity(helperActivityStages({ ...data, status })).map((row) =>
            row.kind === 'stage' ? (
              <StageRow key={row.stage.id} stage={row.stage} />
            ) : (
              <li key={`reads:${row.id}`} data-state={row.state}>
                <details className="helper-activity-stage helper-activity-reads">
                  <summary className="helper-activity-stage-head">
                    <StageGlyph state={row.state} />
                    <span>{t('helpers.m199')}</span>
                    <span className="helper-activity-read-summary">
                      {row.summary.scenes > 0 && (
                        <small>
                          {t('helpers.activityReadScenes', { count: row.summary.scenes })}
                        </small>
                      )}
                      {row.summary.resources > 0 && (
                        <small>
                          {t('helpers.activityReadResources', { count: row.summary.resources })}
                        </small>
                      )}
                      {row.summary.lookups > 0 && (
                        <small>
                          {t('helpers.activityReadLookups', { count: row.summary.lookups })}
                        </small>
                      )}
                    </span>
                    <span className="sr-only">{t(stateLabels[row.state])}</span>
                  </summary>
                  <ol className="helper-activity-read-calls">
                    {row.stages.map((stage) => (
                      <li key={stage.id} data-state={stage.state}>
                        <StageGlyph state={stage.state} />
                        <span>{stage.label}</span>
                        {stage.target && <small>{stage.target}</small>}
                        <code>{stage.events.at(-1)?.name}</code>
                        <span className="sr-only">{t(stateLabels[stage.state])}</span>
                      </li>
                    ))}
                  </ol>
                </details>
              </li>
            )
          )}
        </ol>
      )}
    </>
  );
  if (inline)
    return (
      <div
        className="helper-activity-details helper-activity-inline"
        data-testid="helper-activity-details"
      >
        {body}
      </div>
    );
  return (
    <details
      className="helper-activity-details"
      data-testid="helper-activity-details"
      onToggle={(event) => {
        if (event.target === event.currentTarget) setOpen(event.currentTarget.open);
      }}
    >
      <summary>{t('helpers.m118')}</summary>
      {open && body}
    </details>
  );
}

const stateTones: Record<HelperActivityState, StatusTone> = {
  running: 'running',
  completed: 'done',
  issue: 'issue',
  stopped: 'cancelled',
  recorded: 'done',
};

const routineOutcomes = new Set(['completed', 'tool_calls']);

function stageNotes(stage: HelperActivityStage) {
  return stage.events.flatMap((event) => {
    const outcome =
      event.kind.startsWith('tool.') ||
      (event.kind === 'attempt.finished' && routineOutcomes.has(event.status ?? ''))
        ? undefined
        : recordOutcome(stage, event);
    const applied =
      event.applied === undefined ? undefined : t(event.applied ? 'helpers.m124' : 'helpers.m125');
    return [outcome, applied].filter((note): note is string => !!note);
  });
}

function stageMeasures(stage: HelperActivityStage) {
  return [
    stage.resultChars === undefined
      ? undefined
      : t('taskTrace.resultChars', { count: stage.resultChars }),
    stage.elapsedMs === undefined ? undefined : formatDurationMs(stage.elapsedMs),
  ];
}

function stageStep(stage: HelperActivityStage): TaskHistoryStep {
  const toolCount = stage.events.filter((event) => event.kind === 'tool.finished').length;
  return {
    key: stage.id,
    tone: stateTones[stage.state],
    stateLabel: t(stateLabels[stage.state]),
    label: stage.label,
    meta: [
      stage.tool && stage.tool !== stage.label ? <code key="tool">{stage.tool}</code> : undefined,
      stage.target,
      toolCount > 1 ? t('helperConversation.executions', { count: toolCount }) : undefined,
      ...stageMeasures(stage),
      ...stageNotes(stage),
    ],
    children: stage.events.map((event) =>
      event.error || event.denied ? (
        <NoticeBanner tone="error" key={event.seq}>
          {requestFileError(event.error) ??
            (event.error ? translateMessage(event.error) : t('helpers.m126'))}
        </NoticeBanner>
      ) : event.text ? (
        <p key={event.seq} className="task-history-step-text">
          {event.text}
          {event.textTruncated ? t('helpers.m127') : ''}
        </p>
      ) : null
    ),
  };
}

function readsStep(row: Extract<HelperActivityRow, { kind: 'reads' }>): TaskHistoryStep {
  const targets = [...new Set(row.stages.flatMap((stage) => (stage.target ? [stage.target] : [])))];
  const tools = [...new Set(row.stages.flatMap((stage) => (stage.tool ? [stage.tool] : [])))];
  const elapsed = row.stages.reduce((total, stage) => total + (stage.elapsedMs ?? 0), 0);
  return {
    key: `reads:${row.id}`,
    tone: stateTones[row.state],
    stateLabel: t(stateLabels[row.state]),
    label: t('helpers.m199'),
    meta: [
      row.summary.scenes > 0
        ? t('helpers.activityReadScenes', { count: row.summary.scenes })
        : undefined,
      row.summary.resources > 0
        ? t('helpers.activityReadResources', { count: row.summary.resources })
        : undefined,
      row.summary.lookups > 0
        ? t('helpers.activityReadLookups', { count: row.summary.lookups })
        : undefined,
      elapsed > 0 ? formatDurationMs(elapsed) : undefined,
    ],
    children: (targets.length > 0 || tools.length > 0) && (
      <p className="ui-meta-row task-history-step-text">
        {tools.map((tool) => (
          <code key={`tool:${tool}`}>{tool}</code>
        ))}
        {targets.map((target) => (
          <span key={target}>{target}</span>
        ))}
      </p>
    ),
  };
}

export function HelperActivityTimeline({
  status,
  source,
}: {
  status: HelperStatus;
  source: HelperActivityView;
}) {
  useI18n();
  const { data, error, reading, retry } = source;
  const steps = data
    ? groupHelperActivity(helperActivityStages({ ...data, status })).map((row) =>
        row.kind === 'stage' ? stageStep(row.stage) : readsStep(row)
      )
    : [];
  return (
    <>
      {(!data || error) && (
        <LoadingState
          presentation="inline"
          loading={reading || (!data && !error)}
          error={legacyUiMessage(error)}
          errorLabel={uiMessage('helpers.m119')}
          label={uiMessage('helpers.m120')}
          onRetry={retry}
        />
      )}
      {data && !data.events.length && <p>{t('helpers.m122')}</p>}
      {data?.hasEarlier && <p>{t('helpers.activityEarlierOmitted')}</p>}
      {steps.length > 0 && <TaskHistoryTimeline steps={steps} />}
    </>
  );
}
