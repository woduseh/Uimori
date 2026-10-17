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
          ? '일부 편집 초안을 불러오지 못했어요. 이 기기의 저장 내용은 지우지 않았어요.'
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
      setMessage('복사했어요.');
    } catch {
      setCopyError('복사하지 못했어요. 내용을 선택해 복사해 주세요.');
    }
  }
  const selected =
    artifact?.id === id && artifact.revision === selectedRevision ? artifact : undefined;
  const retry = () => setReload((value) => value + 1);
  return (
    <section className="helper-artifact" aria-label="보관된 가정 장면">
      <header>
        <strong>보관된 가정 장면</strong>
        <label>
          수정 번호
          <select
            aria-label="가정 장면 수정 번호"
            value={selectedRevision}
            onChange={(event) => setSelectedRevision(Number(event.target.value))}
          >
            {Array.from(
              { length: Math.max(latestRevision, revision) },
              (_, index) => index + 1
            ).map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        {selected && (
          <small>{selected.origin === 'edit' ? '직접 편집한 저장본' : '생성한 저장본'}</small>
        )}
      </header>
      <p className="muted">
        보관된 장면은 읽기와 복사만 할 수 있어요. 다른 전개는 채팅 메뉴에서 새 채팅으로 복사한 뒤
        본문에서 이어 써 주세요.
      </p>
      {historyError && (
        <NoticeBanner
          tone="error"
          actions={
            <button type="button" onClick={retry}>
              다시 불러오기
            </button>
          }
        >
          수정 이력을 확인하지 못했어요. {historyError}
        </NoticeBanner>
      )}
      {selected ? (
        <>
          <div className="helper-prose">
            <PlainProse text={selected.text} />
          </div>
          <details className="helper-artifact-request">
            <summary>장면 요청</summary>
            <PlainProse text={selected.request} />
            <IconButton
              label="가정 장면 요청 복사"
              icon={Copy}
              onClick={() => void copy(selected.request)}
            />
          </details>
          <footer>
            <IconButton
              label="가정 장면 복사"
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
          label="가정 장면을 불러오는 중이에요…"
          onRetry={retry}
        />
      )}
      {drafts.length > 0 && (
        <details className="helper-artifact-drafts">
          <summary>이 기기에 남은 편집 초안 {drafts.length}개</summary>
          <p>
            이전 편집 초안은 새로 저장할 수 없어요. 필요한 내용은 복사해 보관해 주세요. 초안은 이
            기기에 그대로 남겨 둬요.
          </p>
          {drafts.map((draft, index) => (
            <section key={draft.key} aria-label={`보관된 편집 초안 ${index + 1}`}>
              <h4>
                초안 {index + 1} ·{' '}
                {draft.revision === null ? '원래 저장 형식' : `수정 번호 ${draft.revision} 기준`}
              </h4>
              <div className="helper-prose">
                <PlainProse text={draft.text} />
              </div>
              <IconButton
                label="가정 장면 초안 복사"
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
              초안 다시 불러오기
            </button>
          }
        >
          {draftError}
        </NoticeBanner>
      )}
      {copyError && <NoticeBanner tone="error">{copyError}</NoticeBanner>}
      <TransientNotice message={message} />
    </section>
  );
}
