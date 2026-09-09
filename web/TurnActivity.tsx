import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Job, ReaderActivity, ReaderRun, Source } from '../core/types.js';
import type { StoryJob } from '../core/story.js';
import { RunTaskDetails } from './RunTaskDetails.js';
import { LazyDiagnostics } from './LazyDiagnostics.js';
import { StoryJobList } from './StoryPanel.js';
import { api, labels } from './api.js';
import { elapsedLabel } from './ActivityStatus.js';
import { TurnStatus } from './TurnStatus.js';

const active = (status: string) => ['queued', 'running', 'waiting_for_state'].includes(status);
const attention = (status: string) =>
  ['failed', 'interrupted', 'partial', 'stale', 'refused'].includes(status);
const names: Record<string, string> = {
  translation: '번역',
  image: '이미지',
  status: '장면 상태',
  state: '상태 정리',
  context: '문맥 압축',
  illustration: '삽화',
};

type Props = {
  run: ReaderRun;
  source?: Source;
  jobs: Job[];
  activities: ReaderActivity[];
  connected: boolean;
  branchId?: string;
  revision: number;
  refresh: () => Promise<void>;
  onError: (message: string) => void;
  children?: ReactNode;
  /** Scene number and badges rendered before the status glyph. */
  leading?: ReactNode;
  /** Badges shown after the status glyph, such as a manual-translation marker. */
  badges?: ReactNode;
};

export function TurnActivity(props: Props) {
  return <TurnActivityContent key={props.run.id} {...props} />;
}

