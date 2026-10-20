import { t, useI18n } from './i18n.js';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Job, ReaderActivity, ReaderRun, Source } from '../core/types.js';
import { RunTaskDetails } from './RunTaskDetails.js';
import { labels } from './api.js';
import { elapsedLabel } from './ActivityStatus.js';
import type { Illustration } from '../core/illustration.js';
import { IllustrationActivity } from './IllustrationActivity.js';
import { illustrationProgress } from './illustration-progress.js';
import { TurnStatus } from './TurnStatus.js';

const active = (status: string) => ['queued', 'running'].includes(status);
const attention = (status: string) =>
  ['failed', 'interrupted', 'partial', 'stale', 'refused'].includes(status);
const names: Record<string, string> = {
  translation: 'helpers.m217',
  image: 'helpers.m218',
  status: 'helpers.m219',
  illustration: 'helpers.m220',
};

type Props = {
  run: ReaderRun;
  source?: Source;
  jobs: Job[];
  illustrations?: Illustration[];
  activities: ReaderActivity[];
  connected: boolean;
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
  useI18n();
  return <TurnActivityContent key={props.run.id} {...props} />;
}

function TurnActivityContent({
  run,
  source,
  jobs,
  illustrations: allIllustrations = [],
  activities,
  connected,
  revision,
  refresh,
  onError,
  children,
  leading,
  badges,
}: Props) {
  useI18n();
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
          (job) =>
            job.kind !== 'status' &&
            source &&
            job.sourceRevision === source.id &&
            job.sourceHash === source.hash
        )
        .sort((a, b) => (a.revision ?? 1) - (b.revision ?? 1))
        .map((job) => [
          job.kind === 'image' ? `image:${job.imageTarget?.mode ?? 'original'}` : job.kind,
          job,
        ])
    ).values(),
  ];
  const related = activities.filter(
    (item) =>
      item.kind !== 'status' &&
      (item.kind === 'main' ? item.id === run.id : !!source && item.sourceRevision === source.id)
  );
  // Illustrations attach to the response text; the reader strip owns their actions.
  const illustrations = allIllustrations.filter(
    (item) => source && item.sourceRevision === source.id && item.sourceHash === source.hash
  );
  const progress = illustrations.length ? illustrationProgress(illustrations) : null;
  const entries: { id: string; kind: string; status: string; label?: string; summary?: string }[] =
    [
      ...currentJobs.map((job) => ({
        id: job.id,
        kind: job.kind,
        status: job.status,
        label:
          job.kind === 'image'
            ? t('helpers.m337', { mode: job.imageTarget?.mode ?? 'original' })
            : t(names[job.kind] ?? 'helpers.m224'),
      })),
      ...(progress
        ? [
            {
              id: 'illustrations',
              kind: 'illustration',
              status: progress.status,
              summary: progress.summary,
            },
          ]
        : []),
    ];
  const running = active(run.status) || entries.some((item) => active(item.status));
  useEffect(() => {
    if (!running) return;
    // Same cadence as the composer status row, so the two never disagree by a second.
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [running]);
  const authored = run.packageStart?.mode === 'authored';
  const mainLabel =
    run.packageStart?.mode === 'authored'
      ? t('helpers.m249')
      : run.status === 'running'
        ? run.executionMode === 'batch'
          ? t('helpers.m250')
          : t('helpers.m212')
        : t('helpers.m251', { v0: labels[run.status] ?? run.status });
  const important = entries.filter((item) => item.status !== 'completed');
  const summary = [
    ...(authored ? [] : [mainLabel]),
    ...important.map(
      (item) =>
        item.summary ??
        t('helpers.m338', {
          name: item.label ?? t(names[item.kind] ?? 'helpers.m224'),
          status: labels[item.status] ?? item.status,
        })
    ),
  ].join(' · ');
  const timing =
    related.find((item) => item.kind === 'main' && active(item.status)) ??
    related.find(
      (item) =>
        active(item.status) &&
        (entries.some((current) => current.id === item.id) ||
          illustrations.some((current) => current.id === item.id))
    );
  const elapsed = connected && running && timing ? elapsedLabel(timing.startedAt, now) : '';
  const uncertain = !connected && running;
  const hasIssue = attention(run.status) || entries.some((item) => attention(item.status));
  const tone = uncertain ? 'uncertain' : hasIssue ? 'issue' : running ? 'running' : 'done';
  // A finished response shows only the check; its text stays for assistive technology.
  const quiet = tone === 'done' && !!source;
  const text = uncertain ? t('helpers.m252') : summary || t('helpers.m253');
  if (authored && !entries.length)
    return (
      <div className="scene-header-lead">
        {leading}
        {badges}
      </div>
    );
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
            {t('helpers.m254')}
          </p>
        )}
        {!authored && source && source.editRevision && source.editRevision > 0 ? (
          <p className="muted">{t('helpers.m255')}</p>
        ) : null}
        <RunTaskDetails
          run={run}
          jobs={currentJobs}
          inlineJobs={currentJobs}
          afterJobs={
            source && (
              <IllustrationActivity
                items={illustrations}
                sourceId={source.id}
                sourceHash={source.hash}
                refresh={refresh}
                onError={onError}
              />
            )
          }
          revision={visibleRevision.current}
          refresh={refresh}
          onError={onError}
        >
          {children}
        </RunTaskDetails>
      </>
    </TurnStatus>
  );
}
