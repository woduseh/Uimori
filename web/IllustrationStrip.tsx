import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Illustration, IllustrationImage } from '../core/illustration.js';
import { CloseIcon, RefreshIcon, RunningIcon } from './ui-icons.js';
import { api } from './api.js';
import { ActionMenu } from './ActionMenu.js';
import { DeleteButton } from './DeleteButton.js';
import { Dialog } from './Dialog.js';
import {
  illustrationActive,
  illustrationErrorMessage,
  illustrationGeneratorLabels,
  illustrationReconcilable,
  illustrationRetryable,
  illustrationSkipped,
} from './illustration-labels.js';
import './illustrations.css';

type Actions = { refresh: () => Promise<void>; onError: (message: string) => void };
type Cut = { key: string; job: Illustration; picture?: Illustration; stale: boolean };

/** A target owns one reading position, even while a newer render is pending or failed. */
function cutsFor(items: Illustration[], sourceHash: string): Cut[] {
  const groups = new Map<string, Illustration[]>();
  for (const item of items) {
    if (item.task && item.task !== 'render') continue;
    const key = item.target?.id ?? item.id;
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  return [...groups].map(([key, attempts]) => {
    const last = attempts.at(-1)!;
    const display = last.display ?? attempts.find((item) => item.display)?.display;
    const job = attempts.find((item) => item.id === display?.latestRequestedJobId) ?? last;
    const picture = display
      ? attempts.find((item) => item.id === display.displayedJobId && item.images.length > 0)
      : attempts.findLast((item) => item.status === 'completed' && item.images.length > 0);
    return { key, job, picture, stale: job.sourceHash !== sourceHash };
  });
}
const collapseKey = (id: string) => `uimori:illustration-collapsed:${id}`;
function savedCollapse(id: string): boolean | undefined {
  try {
    const value = localStorage.getItem(collapseKey(id));
    return value === null ? undefined : value === 'true';
  } catch {
    return undefined;
  }
}

/** Only reading nodes are returned; original and translated text remain untouched. */
export function useIllustrationLayout({
  sourceId,
  sourceHash,
  illustrations,
  mode,
  translationHash,
  anchors,
  canInline,
  defaultCollapsed = false,
  refresh,
  onError,
}: Actions & {
  sourceId: string;
  sourceHash: string;
  illustrations: Illustration[];
  mode: 'original' | 'translation';
  translationHash?: string;
  anchors: string[];
  canInline: boolean;
  defaultCollapsed?: boolean;
}) {
  const [choices, setChoices] = useState<Record<string, boolean>>({});
  const items = illustrations.filter((item) => item.sourceRevision === sourceId);
  const cuts = cutsFor(items, sourceHash);
  const collapsed = (id: string) => choices[id] ?? savedCollapse(id) ?? defaultCollapsed;
  const setCollapsed = (id: string, value: boolean, persist = true) => {
    setChoices((old) => ({ ...old, [id]: value }));
    if (persist) {
      try {
        localStorage.setItem(collapseKey(id), String(value));
      } catch {
        /* Reading still works. */
      }
    }
  };
  const hero = cuts.find((cut) => !cut.stale && cut.job.display?.hero);
  const after = (cut: Cut) => {
    if (!canInline || cut.stale || cut === hero || !cut.job.target) return null;
    const anchor =
      mode === 'original'
        ? cut.job.target.endAnchor
        : cut.job.display?.translation?.textHash === translationHash
          ? cut.job.display?.translation?.afterAnchor
          : null;
    return anchor && anchors.includes(anchor) ? anchor : null;
  };
  const renderCut = (cut: Cut) => (
    <IllustrationCard
      key={cut.key}
      cut={cut}
      hero={cut === hero}
      collapsed={collapsed(cut.key)}
      onCollapse={(value, persist) => setCollapsed(cut.key, value, persist)}
      refresh={refresh}
      onError={onError}
    />
  );
  const fallback = cuts.filter((cut) => cut !== hero && !after(cut));
  const lastPlacement = items.findLast((item) => item.task === 'placement');
  const tasks = items.filter(
    (item) =>
      item.sourceHash === sourceHash &&
      item.task &&
      item.task !== 'render' &&
      (item.status !== 'completed' || illustrationSkipped(item)) &&
      (item.task !== 'placement' || item === lastPlacement)
  );
  const allCollapsed = cuts.length > 0 && cuts.every((cut) => collapsed(cut.key));
  return {
    header: items.length ? (
      <>
        <div className="illustration-toolbar" aria-label="이 응답의 삽화">
          <span>삽화 {cuts.length > 0 ? `${cuts.length}컷` : ''}</span>
          {cuts.length > 0 && (
            <button
              type="button"
              className="quiet"
              onClick={() => {
                const value = !allCollapsed;
                setChoices((old) => ({
                  ...old,
                  ...Object.fromEntries(cuts.map((cut) => [cut.key, value])),
                }));
                for (const cut of cuts) {
                  try {
                    localStorage.setItem(collapseKey(cut.key), String(value));
                  } catch {
                    /* Optional preference. */
                  }
                }
              }}
            >
              {allCollapsed ? '모두 펼치기' : '모두 접기'}
            </button>
          )}
        </div>
        {tasks.map((job) => (
          <IllustrationTask key={job.id} job={job} refresh={refresh} onError={onError} />
        ))}
        {hero && (
          <section
            className="illustrations illustration-hero"
            data-testid="illustrations"
            data-placement="hero"
            aria-label="대표 삽화"
          >
            {renderCut(hero)}
          </section>
        )}
      </>
    ) : null,
    inline: (anchor: string) => {
      const matches = cuts.filter((cut) => after(cut) === anchor);
      return matches.length ? (
        <section
          className="illustrations"
          data-testid="illustrations"
          data-placement="inline"
          data-after-anchor={anchor}
          aria-label="이 순간의 삽화"
        >
          {matches.map(renderCut)}
        </section>
      ) : null;
    },
    footer: fallback.length ? (
      <details className="illustration-supplement" data-testid="illustration-supplement">
        <summary>
          본문 밖 삽화 {fallback.length}컷
          {fallback.some((cut) => ['failed', 'interrupted'].includes(cut.job.status))
            ? ' · 확인할 작업 있음'
            : ''}
        </summary>
        <p className="muted">
          이 보기에서 위치를 연결하지 못했거나 수정 전 원문에 속한 삽화예요. 그림은 그대로 보관해요.
        </p>
        <section
          className="illustrations"
          data-testid="illustrations"
          data-placement="supplement"
          aria-label="본문 밖 삽화"
        >
          {fallback.map(renderCut)}
        </section>
      </details>
    ) : null,
  };
}

function useIllustrationAction({ refresh, onError }: Actions) {
  const locked = useRef(false);
  const [busy, setBusy] = useState(false);
  const act = async (path: string, body: unknown = {}, method = 'POST') => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    try {
      await api(path, body, method);
      await refresh();
    } catch (cause) {
      onError((cause as Error).message);
      await refresh().catch(() => undefined);
    } finally {
      locked.current = false;
      setBusy(false);
    }
  };
  return { busy, act };
}
function TaskButtons({
  job,
  busy,
  act,
}: {
  job: Illustration;
  busy: boolean;
  act: (path: string) => Promise<void>;
}) {
  return (
    <div className="illustration-actions">
      {illustrationActive(job) && (
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={() => void act(`/illustrations/${job.id}/cancel`)}
        >
          <CloseIcon size={16} aria-hidden="true" /> 취소
        </button>
      )}
      {illustrationReconcilable(job) && (
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={() => void act(`/illustrations/${job.id}/reconcile`)}
          title="이미 접수된 결과만 읽어요. 새로 그리지 않아요."
        >
          결과 확인
        </button>
      )}
      {illustrationRetryable(job) && (
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={() => void act(`/illustrations/${job.id}/retry`)}
        >
          <RefreshIcon size={16} aria-hidden="true" /> 다시 요청
        </button>
      )}
    </div>
  );
}
function IllustrationTask({ job, refresh, onError }: Actions & { job: Illustration }) {
  const { busy, act } = useIllustrationAction({ refresh, onError });
  const active = illustrationActive(job);
  return (
    <div
      className="illustration-task"
      data-testid="illustration-task"
      data-task={job.task}
      data-status={job.status}
    >
      <p role={active ? 'status' : 'alert'}>
        {active && <RunningIcon size={16} aria-hidden="true" />}
        {illustrationSkipped(job)
          ? `삽화 생략 · ${job.diagnostic?.skipped}`
          : active
            ? job.task === 'placement'
              ? '번역문 속 삽화 위치를 연결하고 있어요.'
              : '서로 다른 삽화 구간을 고르고 있어요.'
            : illustrationErrorMessage(job.error)}
      </p>
      <TaskButtons job={job} busy={busy} act={act} />
      {!active && (
        <DeleteButton
          path={`/illustrations/${job.id}`}
          title="이 삽화 작업 기록"
          label="작업 기록 삭제"
          description="이 작업 기록만 삭제해요. 완료된 그림과 본문은 유지돼요."
          iconOnly
          onDeleted={refresh}
          onError={onError}
        />
      )}
    </div>
  );
}
function IllustrationFigure({ image, focus }: { image: IllustrationImage; focus?: string }) {
  return (
    <figure>
      <a href={image.url} target="_blank" rel="noreferrer" title="삽화 크게 보기">
        <img
          src={image.url}
          alt={image.caption || focus || '장면 삽화'}
          width={image.width}
          height={image.height}
          loading="lazy"
        />
      </a>
      {(image.caption || focus) && <figcaption>{image.caption || focus}</figcaption>}
    </figure>
  );
}
function IllustrationCard({
  cut,
  hero,
  collapsed,
  onCollapse,
  refresh,
  onError,
}: Actions & {
  cut: Cut;
  hero: boolean;
  collapsed: boolean;
  onCollapse: (value: boolean, persist?: boolean) => void;
}) {
  const { job, picture, stale } = cut;
  const active = illustrationActive(job);
  const { busy, act } = useIllustrationAction({ refresh, onError });
  const element = useRef<HTMLElement>(null);
  const [ready, setReady] = useState(!!picture?.images.length);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detail, setDetail] = useState<Illustration | null>(null);
  const [detailError, setDetailError] = useState('');
  // Decide before inserting the first image. An image completed above the viewport must not
  // expand behind the reader's back. This automatic fold is transient, not a saved preference.
  useLayoutEffect(() => {
    if (ready || !picture?.images.length) return;
    const node = element.current;
    const scrollport = node?.closest<HTMLElement>('[data-reader-scrollport], .reader-scrollport');
    if (
      node &&
      scrollport &&
      node.getBoundingClientRect().bottom < scrollport.getBoundingClientRect().top
    )
      onCollapse(true, false);
    setReady(true);
  }, [ready, picture?.images.length, onCollapse]);
  useEffect(() => {
    if (!detailOpen) return;
    let current = true;
    setDetail(null);
    setDetailError('');
    void api<Illustration>(`/illustrations/${job.id}`)
      .then((value) => {
        if (current) setDetail(value);
      })
      .catch((error: Error) => {
        if (current) setDetailError(error.message);
      });
    return () => {
      current = false;
    };
  }, [detailOpen, job.id]);
  const imagesId = `illustration-images-${cut.key}`;
  const label = hero ? '대표 삽화' : '삽화';
  return (
    <article
      ref={element}
      className={`illustration illustration-cut${collapsed ? ' is-collapsed' : ''}`}
      data-testid="illustration"
      data-illustration-id={job.id}
      data-target-id={cut.key}
      data-status={job.status}
    >
      <div className="illustration-head">
        <span className="illustration-title">
          <strong>{label}</strong>
          {stale && <small>수정 전 원문의 삽화</small>}
          {collapsed && <span>{job.target?.focus || picture?.images[0]?.caption}</span>}
        </span>
        <div className="illustration-actions">
          <button
            type="button"
            className="quiet"
            aria-expanded={!collapsed}
            aria-controls={imagesId}
            onClick={() => onCollapse(!collapsed)}
          >
            {collapsed ? '펼치기' : '접기'}
          </button>
          <ActionMenu label="삽화 작업 메뉴" placement="top">
            {!stale && job.target && job.display && (
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() =>
                  void act(
                    `/sources/${job.sourceRevision}/illustration-presentation`,
                    {
                      expectedSourceHash: job.sourceHash,
                      expectedRevision: job.display!.revision,
                      heroTargetId: hero ? null : job.target!.id,
                    },
                    'PATCH'
                  )
                }
              >
                {hero ? '본문 위치로 보내기' : '대표 삽화로 지정'}
              </button>
            )}
            {!stale && job.target && (
              <button
                type="button"
                className="secondary"
                disabled={busy || active}
                onClick={() => void act(`/illustrations/${job.id}/regenerate`)}
              >
                현재 설정으로 다시 그리기
              </button>
            )}
            <button type="button" className="secondary" onClick={() => setDetailOpen(true)}>
              생성 상세
            </button>
            {!active && (
              <DeleteButton
                path={`/illustrations/${job.id}`}
                title={job.target?.focus || picture?.images[0]?.caption || '이 삽화'}
                label="삽화 삭제"
                description="이 컷의 그림과 생성 기록을 삭제해요. 본문과 다른 컷은 유지돼요."
                disabled={busy}
                onDeleted={refresh}
                onError={onError}
              />
            )}
          </ActionMenu>
        </div>
      </div>
      {(active || job.status !== 'completed') && (
        <div className="illustration-state">
          <p
            className={active ? 'illustration-progress' : 'error'}
            role={active ? 'status' : 'alert'}
          >
            {active && <RunningIcon size={16} aria-hidden="true" />}
            {active
              ? job.status === 'queued'
                ? '그릴 차례를 기다리고 있어요.'
                : job.diagnostic?.stage === 'prompt'
                  ? '이 순간의 그림 설명을 준비하고 있어요.'
                  : '이 순간을 그리고 있어요.'
              : illustrationErrorMessage(job.error)}
            {picture && ' 기존 그림은 유지돼요.'}
            {!active && job.error && <small> · {job.error}</small>}
          </p>
          <TaskButtons job={job} busy={busy} act={act} />
        </div>
      )}
      {illustrationSkipped(job) && (
        <p className="muted">삽화를 생략했어요. {job.diagnostic?.skipped}</p>
      )}
      <div id={imagesId} hidden={collapsed}>
        {picture && ready && (
          <div className="illustration-images">
            <IllustrationFigure image={picture.images[0]} focus={job.target?.focus} />
          </div>
        )}
        {picture && ready && picture.images.length > 1 && (
          <details className="illustration-variations">
            <summary>같은 순간의 다른 결과 {picture.images.length - 1}장</summary>
            <div className="illustration-images">
              {picture.images.slice(1).map((image) => (
                <IllustrationFigure key={image.id} image={image} focus={job.target?.focus} />
              ))}
            </div>
          </details>
        )}
      </div>
      <Dialog
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        title="삽화 생성 상세"
        className="source-info-dialog"
      >
        {detailError ? (
          <p className="error" role="alert">
            {detailError}
          </p>
        ) : detail ? (
          <div className="illustration-diagnostic">
            <p>
              {illustrationGeneratorLabels[detail.generator] ?? '가져온 삽화'} ·{' '}
              {detail.origin === 'automatic' ? '자동' : '직접 요청'} · {detail.attempt}번째 시도
            </p>
            {detail.preset && (
              <p>
                프리셋 · {detail.preset.title} · 개정 {detail.preset.revision}
              </p>
            )}
            {detail.diagnostic?.prompt && (
              <>
                <h4>그림 설명</h4>
                <pre>{detail.diagnostic.prompt.prompt}</pre>
                {detail.diagnostic.prompt.negativePrompt && (
                  <pre>{detail.diagnostic.prompt.negativePrompt}</pre>
                )}
              </>
            )}
            {detail.diagnostic?.revisedPrompt && <pre>{detail.diagnostic.revisedPrompt}</pre>}
            {detail.diagnostic?.comfyui && (
              <pre>{JSON.stringify(detail.diagnostic.comfyui, null, 2)}</pre>
            )}
            {!!detail.diagnostic?.retries.length && (
              <p>자동·수동 재요청 {detail.diagnostic.retries.length}회</p>
            )}
            {!detail.diagnostic && <p>저장된 추가 생성 정보가 없어요.</p>}
          </div>
        ) : (
          <p role="status">생성 정보를 불러오고 있어요.</p>
        )}
      </Dialog>
    </article>
  );
}
