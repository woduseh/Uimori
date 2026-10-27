import { t, useI18n, translateMessage, formatNumber, message as uiMessage } from './i18n.js';
import { LoadingState } from './LoadingState.js';
import { TransientNotice } from './TransientNotice.js';
import { NoticeBanner } from './NoticeBanner.js';
import { useEffect, useState } from 'react';
import { Copy } from 'lucide-react';
import type { HelperArtifact } from '../core/helper.js';
import { api } from './api.js';
import { IconButton } from './IconButton.js';
import { PlainProse } from './Prose.js';
import { loadHelperRecovery } from './helper-recovery.js';

export type HelperArtifactView = HelperArtifact;
type Draft = { key: string; revision: number | null; text: string };

function storedDraft(key: string, raw: string): Draft {
  try {
    const value = JSON.parse(raw) as { revision?: unknown; text?: unknown } | null;
    if (
      value &&
      Number.isSafeInteger(value.revision) &&
      Number(value.revision) > 0 &&
      typeof value.text === 'string'
    )
      return { key, revision: Number(value.revision), text: value.text };
  } catch {
    // An unrecognized legacy buffer remains readable and copyable without rewriting it.
  }
  return { key, revision: null, text: raw };
}

/** Retired artifacts keep their exact message reference, saved revisions and device drafts readable. */
export function HelperArtifactCard({
  id,
  revision,
  conversationId,
}: {
  id: string;
  revision: number;
  conversationId: string;
}) {
  useI18n();
  const [selectedRevision, setSelectedRevision] = useState(revision);
  const [latestRevision, setLatestRevision] = useState(revision);
  const [artifact, setArtifact] = useState<HelperArtifactView>();
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [readError, setReadError] = useState('');
  const [historyError, setHistoryError] = useState('');
  const [draftError, setDraftError] = useState('');
  const [copyError, setCopyError] = useState('');
  const [message, setMessage] = useState('');
  const [reload, setReload] = useState(0);
  const path = `/helper/artifacts/${encodeURIComponent(id)}`;

  // biome-ignore lint/correctness/useExhaustiveDependencies: reload is an explicit retry of this read.
  useEffect(() => {
    let current = true;
    setHistoryError('');
    void api<HelperArtifactView>(path)
      .then((value) => {
        if (current) setLatestRevision(value.revision);
      })
      .catch((cause) => {
        if (current) setHistoryError(cause.message);
      });
    return () => {
      current = false;
    };
  }, [path, reload]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reload is an explicit retry of this read.
  useEffect(() => {
    let current = true;
    setArtifact(undefined);
    setReadError('');
    void api<HelperArtifactView>(`${path}?revision=${selectedRevision}`)
      .then((value) => {
        if (current) setArtifact(value);
      })
      .catch((cause) => {
        if (current) setReadError(cause.message);
      });
    return () => {
      current = false;
    };
  }, [path, selectedRevision, reload]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reload is an explicit retry of this read.
  useEffect(() => {
    let current = true;
    const prefix = `helper-artifact-draft:${id}:`;
    async function readDrafts() {
      const keys = new Set([`${prefix}${revision}`]);
      let failed = false;
      try {
        const index = JSON.parse(
          (await loadHelperRecovery(`helper-artifacts:${conversationId}`)) ?? '[]'
        ) as unknown;
        if (!Array.isArray(index)) throw new Error('Invalid draft index');
        for (const key of index)
          if (typeof key === 'string' && key.startsWith(prefix)) keys.add(key);
      } catch {
        failed = true;
      }
      const stored = await Promise.allSettled(
        [...keys].sort().map(async (key) => {
          const raw = await loadHelperRecovery(key);
          return raw === null ? null : storedDraft(key, raw);
        })
      );
      if (!current) return;
      setDrafts(
        stored.flatMap((result) =>
          result.status === 'fulfilled' && result.value ? [result.value] : []
        )
      );
      setDraftError(
        failed || stored.some((result) => result.status === 'rejected')
          ? uiMessage('helpers.m128')
          : ''
      );
    }
    void readDrafts();
    return () => {
      current = false;
    };
  }, [id, revision, conversationId, reload]);

  async function copy(text: string) {
    setCopyError('');
    setMessage('');
    try {
      await navigator.clipboard.writeText(text);
      setMessage(uiMessage('helpers.m129'));
    } catch {
      setCopyError(uiMessage('helpers.m130'));
    }
  }
  const selected =
    artifact?.id === id && artifact.revision === selectedRevision ? artifact : undefined;
  const retry = () => setReload((value) => value + 1);
  return (
    <section className="helper-artifact" aria-label={t('helpers.m131')}>
      <header>
        <strong>{t('helpers.m131')}</strong>
        <label>
          {t('helpers.m132')}
          <select
            aria-label={t('helpers.m133')}
            value={selectedRevision}
            onChange={(event) => setSelectedRevision(Number(event.target.value))}
          >
            {Array.from(
              { length: Math.max(latestRevision, revision) },
              (_, index) => index + 1
            ).map((value) => (
              <option key={value} value={value}>
                {formatNumber(value)}
              </option>
            ))}
          </select>
        </label>
        {selected && (
          <small>{selected.origin === 'edit' ? t('helpers.m134') : t('helpers.m135')}</small>
        )}
      </header>
      {historyError && (
        <NoticeBanner
          tone="error"
          actions={
            <button type="button" onClick={retry}>
              {t('helpers.m137')}
            </button>
          }
        >
          {t('helpers.m319', { error: translateMessage(historyError) })}
        </NoticeBanner>
      )}
      {selected ? (
        <>
          <div className="helper-prose">
            <PlainProse text={selected.text} />
          </div>
          <details className="helper-artifact-request">
            <summary>{t('helpers.m139')}</summary>
            <div className="helper-artifact-literal">{selected.request}</div>
            <IconButton
              label={t('helpers.m140')}
              icon={Copy}
              onClick={() => void copy(selected.request)}
            />
          </details>
          <footer>
            <IconButton
              label={t('helpers.m141')}
              icon={Copy}
              onClick={() => void copy(selected.text)}
            />
          </footer>
        </>
      ) : (
        <LoadingState
          presentation="placeholder"
          loading={!readError}
          error={translateMessage(readError)}
          label={t('helpers.m142')}
          onRetry={retry}
        />
      )}
      {drafts.length > 0 && (
        <details className="helper-artifact-drafts">
          <summary>{t('helpers.m320', { count: formatNumber(drafts.length) })}</summary>
          {drafts.map((draft, index) => (
            <section key={draft.key} aria-label={t('helpers.m146', { v0: index + 1 })}>
              <h4>
                {t('helpers.m321', {
                  index: formatNumber(index + 1),
                  revision:
                    draft.revision === null
                      ? t('helpers.m148')
                      : t('helpers.m149', { v0: formatNumber(draft.revision) }),
                })}
              </h4>
              <div className="helper-artifact-literal">{draft.text}</div>
              <IconButton
                label={t('helpers.m150')}
                icon={Copy}
                onClick={() => void copy(draft.text)}
              />
            </section>
          ))}
        </details>
      )}
      {draftError && (
        <NoticeBanner
          tone="error"
          actions={
            <button type="button" onClick={retry}>
              {t('helpers.m102')}
            </button>
          }
        >
          {translateMessage(draftError)}
        </NoticeBanner>
      )}
      {copyError && <NoticeBanner tone="error">{translateMessage(copyError)}</NoticeBanner>}
      <TransientNotice message={message} />
    </section>
  );
}
