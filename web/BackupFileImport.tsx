import { useEffect, useId, useRef, useState } from 'react';
import {
  CHAT_BACKUP_VERSION,
  type ChatBackup,
  type ChatBackupImport,
} from '../core/chat-backup.js';
import type { NativeArchivePrepare } from '../core/native-archive.js';
import type {
  NativeTransferFile,
  NativeTransferPrepare,
  NativeTransferReceipt,
} from '../core/native-transfer.js';
import { api, apiBinary, definiteRejection } from './api.js';
import { inspectBackupFile } from './backup-file.js';
import { LoadingState } from './LoadingState.js';
import { NoticeBanner } from './NoticeBanner.js';

type Selection = { key: string } & (
  | {
      kind: 'resources';
      preview: NativeTransferPrepare;
      file?: NativeTransferFile;
      preparedId?: string;
    }
  | { kind: 'chat'; backup?: ChatBackup; archive?: NativeArchivePrepare }
);

export function BackupFileImport({
  onImported,
  onDirtyChange,
  disabled = false,
}: {
  onImported: () => Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
  disabled?: boolean;
}) {
  const [selection, setSelection] = useState<Selection | null>(null);
  const [database, setDatabase] = useState(false);
  const [reading, setReading] = useState(false),
    [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState(''),
    [message, setMessage] = useState('');
  const input = useRef<HTMLInputElement>(null),
    version = useRef(0),
    lock = useRef(false);
  const id = useId();
  useEffect(
    () => onDirtyChange(!!selection || reading || busy),
    [onDirtyChange, selection, reading, busy]
  );
  useEffect(
    () => () => {
      version.current++;
    },
    []
  );

  async function read(file?: File) {
    if (lock.current || uncertain) return;
    const current = ++version.current;
    setSelection(null);
    setDatabase(false);
    setError('');
    setMessage('');
    setReading(!!file);
    if (!file) return;
    lock.current = true;
    try {
      const contents = await inspectBackupFile(file);
      if (current !== version.current) return;
      if (contents.kind === 'database') {
        setDatabase(true);
        return;
      }
      const key = crypto.randomUUID();
      if (contents.archive) {
        const upload = await apiBinary<{ uploadId: string }>('/uploads', file);
        const preview = await api<NativeArchivePrepare>(
          contents.kind === 'chat'
            ? '/chats/prepare-backup-archive'
            : '/native-transfers/prepare-archive',
          { uploadId: upload.uploadId }
        );
        if (current === version.current)
          setSelection(
            contents.kind === 'chat'
              ? { kind: 'chat', archive: preview, key }
              : { kind: 'resources', preview, preparedId: preview.preparedId, key }
          );
      } else if (contents.kind === 'resources') {
        const preview = await api<NativeTransferPrepare>('/native-transfers/prepare', {
          file: contents.file,
        });
        if (current === version.current)
          setSelection({ kind: 'resources', file: contents.file, preview, key });
      } else {
        const backup = contents.backup;
        if (backup.version !== CHAT_BACKUP_VERSION)
          throw new Error(
            '이 버전의 채팅 백업은 지원하지 않아요. 파일을 만든 버전에 맞는 앱에서 확인해 주세요.'
          );
        if (!Array.isArray(backup.chats) || !backup.chats.length || !backup.resources)
          throw new Error('채팅 백업의 필수 정보가 없어요.');
        if (
          typeof backup.title !== 'string' ||
          !backup.chats.every((chat) => Array.isArray(chat?.transcript?.entries))
        )
          throw new Error(
            '채팅 백업의 제목 또는 본문 목록이 올바르지 않아요. 원본 파일을 확인해 주세요.'
          );
        setSelection({ kind: 'chat', backup, key });
      }
    } catch (caught) {
      if (current === version.current)
        setError(
          caught instanceof SyntaxError
            ? '백업 파일의 형식을 읽지 못했어요. 원본 파일을 확인해 주세요.'
            : (caught as Error).message
        );
    } finally {
      lock.current = false;
      if (current === version.current) setReading(false);
    }
  }

  async function restore() {
    if (!selection || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      if (selection.kind === 'resources') {
        const result = await api<NativeTransferReceipt>(
          selection.preparedId ? '/native-transfers/apply-archive' : '/native-transfers/apply',
          {
            ...(selection.preparedId
              ? { preparedId: selection.preparedId }
              : { file: selection.file }),
            digest: selection.preview.digest,
            idempotencyKey: selection.key,
            modelBindings: [],
          }
        );
        setMessage(`${result.items.length}개 자료를 추가했어요.`);
      } else {
        const result = await api<ChatBackupImport>(
          selection.archive ? '/chats/import-backup-archive' : '/chats/import-backup',
          {
            ...(selection.archive
              ? { preparedId: selection.archive.preparedId, digest: selection.archive.digest }
              : { backup: selection.backup }),
            idempotencyKey: selection.key,
          }
        );
        setMessage(
          `“${result.chat.title}”을 새 채팅으로 가져왔어요. 채팅 ${result.chats.length}개, 본문 ${result.sources}개를 복원했어요.`
        );
      }
      setSelection(null);
      setUncertain(false);
      if (input.current) input.current.value = '';
      await onImported().catch(() =>
        setError('가져오기는 완료했어요. 목록을 새로 읽지 못했으니 새로고침해 주세요.')
      );
    } catch (caught) {
      setUncertain(uncertain || !definiteRejection(caught));
      setError((caught as Error).message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  return (
    <section className="settings-group chat-backup-import" aria-label="백업 파일 가져오기">
      <header className="settings-group-heading archive-card-heading">
        <div>
          <h3>백업 파일 가져오기</h3>
          <p className="muted" id={`${id}-help`}>
            파일 내용을 확인한 뒤 자료 추가나 새 채팅 복원으로 안내해요. 기존 자료와 채팅은
            유지해요.
          </p>
        </div>
      </header>
      <div className="settings-group-body archive-management-card">
        <div className="archive-file-field">
          <label>
            백업 파일 선택
            <input
              ref={input}
              type="file"
              accept=".json,application/json,.uimori,.zip,application/zip,.sqlite,.sqlite3,.db"
              aria-label="백업 파일 선택"
              aria-describedby={`${id}-help`}
              disabled={disabled || busy || reading || uncertain}
              onChange={(event) => void read(event.currentTarget.files?.[0])}
            />
          </label>
        </div>
        {reading && <LoadingState presentation="inline" label="백업 파일을 읽고 있어요…" />}
        {database && (
          <NoticeBanner>
            전체 작업실 백업이에요. 서버를 종료하고 이 백업 DB를 별도 경로에 둔 뒤 UIMORI_DB에
            지정해 다시 시작해요. 복원을 확인할 때까지 기존 DB는 보관해 주세요.
          </NoticeBanner>
        )}
        {selection && (
          <div className="archive-file-summary">
            {selection.kind === 'resources' ? (
              <>
                <p>
                  자료 백업 · {selection.preview.summary.contents}개 자료 ·{' '}
                  {selection.preview.summary.prompts}개 프리셋 · {selection.preview.summary.images}
                  개 이미지
                </p>
                {!!selection.preview.modelRequirements.length && (
                  <p>가져온 조언자의 모델 지정은 주 모델 따르기로 바뀌어요.</p>
                )}
              </>
            ) : (
              <>
                <p>
                  채팅 백업 · {selection.archive?.backup?.title ?? selection.backup!.title} · 채팅{' '}
                  {selection.archive?.backup?.chats ?? selection.backup!.chats.length}개 · 본문{' '}
                  {selection.archive?.backup?.sources ??
                    selection.backup!.chats.reduce(
                      (sum, chat) => sum + chat.transcript.entries.length,
                      0
                    )}
                  개
                </p>
                <small className="muted archive-import-note">
                  전역 프롬프트·역할 모델은 현재 작업실 설정을 사용하며 실행 기록과 도우미 내부
                  작업은 가져오지 않아요.
                </small>
              </>
            )}
            <div className="archive-import-actions">
              <button type="button" disabled={disabled || busy} onClick={() => void restore()}>
                {busy
                  ? '처리 중…'
                  : uncertain
                    ? '같은 요청으로 다시 확인'
                    : selection.kind === 'resources'
                      ? '새 자료로 가져오기'
                      : '새 채팅으로 가져오기'}
              </button>
              <button
                type="button"
                className="secondary"
                disabled={busy || uncertain}
                onClick={() => {
                  setSelection(null);
                  if (input.current) input.current.value = '';
                }}
              >
                선택 취소
              </button>
            </div>
          </div>
        )}
        {busy && <LoadingState presentation="inline" label="백업을 가져오는 중이에요…" />}
        {uncertain && (
          <NoticeBanner>
            서버의 완료 여부를 확인하지 못했어요. 선택한 파일과 요청을 유지했어요. 같은 요청으로
            다시 확인해 주세요.
          </NoticeBanner>
        )}
        {message && <NoticeBanner>{message}</NoticeBanner>}
        {error && <NoticeBanner tone="error">{error}</NoticeBanner>}
      </div>
    </section>
  );
}
