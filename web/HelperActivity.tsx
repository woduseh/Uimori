import { LoadingState } from './LoadingState.js';
import { useEffect, useState } from 'react';
import type { HelperActivity as Activity } from '../core/helper-activity.js';
import type { HelperStatus } from '../core/helper.js';
import { api } from './api.js';
import { helperActivityStages } from './helper-activity.js';

type ActivityView = { taskId?: string; data: Activity | null; error: string };

export function useHelperActivity(
  taskId: string | undefined,
  status: HelperStatus | undefined,
  visible: boolean
): ActivityView {
  const [view, setView] = useState<ActivityView>({ data: null, error: '' });
  useEffect(() => {
    if (!taskId || !visible) return;
    let disposed = false;
    let pending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      if (disposed || pending || document.hidden) return;
      pending = true;
      clearTimeout(timer);
      try {
        const data = await api<Activity>(`/helper/tasks/${encodeURIComponent(taskId)}/activity`);
        if (!disposed) setView({ taskId, data, error: '' });
      } catch (cause) {
        if (!disposed)
          setView((old) => ({
            taskId,
            data: old.data?.taskId === taskId ? old.data : null,
            error: cause instanceof Error ? cause.message : '활동 내역을 읽지 못했어요.',
          }));
      } finally {
        pending = false;
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
  }, [taskId, status, visible]);
  return view.taskId === taskId ? view : { data: null, error: '' };
}

const stateLabels = {
  running: '진행 중',
  completed: '마침',
  issue: '확인 필요',
  stopped: '종료됨',
  recorded: '기록',
};

export function HelperActivityDetails({
  taskId,
  status,
  visible,
  source,
}: {
  taskId: string;
  status: HelperStatus;
  visible: boolean;
  source?: ActivityView;
}) {
  const [open, setOpen] = useState(false);
  const own = useHelperActivity(taskId, status, visible && open && !source);
  const { data, error } = source ?? own;
  return (
    <details
      className="helper-activity-details"
      data-testid="helper-activity-details"
      onToggle={(event) => {
        if (event.target === event.currentTarget) setOpen(event.currentTarget.open);
      }}
    >
      <summary>활동 내역</summary>
      {open && (
        <>
          {(!data || error) && (
            <LoadingState
              compact
              loading={!error}
              error={error}
              errorLabel="활동 내역을 새로 읽지 못했어요."
              label="활동 내역을 불러오는 중이에요…"
            />
          )}
          {data?.hasEarlier && (
            <p className="muted">최근 활동 80건을 표시해요. 이전 활동은 생략됐어요.</p>
          )}
          {data && !data.events.length && <p className="muted">아직 기록된 활동이 없어요.</p>}
          {data && (
            <ol className="helper-activity-stages">
              {helperActivityStages({ ...data, status }).map((stage) => (
                <li key={stage.id} data-state={stage.state}>
                  <details>
                    <summary>
                      <span>{stage.label}</span>
                      <small>
                        {stateLabels[stage.state]}
                        {stage.events.length > 1 ? ` · ${stage.events.length}건` : ''}
                      </small>
                    </summary>
                    <ul className="helper-activity-records">
                      {stage.events.map((event) => (
                        <li key={event.seq}>
                          <code>{event.name ?? event.kind}</code>
                          {event.status && <span> · {event.status}</span>}
                          {event.purpose && <span> · {event.purpose}</span>}
                          {event.applied !== undefined && (
                            <span> · {event.applied ? '정리 결과 적용' : '정리 결과 미적용'}</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </details>
                  {stage.events.map((event) =>
                    event.error || event.denied ? (
                      <p className="error" key={event.seq}>
                        {event.name ? `${event.name} · ` : ''}
                        {event.error ?? '실행이 허용되지 않았어요.'}
                      </p>
                    ) : event.text ? (
                      <p key={event.seq}>
                        {event.text}
                        {event.textTruncated ? '… (이후 메시지 생략)' : ''}
                      </p>
                    ) : null
                  )}
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </details>
  );
}
