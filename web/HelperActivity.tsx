import { t, useI18n, translateMessage, formatNumber, message as uiMessage } from './i18n.js';
import { LoadingState } from './LoadingState.js';
import { NoticeBanner } from './NoticeBanner.js';
import { useCallback, useEffect, useState } from 'react';
import type { HelperActivity as Activity } from '../core/helper-activity.js';
import type { HelperStatus } from '../core/helper.js';
import { api } from './api.js';
import { helperActivityStages } from './helper-activity.js';
import { requestFileError } from './request-file-errors.js';
import { statusGlyph } from './TurnStatus.js';

type ActivityView = {
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
): ActivityView {
  useI18n();
  const [view, setView] = useState<ActivityView>({ data: null, error: '' });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt explicitly retries the same activity read.
  useEffect(() => {
    if (!taskId || !visible) return;
    let disposed = false;
    let pending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      if (disposed || pending || document.hidden) return;
      pending = true;
      setView((old) => ({
        taskId,
        data: old.taskId === taskId ? old.data : null,
        error: old.taskId === taskId ? old.error : '',
        reading: true,
      }));
      clearTimeout(timer);
      try {
        const data = await api<Activity>(`/helper/tasks/${encodeURIComponent(taskId)}/activity`);
        if (!disposed) setView({ taskId, data, error: '' });
      } catch (cause) {
        if (!disposed)
          setView((old) => ({
            taskId,
            data: old.data?.taskId === taskId ? old.data : null,
            error: cause instanceof Error ? cause.message : uiMessage('helpers.m112'),
          }));
      } finally {
        pending = false;
        if (!disposed) setView((old) => ({ ...old, reading: false }));
        if (!disposed && status === 'running' && !document.hidden)
          timer = setTimeout(() => void read(), 1200);
      }
    };
    const visibility = () => {
      clearTimeout(timer);
      if (!document.hidden) void read();
    };
    void read();
    document.addEventListener('visibilitychange', visibility);
    return () => {
      disposed = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [taskId, status, visible, attempt]);
  return { ...(view.taskId === taskId ? view : { data: null, error: '' }), retry };
}

const stateLabels = {
  running: 'helpers.m113',
  completed: 'helpers.m114',
  issue: 'helpers.m115',
  stopped: 'helpers.m116',
  recorded: 'helpers.m117',
};

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
  source?: ActivityView;
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
          error={translateMessage(error)}
          errorLabel={t('helpers.m119')}
          label={t('helpers.m120')}
          onRetry={retry}
        />
      )}
      {data?.hasEarlier && <p className="muted">{t('helpers.m121')}</p>}
      {data && !data.events.length && <p className="muted">{t('helpers.m122')}</p>}
      {data && (
        <ol className="helper-activity-stages">
          {helperActivityStages({ ...data, status }).map((stage) => {
            const toolCount = stage.events.filter((event) => event.kind === 'tool.finished').length;
            const Glyph =
              statusGlyph[
                stage.state === 'running'
                  ? 'running'
                  : stage.state === 'issue'
                    ? 'issue'
                    : stage.state === 'stopped'
                      ? 'cancelled'
                      : 'done'
              ];
            return (
              <li key={stage.id} data-state={stage.state}>
                <details className="helper-activity-stage">
                  <summary className="helper-activity-stage-head">
                    <Glyph
                      size={14}
                      aria-hidden="true"
                      className={stage.state === 'running' ? 'activity-spinner' : undefined}
                    />
                    <span>{stage.label}</span>
                    <span className="sr-only">{t(stateLabels[stage.state])}</span>
                    {toolCount > 1 && (
                      <small>
                        {t('helperConversation.executions', {
                          count: formatNumber(toolCount),
                        })}
                      </small>
                    )}
                  </summary>
                  <ul className="helper-activity-records">
                    {stage.events.map((event) => (
                      <li key={event.seq} className="ui-meta-row">
                        <code>{event.name ?? event.kind}</code>
                        {event.status && <span>{event.status}</span>}
                        {event.purpose && <span>{event.purpose}</span>}
                        {event.applied !== undefined && (
                          <span>{event.applied ? t('helpers.m124') : t('helpers.m125')}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </details>
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
          })}
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