function TurnActivityContent({
  run,
  source,
  jobs,
  activities,
  connected,
  branchId,
  revision,
  refresh,
  onError,
  children,
  leading,
  badges,
}: Props) {
  const storageKey = `turn-activity:${run.chatId}:${run.id}`;
  const [open, setOpen] = useState(() => {
    try {
      return sessionStorage.getItem(storageKey) === 'open';
    } catch {
      return false;
    }
  });
  const visibleRevision = useRef(revision);
  if (open) visibleRevision.current = revision;
  const [now, setNow] = useState(Date.now);
  // The reader owns current-source/hash projection. Image views have independent latest slots.
  const currentJobs = [
    ...new Map(
      jobs
        .filter(
          (job) => source && job.sourceRevision === source.id && job.sourceHash === source.hash
        )
        .sort((a, b) => (a.revision ?? 1) - (b.revision ?? 1))
        .map((job) => [
          job.kind === 'image' ? `image:${job.imageTarget?.mode ?? 'original'}` : job.kind,
          job,
        ])
    ).values(),
  ];
  const related = activities.filter((item) =>
    item.kind === 'main' ? item.id === run.id : !!source && item.sourceRevision === source.id
  );
  const storyHistory = related.filter(
    (item) =>
      item.kind === 'state' &&
      (!item.branchId || item.branchId === (branchId ?? run.snapshot.branchId))
  );
  const story = [...new Map(storyHistory.map((item) => [item.kind, item])).values()];
  const context = related
    .filter(
      (item) =>
        item.kind === 'context' &&
        (!item.branchId || item.branchId === (branchId ?? run.snapshot.branchId))
    )
    .at(-1);
  const previousStory = storyHistory.filter(
    (item) => !story.some((current) => current.id === item.id)
  );
  // Illustrations attach to the response text; the reader strip owns their actions.
  const illustrations = related.filter((item) => item.kind === 'illustration');
  const entries = [
    ...currentJobs.map((job) => ({
      id: job.id,
      kind: job.kind,
      status: job.status,
      label:
        job.kind === 'image'
          ? `${job.imageTarget?.mode === 'translation' ? '번역' : '원문'} 이미지 배치`
          : names[job.kind],
    })),
    ...story,
    ...(context ? [context] : []),
    ...illustrations,
  ];
  const running = active(run.status) || entries.some((item) => active(item.status));
  useEffect(() => {
    if (!running) return;
    // Same cadence as the composer status row, so the two never disagree by a second.
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [running]);
  const mainLabel = run.snapshot.forkedFrom
    ? '복사한 원고'
    : run.packageStart?.mode === 'authored'
      ? '작성된 도입문'
      : run.status === 'running'
        ? '장면을 쓰는 중'
        : run.status === 'waiting_for_state'
          ? '상태 정리 대기'
          : `본문 ${labels[run.status] ?? run.status}`;
  const important = entries.filter((item) => item.status !== 'completed');
  const summary = [
    mainLabel,
    ...important.map(
      (item) =>
        `${'label' in item ? item.label : names[item.kind]} ${labels[item.status] ?? item.status}`
    ),
  ].join(' · ');
  const timing =
    related.find((item) => item.kind === 'main' && active(item.status)) ??
    related.find(
      (item) => active(item.status) && entries.some((current) => current.id === item.id)
    );
  const elapsed = connected && running && timing ? elapsedLabel(timing.startedAt, now) : '';
  const uncertain = !connected && running;
  const hasIssue = attention(run.status) || entries.some((item) => attention(item.status));
  const tone = uncertain ? 'uncertain' : hasIssue ? 'issue' : running ? 'running' : 'done';
  // A finished response shows only the check; its text stays for assistive technology.
  const quiet = tone === 'done' && !!source;
  const text = uncertain ? '연결 확인 중 · 진행 상태 미확인' : summary;
  return (
    <TurnStatus
      tone={tone}
      text={text}
      elapsed={elapsed}
      leading={leading}
      badges={badges}
      quiet={quiet}
      issue={hasIssue}
      storageKey={storageKey}
      onOpenChange={setOpen}
      dataProps={{ 'data-testid': 'turn-activity', 'data-run-id': run.id }}
    >
      <>
        {!connected && (
          <p className="connection-notice" role="status">
            연결을 다시 확인하는 중이에요. 아래는 마지막으로 확인한 상태예요.
          </p>
        )}
        {source && source.editRevision && source.editRevision > 0 ? (
          <p className="muted">
            본문 생성 기록은 생성 당시 원문 기준이에요. 후속 작업은 현재 수정본에 연결된 항목을
            보여줘요.
          </p>
        ) : null}
        <RunTaskDetails
          run={run}
          jobs={currentJobs}
          inlineJobs={currentJobs}
          revision={visibleRevision.current}
          refresh={refresh}
          onError={onError}
        >
          {children}
        </RunTaskDetails>
        {source && story.length > 0 && (
          <section aria-label="이 응답의 상태 작업">
            {story.map((item) => (
              <LazyDiagnostics<StoryJob>
                key={item.id}
                path={`/story-jobs/${item.id}`}
                revision={visibleRevision.current}
                title={`${names[item.kind]} · ${labels[item.status] ?? item.status} · 작업 관리`}
              >
                {(job) => <StoryTask job={job} refresh={refresh} onError={onError} />}
              </LazyDiagnostics>
            ))}
            {previousStory.length > 0 && (
              <details>
                <summary>이전 상태 작업 · {previousStory.length}개</summary>
                {previousStory.map((item) => (
                  <LazyDiagnostics<StoryJob>
                    key={item.id}
                    path={`/story-jobs/${item.id}`}
                    revision={visibleRevision.current}
                    title={`${names[item.kind]} · ${labels[item.status] ?? item.status}`}
                  >
                    {(job) => (
                      <>
                        <p>{job.error}</p>
                        <small>이전 실행 기록이에요. 새 작업은 현재 항목에서 관리해요.</small>
                      </>
                    )}
                  </LazyDiagnostics>
                ))}
              </details>
            )}
          </section>
        )}
        {context && (
          <section aria-label="이 응답의 문맥 작업">
            <p>문맥 압축 · {labels[context.status] ?? context.status}</p>
            <small>요약과 작업 관리는 채팅 설정의 상태와 문맥에서 확인해요.</small>
          </section>
        )}
        {illustrations.length > 0 && (
          <section aria-label="이 응답의 삽화 작업">
            {illustrations.map((item) => (
              <p key={item.id}>삽화 · {labels[item.status] ?? item.status}</p>
            ))}
            <small>삽화 결과와 다시 요청·삭제는 장면 아래 삽화 영역에서 확인해요.</small>
          </section>
        )}
      </>
    </TurnStatus>
  );
}

function StoryTask({
  job,
  refresh,
  onError,
}: {
  job: StoryJob;
  refresh: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const locked = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function act(path: string, body = {}) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError('');
    try {
      await api(path, body);
      await refresh();
    } catch (cause) {
      const message = (cause as Error).message;
      setError(message);
      onError(message);
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  return (
    <>
      <StoryJobList
        jobs={[job]}
        busy={busy}
        act={(path) => void act(path)}
        rebuild={(sourceId, kind) => void act(`/sources/${sourceId}/story/rebuild`, { kind })}
      />
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
