import { LoadingState } from './LoadingState.js';
import { useEffect, useId, useRef, useState } from 'react';
import {
  CHAT_BACKUP_FORMAT,
  CHAT_BACKUP_MAX_BYTES,
  CHAT_BACKUP_VERSION,
  type ChatBackup,
  type ChatBackupImport as ImportResult,
} from '../core/chat-backup.js';
import { api, apiBinary, ApiError } from './api.js';
import { NATIVE_ARCHIVE_MAX_BYTES, type NativeArchivePrepare } from '../core/native-archive.js';

export function ChatBackupImport({
  onImported,
  onDirtyChange,
  onBusyChange,
  disabled = false,
}: {
  onImported: () => Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange?: (busy: boolean) => void;
  disabled?: boolean;
}) {
  const [selection, setSelection] = useState<{
    backup?: ChatBackup;
    archive?: NativeArchivePrepare;
    requestKey: string;
  } | null>(null);
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const input = useRef<HTMLInputElement>(null),
    version = useRef(0),
    lock = useRef(false);
  const id = useId();
  useEffect(
    () => onBusyChange?.(reading || busy || uncertain),
    [onBusyChange, reading, busy, uncertain]
  );
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
    const current = ++version.current;
    setSelection(null);
    setError('');
    setMessage('');
    setReading(!!file);
    if (!file) return;
    try {
      const archive = /\.(?:uimori|zip)$/iu.test(file.name);
      if (file.size > (archive ? NATIVE_ARCHIVE_MAX_BYTES : CHAT_BACKUP_MAX_BYTES))
        throw new Error(
          archive
            ? '채팅 백업은 512MiB까지 가져올 수 있어요.'
            : 'JSON 채팅 백업은 256MiB까지 가져올 수 있어요.'
        );
      if (archive) {
        const upload = await apiBinary<{ uploadId: string }>('/uploads', file);
        const preview = await api<NativeArchivePrepare>('/chats/prepare-backup-archive', {
          uploadId: upload.uploadId,
        });
        if (current === version.current)
          setSelection({ archive: preview, requestKey: crypto.randomUUID() });
        return;
      }
      const backup = JSON.parse(await file.text()) as ChatBackup;
      if (current !== version.current) return;
      if (backup?.format !== CHAT_BACKUP_FORMAT)
        throw new Error(
          '채팅 백업 파일을 선택해 주세요. 본문 JSON과 작업공간 백업은 아래의 해당 가져오기를 이용해 주세요.'
        );
      if (backup.version !== CHAT_BACKUP_VERSION)
        throw new Error(
          '이 버전의 채팅 백업은 지원하지 않아요. 파일을 만든 버전에 맞는 앱에서 확인해 주세요.'
        );
      if (!Array.isArray(backup.chats) || !backup.chats.length || !backup.resources)
        throw new Error('채팅 백업의 필수 정보가 없어요.');
      // Validate only what the preview reads; restoration still validates the full backup.
      if (
        typeof backup.title !== 'string' ||
        !backup.chats.every((chat) => Array.isArray(chat?.transcript?.entries))
      )
        throw new Error(
          '채팅 백업의 제목 또는 본문 목록이 올바르지 않아요. 원본 파일을 확인해 주세요.'
        );
      setSelection({ backup, requestKey: crypto.randomUUID() });
    } catch (caught) {
      if (current === version.current)
        setError(
          caught instanceof SyntaxError
            ? 'JSON 파일을 읽지 못했어요. 원본 백업 파일을 확인해 주세요.'
            : (caught as Error).message
        );
    } finally {
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
      const result = await api<ImportResult>(
        selection.archive ? '/chats/import-backup-archive' : '/chats/import-backup',
        {
          ...(selection.archive
            ? { preparedId: selection.archive.preparedId, digest: selection.archive.digest }
            : { backup: selection.backup }),
          idempotencyKey: selection.requestKey,
        }
      );
      setSelection(null);
      setUncertain(false);
      if (input.current) input.current.value = '';
      setMessage(
        `“${result.chat.title}”을 새 채팅으로 가져왔어요. 채팅 ${result.chats.length}개, 본문 ${result.sources}개를 복원했어요.`
      );
      await onImported().catch(() =>
        setError('채팅은 복원했어요. 목록을 새로 읽지 못했으니 새로고침해 주세요.')
      );
    } catch (caught) {
      setUncertain(
        !(
          caught instanceof ApiError &&
          caught.status >= 400 &&
          caught.status < 500 &&
          caught.status !== 408
        )
      );
      setError((caught as Error).message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="settings-group chat-backup-import" aria-label="채팅 가져오기">
      <header className="settings-group-heading archive-card-heading">
        <div>
          <h3>채팅 가져오기</h3>
          <p className="muted" id={`${id}-help`}>
            채팅 백업 파일을 새 채팅으로 복원해 이어서 사용할 수 있어요.
          </p>
        </div>
      </header>
      <div className="settings-group-body archive-management-card">
        <div className="archive-file-field">
          <label>
            채팅 백업 파일 선택
            <input
              ref={input}
              type="file"
              accept=".json,application/json,.uimori,.zip,application/zip"
              aria-label="채팅 백업 파일 선택"
              aria-describedby={`${id}-help`}
              disabled={disabled || busy || reading || uncertain}
              onChange={(event) => {
                void read(event.currentTarget.files?.[0]);
              }}
            />
          </label>
        </div>
        {reading && <LoadingState compact label="백업 파일을 읽고 있어요…" />}
        {selection && (
          <div className="archive-file-summary">
            <p>
              {selection.archive?.backup?.title ?? selection.backup!.title} · 채팅{' '}
              {selection.archive?.backup?.chats ?? selection.backup!.chats.length}개 · 본문{' '}
              {selection.archive?.backup?.sources ??
                selection.backup!.chats.reduce(
                  (sum, chat) => sum + chat.transcript.entries.length,
                  0
                )}
              개
            </p>
            <div className="archive-import-actions">
              <button type="button" disabled={disabled || busy} onClick={() => void restore()}>
                {busy ? '복원 중…' : uncertain ? '같은 요청 확인' : '새 채팅으로 가져오기'}
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
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {uncertain && (
          <p role="status">
            복원 결과가 아직 확인되지 않았어요. 같은 요청 확인으로 중복 없이 결과를 확인해 주세요.
          </p>
        )}
        {message && <p role="status">{message}</p>}
        <small className="muted archive-import-note">
          전역 프롬프트·역할 모델은 현재 작업실 설정을 사용하며 실행 기록과 도우미 내부 작업은
          가져오지 않아요.
        </small>
      </div>
    </section>
  );
}
