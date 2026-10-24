import { useEffect, useRef, useState } from 'react';
import type { OrphanMemoryDetail, OrphanMemoryEntry } from '../core/orphan-memory.js';
import { api, ApiError } from './api.js';
import { t, message, translateMessage, useI18n } from './i18n.js';
import { LoadingState } from './LoadingState.js';
import { NoticeBanner } from './NoticeBanner.js';
import { TransientNotice } from './TransientNotice.js';
import './orphan-memory.css';

const entryId = (entry: OrphanMemoryEntry) =>
  entry.kind === 'note' ? entry.note.id : entry.override.id;
const entryText = (entry: OrphanMemoryEntry) =>
  entry.kind === 'note' ? entry.note.text : entry.override.value;
type Review = {
  entry: OrphanMemoryEntry;
  action: 'reanchor' | 'retire';
  base: OrphanMemoryDetail;
  key: string;
};

export function OrphanMemoryPanel({
  chatId,
  headRevision,
  active,
  refreshKey,
  disabled,
  onRefreshStory,
  onChanged,
  onAskHelper,
}: {
  chatId: string;
  headRevision: string | null;
  active: boolean;
  refreshKey?: unknown;
  disabled?: boolean;
  onRefreshStory: () => Promise<void>;
  onChanged: () => void;
  onAskHelper?: (request: string) => void;
}) {
  useI18n();
  const [detail, setDetail] = useState<OrphanMemoryDetail | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const alive = useRef(true);
  const sequence = useRef(0);
  const lock = useRef(false);
  const scope = useRef({ key: '', generation: 0 });
  const scopeKey = JSON.stringify([chatId, headRevision]);
  if (scope.current.key !== scopeKey)
    scope.current = { key: scopeKey, generation: scope.current.generation + 1 };
  const base = `/chats/${encodeURIComponent(chatId)}/orphan-memory`;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  async function load() {
    const generation = scope.current.generation;
    const read = ++sequence.current;
    setLoading(true);
    try {
      const result = await api<OrphanMemoryDetail>(base);
      if (!alive.current || generation !== scope.current.generation || read !== sequence.current)
        return;
      setDetail(result);
      setError('');
    } catch (caught) {
      if (alive.current && generation === scope.current.generation && read === sequence.current)
        setError(caught instanceof Error ? caught.message : message('orphanmemory.failed'));
    } finally {
      if (alive.current && generation === scope.current.generation && read === sequence.current)
        setLoading(false);
    }
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: Event refreshes preserve the explicit review snapshot for CAS rather than silently rebasing it.
  useEffect(() => {
    if (active) void load();
  }, [active, chatId, headRevision, refreshKey]);
  async function apply() {
    if (!review || lock.current || disabled) return;
    const generation = scope.current.generation;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      await api(base, {
        kind: review.entry.kind,
        entryId: entryId(review.entry),
        action: review.action,
        expectedRevision: review.base.revision,
        expectedLoreRevision: review.base.loreRevision,
        expectedHeadRevision: review.base.headRevision,
        expectedHeadHash: review.base.headHash,
        idempotencyKey: review.key,
      });
      if (!alive.current || generation !== scope.current.generation) return;
      setReview(null);
      setNotice(
        message(review.action === 'retire' ? 'orphanmemory.retired' : 'orphanmemory.reanchored')
      );
      await Promise.all([load(), onRefreshStory()]);
      onChanged();
    } catch (caught) {
      if (!alive.current || generation !== scope.current.generation) return;
      setError(caught instanceof Error ? caught.message : message('orphanmemory.failed'));
      if (caught instanceof ApiError && caught.status === 409) {
        setReview(null);
        await load();
        setError(message('orphanmemory.conflict'));
      }
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  }
  const current = detail?.headRevision === headRevision;
  return (
    <section
      className="orphan-memory"
      aria-label={t('orphanmemory.title')}
      data-testid="orphan-memory"
    >
      <div className="context-heading">
        <h4>{t('orphanmemory.title')}</h4>
        <button
          type="button"
          className="secondary"
          disabled={busy || loading}
          onClick={() => void load()}
        >
          {t('orphanmemory.refresh')}
        </button>
      </div>
      <TransientNotice message={notice} />
      {!detail || !current ? (
        <LoadingState
          presentation="placeholder"
          loading={loading}
          error={translateMessage(error)}
          label={t('orphanmemory.loading')}
          onRetry={() => void load()}
        />
      ) : (
        <>
          {error && <NoticeBanner tone="error">{translateMessage(error)}</NoticeBanner>}
          {loading && <LoadingState presentation="inline" label={t('orphanmemory.loading')} />}
          {!detail.entries.length ? (
            <p className="muted">{t('orphanmemory.empty')}</p>
          ) : (
            <>
              <p className="muted">{t('orphanmemory.hint')}</p>
              <ul className="story-records">
                {detail.entries.map((entry) => {
                  const key = entryId(entry);
                  const selected =
                    review?.entry.kind === entry.kind && entryId(review.entry) === key;
                  return (
                    <li key={`${entry.kind}:${key}`}>
                      <strong>
                        {entry.kind === 'note'
                          ? t(
                              entry.note.kind === 'imported-memory'
                                ? 'orphanmemory.imported'
                                : 'orphanmemory.note'
                            )
                          : t('orphanmemory.lore', {
                              title: entry.override.baseEntry.title,
                              field: t(`orphanmemory.field.${entry.override.selector.field}`),
                            })}
                      </strong>
                      <p className="orphan-memory-text">{entryText(entry)}</p>
                      <p className="muted">{t(`orphanmemory.${entry.reason}`)}</p>
                      <details className="orphan-memory-provenance">
                        <summary>{t('orphanmemory.provenance')}</summary>
                        <small>
                          {t('orphanmemory.anchor', {
                            source:
                              entry.kind === 'note'
                                ? (entry.note.atRevision ?? '')
                                : (entry.override.atSource ?? ''),
                          })}
                        </small>
                        {entry.kind === 'note' && (
                          <small>
                            {t('orphanmemory.author', {
                              author: entry.note.declaration.author,
                              origin: entry.note.origin?.title ?? '',
                            })}
                          </small>
                        )}
                      </details>
                      {selected ? (
                        <div className="orphan-memory-review">
                          <p>
                            {t(
                              review.action === 'retire'
                                ? 'orphanmemory.retireConfirm'
                                : review.base.headRevision
                                  ? 'orphanmemory.reanchorConfirm'
                                  : 'orphanmemory.reanchorChatConfirm'
                            )}
                          </p>
                          {review.action === 'reanchor' && entry.kind === 'lore' && (
                            <p className="muted">{t('orphanmemory.loreConflict')}</p>
                          )}
                          <div className="form-actions">
                            <button
                              type="button"
                              className="primary"
                              disabled={busy || disabled}
                              onClick={() => void apply()}
                            >
                              {busy
                                ? t('orphanmemory.applying')
                                : t(
                                    review.action === 'retire'
                                      ? 'orphanmemory.retire'
                                      : 'orphanmemory.reanchor'
                                  )}
                            </button>
                            <button
                              type="button"
                              className="secondary"
                              disabled={busy}
                              onClick={() => setReview(null)}
                            >
                              {t('orphanmemory.cancel')}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="form-actions">
                          <button
                            type="button"
                            className="secondary"
                            disabled={busy || disabled || review !== null}
                            onClick={() =>
                              setReview({
                                entry,
                                action: 'reanchor',
                                base: detail,
                                key: crypto.randomUUID(),
                              })
                            }
                          >
                            {t('orphanmemory.reanchor')}
                          </button>
                          <button
                            type="button"
                            className="secondary"
                            disabled={busy || disabled || review !== null}
                            onClick={() =>
                              setReview({
                                entry,
                                action: 'retire',
                                base: detail,
                                key: crypto.randomUUID(),
                              })
                            }
                          >
                            {t('orphanmemory.retire')}
                          </button>
                          {onAskHelper && (
                            <button
                              type="button"
                              className="secondary"
                              disabled={busy || disabled || review !== null}
                              onClick={() =>
                                onAskHelper(
                                  t('orphanmemory.helperRequest', {
                                    id: key,
                                    kind: entry.kind,
                                    source:
                                      entry.kind === 'note'
                                        ? (entry.note.atRevision ?? '')
                                        : (entry.override.atSource ?? ''),
                                    reason: t(`orphanmemory.${entry.reason}`),
                                    text: entryText(entry).slice(0, 6000),
                                  })
                                )
                              }
                            >
                              {t('orphanmemory.askHelper')}
                            </button>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  );
}
