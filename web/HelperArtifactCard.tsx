import { t, useI18n, formatNumber } from './i18n.js';
import { uiMessage, type UiMessage } from './ui-message.js';
import { toUiMessage } from './api-errors.js';
import { LoadingState } from './LoadingState.js';
import { TransientNotice } from './TransientNotice.js';
import { NoticeBanner } from './NoticeBanner.js';
import { useState } from 'react';
import { Copy } from 'lucide-react';
import type { HelperArtifact } from '../core/helper.js';
import { api } from './api.js';
import { IconButton } from './IconButton.js';
import { PlainProse } from './Prose.js';
import { loadHelperRecovery } from './helper-recovery.js';
import { tryParseJson } from './json.js';
import { useRetryableEffect } from './useRetryableEffect.js';

export type HelperArtifactView = HelperArtifact;
type Draft = { key: string; revision: number; text: string };

function storedDraft(key: string, raw: string): Draft | null {
  const value = tryParseJson(raw, null) as { revision?: unknown; text?: unknown } | null;
  if (
    value &&
    Number.isSafeInteger(value.revision) &&
    Number(value.revision) > 0 &&
    typeof value.text === 'string'
  )
    return { key, revision: Number(value.revision), text: value.text };
  return null;
}

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
  const [readError, setReadError] = useState<UiMessage | null>(null);
  const [historyError, setHistoryError] = useState<UiMessage | null>(null);
  const [draftError, setDraftError] = useState<UiMessage | null>(null);
  const [copyError, setCopyError] = useState<UiMessage | null>(null);
  const [notice, setNotice] = useState<UiMessage | null>(null);
  const path = `/helper/artifacts/${encodeURIComponent(id)}`;

  const retryLatestRevision = useRetryableEffect(() => {
    let current = true;
    setHistoryError(null);
    void api<HelperArtifactView>(path)
      .then((value) => {
        if (current) setLatestRevision(value.revision);
      })
      .catch((cause) => {
        if (current) setHistoryError(toUiMessage(cause));
      });
    return () => {
      current = false;
    };
  }, [path]);

  const retryArtifact = useRetryableEffect(() => {
    let current = true;
    setArtifact(undefined);
    setReadError(null);
    void api<HelperArtifactView>(`${path}?revision=${selectedRevision}`)
      .then((value) => {
        if (current) setArtifact(value);
      })
      .catch((cause) => {
        if (current) setReadError(toUiMessage(cause));
      });
    return () => {
      current = false;
    };
  }, [path, selectedRevision]);

  const retryDrafts = useRetryableEffect(() => {
    let current = true;
    const prefix = `helper-artifact-draft:${id}:`;
    async function readDrafts() {
      const keys = new Set([`${prefix}${revision}`]);
      let failed = false;
      try {
        const index = tryParseJson(
          (await loadHelperRecovery(`helper-artifacts:${conversationId}`)) ?? '[]',
          null
        );
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
          : null
      );
    }
    void readDrafts();
    return () => {
      current = false;
    };
  }, [id, revision, conversationId]);

  async function copy(text: string) {
    setCopyError(null);
    setNotice(null);
    try {
      await navigator.clipboard.writeText(text);
      setNotice(uiMessage('helpers.m129'));
    } catch {
      setCopyError(uiMessage('helpers.m130'));
    }
  }
  const selected =
    artifact?.id === id && artifact.revision === selectedRevision ? artifact : undefined;
  const retry = () => {
    retryLatestRevision();
    retryArtifact();
    retryDrafts();
  };
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
          {uiMessage('helpers.m319', { error: historyError })}
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
          error={readError}
          label={uiMessage('helpers.m142')}
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
                  revision: t('helpers.m149', { v0: formatNumber(draft.revision) }),
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
          {draftError}
        </NoticeBanner>
      )}
      {copyError && <NoticeBanner tone="error">{copyError}</NoticeBanner>}
      <TransientNotice content={notice} />
    </section>
  );
}
