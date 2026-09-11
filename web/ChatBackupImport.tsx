import { useEffect, useId, useRef, useState } from 'react';
import {
  CHAT_BACKUP_FORMAT,
  CHAT_BACKUP_MAX_BYTES,
  CHAT_BACKUP_VERSION,
  type ChatBackup,
  type ChatBackupImport as ImportResult,
} from '../core/chat-backup.js';
import { api } from './api.js';

export function ChatBackupImport({
  onImported,
  onDirtyChange,
  disabled = false,
}: {
  onImported: () => Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
  disabled?: boolean;
}) {
  const [selection, setSelection] = useState<{
    backup: ChatBackup;
    requestKey: string;
  } | null>(null);
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
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
    const current = ++version.current;
    setSelection(null);
    setError('');
    setMessage('');
    setReading(!!file);
    if (!file) return;
    try {
      if (file.size > CHAT_BACKUP_MAX_BYTES)
        throw new Error('채팅 백업은 256MB까지 가져올 수 있어요.');
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
      if (
        !Array.isArray(backup.records?.chat) ||
        backup.records.chat.length !== 1 ||
        !Array.isArray(backup.records.branches) ||
        !Array.isArray(backup.records.sources)
      )
        throw new Error('채팅 백업의 필수 정보가 없어요.');
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
      const result = await api<ImportResult>('/chats/import-backup', {
        backup: selection.backup,
        idempotencyKey: selection.requestKey,
      });
      setSelection(null);
      if (input.current) input.current.value = '';
      setMessage(
        `“${result.chat.title}”을 새 채팅으로 가져왔어요. 분기 ${result.branches}개, 본문 ${result.sources}개를 복원했어요.`
      );
      await onImported().catch(() =>
        setError('채팅은 복원했어요. 목록을 새로 읽지 못했으니 새로고침해 주세요.')
      );
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="chat-backup-import" aria-label="채팅 백업 가져오기">
      <h3>채팅 백업 가져오기</h3>
      <p className="muted" id={`${id}-help`}>
        모든 분기와 기록을 새 채팅으로 복원해요. 같은 파일을 다시 가져와도 기존 채팅은 유지돼요.
      </p>
      <div className="archive-file-field">
        <label>
          채팅 백업 파일 선택
          <input
            ref={input}
            type="file"
            accept=".json,application/json"
            aria-label="채팅 백업 파일 선택"
            aria-describedby={`${id}-help`}
            disabled={disabled || busy || reading}
            onChange={(event) => {
              void read(event.currentTarget.files?.[0]);
            }}
          />
        </label>
      </div>
      {reading && <p role="status">백업 파일을 읽고 있어요…</p>}
      {selection && (
        <div className="archive-file-summary">
          <p>
            {String(selection.backup.records.chat[0].title)} · 분기{' '}
            {selection.backup.records.branches.length}개 · 본문{' '}
            {selection.backup.records.sources.length}개
          </p>
          <div className="archive-import-actions">
            <button type="button" disabled={disabled || busy} onClick={() => void restore()}>
              {busy ? '복원 중…' : '새 채팅으로 가져오기'}
            </button>
            <button
              type="button"
              className="secondary"
              disabled={busy}
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
      {message && <p role="status">{message}</p>}
      <p className="muted">
        전역 프롬프트·역할 모델은 현재 작업공간의 설정을 사용해요. 원래 설정은 복원 기록에 보관돼요.
        중단된 외부 요청은 다시 전송하지 않아요.
      </p>
    </section>
  );
}
