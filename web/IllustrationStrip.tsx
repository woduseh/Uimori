import { t, useI18n, translateMessage } from './i18n.js';
import { LoadingState } from './LoadingState.js';
import { readingScrollport } from './theme-body-scroll.js';
import { cutsFor, type Cut } from './illustration-progress.js';
import { IllustrationUsageLine, IllustrationPlacementButton } from './IllustrationActivity.js';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Illustration, IllustrationImage, IllustrationDetail } from '../core/illustration.js';
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
import './activity-status.css';

type Actions = { refresh: () => Promise<void>; onError: (message: string) => void };
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
  inlineAnchors,
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
  inlineAnchors?: string[];
  defaultCollapsed?: boolean;
}) {
  const [choices, setChoices] = useState<Record<string, boolean>>({});
  const items = illustrations.filter((item) => item.sourceRevision === sourceId);
  useI18n();
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
    return anchor && anchors.includes(anchor) && (!inlineAnchors || inlineAnchors.includes(anchor))
      ? anchor
      : null;
  };
  const placementActive = items.some(
    (item) =>
      item.sourceHash === sourceHash && item.task === 'placement' && illustrationActive(item)
  );
  const needsMapping = (cut: Cut) =>
    mode === 'translation' &&
    !cut.stale &&
    !!cut.job.target &&
    cut !== hero &&
    (cut.job.display?.translation?.textHash !== translationHash ||
      !cut.job.display?.translation?.afterAnchor);
  const placementNote = (cut: Cut) => {
    if (cut === hero || after(cut)) return undefined;
    if (cut.stale) return t('visuals.m092');
    if (!cut.job.target) return t('visuals.m093');
    if (needsMapping(cut)) return placementActive ? t('visuals.m094') : t('visuals.m095');
    return t('visuals.m096');
  };
  const renderCut = (cut: Cut) => (
    <IllustrationCard
      key={cut.key}
      cut={cut}
      placementNote={placementNote(cut)}
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
      item.task !== 'render' &&
      (item.status !== 'completed' || illustrationSkipped(item)) &&
      (item.task !== 'placement' || item === lastPlacement)
  );
  const allCollapsed = cuts.length > 0 && cuts.every((cut) => collapsed(cut.key));
  return {
    header: items.length ? (
      <>
        {cuts.length > 0 && (
          <div className="illustration-toolbar" aria-label={t('visuals.m097')}>
            <span>{t('visuals.cutCount', { count: cuts.length })}</span>
            {cuts.length > 1 && (
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
                {allCollapsed ? t('visuals.m100') : t('visuals.m101')}
              </button>
            )}
          </div>
        )}
        {tasks.map((job) => (
          <IllustrationTask key={job.id} job={job} refresh={refresh} onError={onError} />
        ))}
        {hero && (
          <section
            className="illustrations illustration-hero"
            data-testid="illustrations"
            data-placement="hero"
            aria-label={t('visuals.m102')}
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
          aria-label={t('visuals.m103')}
        >
          {matches.map(renderCut)}
        </section>
      ) : null;
    },
    footer: fallback.length ? (
      <details className="illustration-supplement" data-testid="illustration-supplement">
        <summary>
          {t('visuals.fallbackCount', {
            count: fallback.length,
            attention: fallback.some((cut) => ['failed', 'interrupted'].includes(cut.job.status)),
          })}
        </summary>
        {fallback.some(needsMapping) && (
          <IllustrationPlacementButton
            sourceId={sourceId}
            sourceHash={sourceHash}
            pending={placementActive}
            refresh={refresh}
            onError={onError}
          />
        )}
        <section
          className="illustrations"
          data-testid="illustrations"
          data-placement="supplement"
          aria-label={t('visuals.m104')}
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
  useI18n();
  return (
    <div className="illustration-actions">
      {illustrationActive(job) && (
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={() => void act(`/illustrations/${job.id}/cancel`)}
        >
          <CloseIcon size={16} aria-hidden="true" />
          {t('visuals.m107')}
        </button>
      )}
      {illustrationReconcilable(job) && (
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={() => void act(`/illustrations/${job.id}/reconcile`)}
          title={t('visuals.m108')}
        >
          {t('visuals.m109')}
        </button>
      )}
      {job.error === 'ILLUSTRATION_CODEX_CONTENT_BLOCKED' && job.target && (
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={() => void act(`/illustrations/${job.id}/regenerate`)}
        >
          {t('visuals.m110')}
        </button>
      )}
      {illustrationRetryable(job) && (
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={() => void act(`/illustrations/${job.id}/retry`)}
          title={t('visuals.m111')}
        >
          <RefreshIcon size={16} aria-hidden="true" />
          {t('visuals.m112')}
        </button>
      )}
    </div>
  );
}
function IllustrationTask({ job, refresh, onError }: Actions & { job: Illustration }) {
  useI18n();
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
        {active && <RunningIcon size={16} aria-hidden="true" className="activity-spinner" />}
        {illustrationSkipped(job)
          ? t('visuals.m113', { v0: job.diagnostic?.skipped ?? '' })
          : active
            ? job.status === 'queued'
              ? job.task === 'placement'
                ? t('visuals.m114')
                : t('visuals.m115')
              : job.task === 'placement'
                ? t('visuals.m116')
                : t('visuals.m117')
            : illustrationErrorMessage(job.error)}
      </p>
      <TaskButtons job={job} busy={busy} act={act} />
      {!active && (
        <DeleteButton
          path={`/illustrations/${job.id}`}
          title={t('visuals.m118')}
          label={t('visuals.m119')}
          description={t('visuals.m120')}
          iconOnly
          onDeleted={refresh}
          onError={onError}
        />
      )}
    </div>
  );
}
function IllustrationFigure({ image, focus }: { image: IllustrationImage; focus?: string }) {
  useI18n();
  const [expanded, setExpanded] = useState(false);
  const caption = image.caption || focus;
  return (
    <>
      <figure>
        <button
          type="button"
          className="illustration-preview-trigger"
          title={t('visuals.m121')}
          aria-label={t('visuals.m121')}
          onClick={() => setExpanded(true)}
        >
          <img
            src={image.url}
            alt={caption || t('visuals.m122')}
            width={image.width}
            height={image.height}
            loading="lazy"
          />
        </button>
        {caption && <figcaption>{caption}</figcaption>}
      </figure>
      <Dialog
        open={expanded}
        onClose={() => setExpanded(false)}
        title={t('visuals.m121')}
        className="illustration-lightbox"
        wide
      >
        <figure>
          <img
            src={image.url}
            alt={caption || t('visuals.m122')}
            width={image.width}
            height={image.height}
          />
          {caption && <figcaption>{caption}</figcaption>}
        </figure>
      </Dialog>
    </>
  );
}
function IllustrationCard({
  cut,
  placementNote,
  hero,
  collapsed,
  onCollapse,
  refresh,
  onError,
}: Actions & {
  cut: Cut;
  placementNote?: string;
  hero: boolean;
  collapsed: boolean;
  onCollapse: (value: boolean, persist?: boolean) => void;
}) {
  useI18n();
  const { job, picture, stale } = cut;
  const active = illustrationActive(job);
  const { busy, act } = useIllustrationAction({ refresh, onError });
  const element = useRef<HTMLElement>(null);
  const [ready, setReady] = useState(!!picture?.images.length);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detail, setDetail] = useState<IllustrationDetail | null>(null);
  const [detailError, setDetailError] = useState('');
  // Decide before inserting the first image. An image completed above the viewport must not
  // expand behind the reader's back. This automatic fold is transient, not a saved preference.
  useLayoutEffect(() => {
    if (ready || !picture?.images.length) return;
    const node = element.current;
    const scrollport = readingScrollport(node);
    if (
      node &&
      scrollport &&
      node.getBoundingClientRect().bottom < scrollport.getBoundingClientRect().top
    )
      onCollapse(true, false);
    setReady(true);
  }, [ready, picture?.images.length, onCollapse]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Refresh usage when this same job progresses or settles.
  useEffect(() => {
    if (!detailOpen) return;
    let current = true;
    setDetail(null);
    setDetailError('');
    void api<IllustrationDetail>(`/illustrations/${job.id}`)
      .then((value) => {
        if (current) setDetail(value);
      })
      .catch((error: Error) => {
        if (current) setDetailError(error.message);
      });
    return () => {
      current = false;
    };
  }, [detailOpen, job.id, job.status, job.updatedAt]);
  const imagesId = `illustration-images-${cut.key}`;
  const label = hero ? t('visuals.m102') : t('visuals.m098');
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
          {stale && <small>{t('visuals.m123')}</small>}
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
            {collapsed ? t('visuals.m124') : t('visuals.m125')}
          </button>
          <ActionMenu label={t('visuals.m126')} placement="top">
            {!stale && job.target && (
              <div className="action-menu-group">
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
                    {hero ? t('visuals.m127') : t('visuals.m128')}
                  </button>
                )}
                {!stale && job.target && (
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy || active}
                    onClick={() => void act(`/illustrations/${job.id}/regenerate`)}
                  >
                    {t('visuals.m129')}
                  </button>
                )}
              </div>
            )}
            <div className="action-menu-group">
              <button type="button" className="secondary" onClick={() => setDetailOpen(true)}>
                {t('visuals.m130')}
              </button>
            </div>
            {!active && (
              <div className="action-menu-group">
                <DeleteButton
                  path={`/illustrations/${job.id}`}
                  title={job.target?.focus || picture?.images[0]?.caption || t('visuals.m131')}
                  label={t('visuals.m132')}
                  description={t('visuals.m133')}
                  disabled={busy}
                  onDeleted={refresh}
                  onError={onError}
                />
              </div>
            )}
          </ActionMenu>
        </div>
      </div>
      {placementNote && <p className="illustration-placement-note">{placementNote}</p>}
      {(active || job.status !== 'completed') && (
        <div className="illustration-state">
          <p
            className={active ? 'illustration-progress' : 'error'}
            role={active ? 'status' : 'alert'}
          >
            {active && <RunningIcon size={16} aria-hidden="true" className="activity-spinner" />}
            {t('visuals.renderStatus', {
              preserved: !!picture,
              message: active
                ? job.status === 'queued'
                  ? t('visuals.m134')
                  : job.diagnostic?.stage === 'content-check'
                    ? t('visuals.m135')
                    : job.diagnostic?.stage === 'prompt'
                      ? t('visuals.m136')
                      : job.diagnostic?.stage === 'store'
                        ? t('visuals.m137')
                        : job.diagnostic?.stage === 'reconcile'
                          ? t('visuals.m138')
                          : t('visuals.m139')
                : illustrationErrorMessage(job.error),
            })}
            {!active && job.error && <small> {job.error}</small>}
          </p>
          <TaskButtons job={job} busy={busy} act={act} />
        </div>
      )}
      {illustrationSkipped(job) && (
        <p className="muted">{t('visuals.m113', { v0: job.diagnostic?.skipped ?? '' })}</p>
      )}
      <div id={imagesId} hidden={collapsed}>
        {picture && ready && (
          <div className="illustration-images">
            <IllustrationFigure image={picture.images[0]} focus={job.target?.focus} />
          </div>
        )}
        {picture && ready && picture.images.length > 1 && (
          <details className="illustration-variations">
            <summary>{t('visuals.variations', { count: picture.images.length - 1 })}</summary>
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
        title={t('visuals.m144')}
        className="source-info-dialog"
      >
        {detailError ? (
          <LoadingState
            presentation="inline"
            loading={false}
            error={translateMessage(detailError)}
          />
        ) : detail ? (
          <div className="illustration-diagnostic">
            <p>
              {t('visuals.generationAttempt', {
                generator: illustrationGeneratorLabels[detail.generator] ?? t('visuals.m145'),
                origin: detail.origin,
                attempt: detail.attempt,
              })}
            </p>
            {detail.modelTitle && (
              <p className="ui-meta-row">
                <span>
                  {detail.generator === 'comfyui' ? t('visuals.m077') : t('visuals.m149')}
                </span>
                <span>{detail.modelTitle}</span>
              </p>
            )}
            {detail.usage && (
              <>
                <IllustrationUsageLine usage={detail.usage} />
                <small>{t('visuals.m150')}</small>
              </>
            )}
            {detail.preset && (
              <p>
                {t('visuals.presetRevision', {
                  title: detail.preset.title,
                  revision: detail.preset.revision,
                })}
              </p>
            )}
            {detail.diagnostic?.contentCheck && (
              <p>
                {t('visuals.precheck', {
                  status:
                    detail.diagnostic.contentCheck.status === 'blocked'
                      ? t('visuals.m154')
                      : detail.diagnostic.contentCheck.status === 'allowed'
                        ? t('visuals.m155')
                        : t('visuals.m156'),
                  code: detail.diagnostic.contentCheck.code
                    ? ` (${detail.diagnostic.contentCheck.code})`
                    : '',
                })}
              </p>
            )}
            {detail.diagnostic?.codex?.unavailableReason && (
              <p>
                {t('visuals.codexResponse', { reason: detail.diagnostic.codex.unavailableReason })}
              </p>
            )}
            {detail.diagnostic?.prompt && (
              <>
                <h4>{t('visuals.m158')}</h4>
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
              <p>{t('visuals.retries', { count: detail.diagnostic.retries.length })}</p>
            )}
            {!detail.diagnostic && <p>{t('visuals.m161')}</p>}
          </div>
        ) : (
          <LoadingState presentation="inline" label={t('visuals.m162')} />
        )}
      </Dialog>
    </article>
  );
}
