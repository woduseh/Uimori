import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { api, saveDownload } from './api.js';
import { IconButton } from './IconButton.js';
import { CloseIcon, DownloadIcon, RefreshIcon, UploadIcon } from './ui-icons.js';
import { ChatBackupImport } from './ChatBackupImport.js';

type ImportStatus = 'loading' | 'allowed' | 'occupied' | 'failed';
type ArchiveOperation = 'json' | 'sqlite' | 'import';

export function ArchivePanel({
  onImported,
  onError,
  onDirtyChange,
  expanded = false,
  active = true,
}: {
  onImported: () => Promise<void>;
  onError: (error: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
  expanded?: boolean;
  active?: boolean;
}) {
  const [archive, setArchive] = useState<{ value: unknown } | null>(null);
  const [fileSelected, setFileSelected] = useState(false);
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState<ArchiveOperation | null>(null);
  const [fileError, setFileError] = useState('');
  const [backupError, setBackupError] = useState('');
  const [importError, setImportError] = useState('');
  const [backupMessage, setBackupMessage] = useState('');
  const [importMessage, setImportMessage] = useState('');
  const [status, setStatus] = useState<ImportStatus>('loading');
  const [statusError, setStatusError] = useState('');
  const [transcriptBusy, setTranscriptBusy] = useState(false);
  const [transcriptError, setTranscriptError] = useState('');
  const [transcriptMessage, setTranscriptMessage] = useState('');
  const [chatBackupDirty, setChatBackupDirty] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const readVersion = useRef(0);
  const statusVersion = useRef(0);
  const operationLock = useRef(false);
  const dirtyHandler = useRef(onDirtyChange);
  dirtyHandler.current = onDirtyChange;
  const id = useId();

  const refreshStatus = useCallback(async () => {
    const version = ++statusVersion.current;
    setStatus('loading');
    setStatusError('');
    try {
      const result = await api<{ canImport: boolean }>('/import/status');
      if (typeof result?.canImport !== 'boolean') throw new Error('Invalid import status');
      if (version !== statusVersion.current) return;
      setStatus(result.canImport ? 'allowed' : 'occupied');
    } catch {
      if (version !== statusVersion.current) return;
      setStatus('failed');
      setStatusError('복원 가능 여부를 확인하지 못했어요. 다시 확인해 주세요.');
    }
  }, []);
  useEffect(() => {
    if (active) void refreshStatus();
  }, [active, refreshStatus]);
  useEffect(() => {
    onDirtyChange?.(fileSelected || reading || busy !== null || chatBackupDirty);
  }, [onDirtyChange, fileSelected, reading, busy, chatBackupDirty]);
  useEffect(
    () => () => {
      readVersion.current++;
      statusVersion.current++;
      dirtyHandler.current?.(false);
    },
    []
  );

  function clearSelection() {
    readVersion.current++;
    setArchive(null);
    setFileSelected(false);
    setReading(false);
    setFileError('');
    if (fileInput.current) fileInput.current.value = '';
  }
  async function readFile(file?: File) {
    const version = ++readVersion.current;
    setArchive(null);
    setFileSelected(!!file);
    setReading(!!file);
    setFileError('');
    setImportError('');
    setImportMessage('');
    if (!file) return;
    void refreshStatus();
    try {
      const text = await file.text();
      if (version !== readVersion.current) return;
      setArchive({ value: JSON.parse(text) as unknown });
    } catch {
      if (version !== readVersion.current) return;
      setFileError('파일을 읽지 못했거나 JSON 형식이 아니에요. JSON 백업 파일을 선택해 주세요.');
    } finally {
      if (version === readVersion.current) setReading(false);
    }
  }
  async function perform(kind: ArchiveOperation, work: () => Promise<void>) {
    if (operationLock.current) return;
    operationLock.current = true;
    setBusy(kind);
    onError('');
    if (kind === 'import') {
      setImportError('');
      setImportMessage('');
    } else {
      setBackupError('');
      setBackupMessage('');
    }
    try {
      await work();
    } catch (error) {
      const message = (error as Error).message;
      if (kind === 'import') {
        setImportError(message);
        await refreshStatus();
      } else setBackupError(message);
    } finally {
      operationLock.current = false;
      setBusy(null);
    }
  }
  async function importTranscript(file: File) {
    if (operationLock.current) return;
    operationLock.current = true;
    setTranscriptBusy(true);
    setTranscriptError('');
    setTranscriptMessage('');
    onError('');
    try {
      const transcript = JSON.parse(await file.text()) as unknown;
      const result = await api<{ chat: { title: string }; skippedAttachments: unknown[] }>(
        '/chats/import-transcript',
        { transcript, idempotencyKey: crypto.randomUUID() }
      );
      const skipped = result.skippedAttachments.length;
      // The chat exists now; the list refresh runs in the background so the busy state ends here.
      setTranscriptBusy(false);
      setTranscriptMessage(
        `"${result.chat.title}" 채팅을 만들었어요.` +
          (skipped ? ` 서재에 없는 자료 ${skipped}개는 장착하지 않았어요.` : '')
      );
      void onImported().catch((caught) =>
        setTranscriptError(
          `채팅은 만들었어요. 목록을 새로 읽지 못했어요. ${(caught as Error).message}`
        )
      );
    } catch (error) {
      setTranscriptError(
        error instanceof SyntaxError
          ? '파일을 읽지 못했거나 JSON 형식이 아니에요. 채팅 본문 JSON 파일을 선택해 주세요.'
          : (error as Error).message
      );
    } finally {
      operationLock.current = false;
      setTranscriptBusy(false);
    }
  }
  const Container = expanded ? 'section' : 'details';
  return (
    <Container
      className={expanded ? 'archive-settings' : 'workspace-tools'}
      data-testid="archive-panel"
      aria-label="백업과 가져오기"
    >
      {!expanded && <summary>내보내기와 복원</summary>}
      <ChatBackupImport
        onImported={onImported}
        onDirtyChange={setChatBackupDirty}
        disabled={busy !== null || transcriptBusy}
      />
      <section aria-label="백업 받기">
        <h3>백업 받기</h3>
        <div className="archive-backup-options">
          <div className="archive-backup-option">
            <button
              type="button"
              className="secondary"
              disabled={busy !== null}
              aria-describedby={`${id}-json-help`}
              onClick={() => {
                void perform('json', async () => {
                  const result = await api('/export');
                  saveDownload('narrative-archive.json', result);
                  setBackupMessage('JSON 내보내기를 준비했어요.');
                });
              }}
            >
              <DownloadIcon size={18} aria-hidden="true" /> JSON 내보내기
            </button>
            <p id={`${id}-json-help`} className="muted">
              자료와 대화를 새 빈 DB로 옮겨요.
            </p>
          </div>
          <div className="archive-backup-option">
            <button
              type="button"
              className="secondary"
              disabled={busy !== null}
              aria-describedby={`${id}-sqlite-help`}
              onClick={() => {
                void perform('sqlite', async () => {
                  const response = await fetch('/api/backup');
                  if (!response.ok) throw new Error(`백업을 만들지 못했어요. (${response.status})`);
                  const url = URL.createObjectURL(await response.blob());
                  const anchor = document.createElement('a');
                  anchor.href = url;
                  anchor.download = 'narrative-backup.sqlite';
                  anchor.click();
                  setTimeout(() => URL.revokeObjectURL(url), 1000);
                  setBackupMessage('일관된 SQLite 백업을 준비했어요.');
                });
              }}
            >
              <DownloadIcon size={18} aria-hidden="true" /> SQLite 백업 다운로드
            </button>
            <p id={`${id}-sqlite-help`} className="muted">
              서버 데이터베이스 전체를 보관해요.
            </p>
          </div>
        </div>
        {backupError && (
          <p className="error" role="alert">
            {backupError}
          </p>
        )}
        {backupMessage && <p role="status">{backupMessage}</p>}
      </section>
      <section aria-label="가져오기">
        <h3>가져오기</h3>
        <p className="muted" id={`${id}-import-condition`}>
          새 빈 데이터베이스에만 복원할 수 있어요. 현재 자료에 덮어쓰거나 합치지 않아요.
        </p>
        <div className="archive-import-status">
          {status === 'loading' && <p role="status">복원 가능 여부를 확인하고 있어요…</p>}
          {status === 'allowed' && (
            <p role="status">현재 DB에 가져올 수 있어요. 실행할 때 서버가 다시 확인해요.</p>
          )}
          {status === 'occupied' && (
            <p role="status">
              현재 DB에 자료가 있어 가져올 수 없어요. 새 빈 데이터베이스를 준비해 주세요.
            </p>
          )}
          {statusError && (
            <p className="error" role="alert">
              {statusError}
            </p>
          )}
          <IconButton
            label="복원 가능 여부 다시 확인"
            icon={RefreshIcon}
            disabled={busy !== null || status === 'loading'}
            onClick={() => void refreshStatus()}
          />
        </div>
        <form
          className="editor-grid"
          aria-label="JSON 가져오기"
          onSubmit={(event) => {
            event.preventDefault();
            if (!archive || reading || status !== 'allowed' || operationLock.current) return;
            const value = archive.value;
            void perform('import', async () => {
              await api('/import', { archive: value });
              clearSelection();
              setImportMessage('빈 DB에 가져오기를 완료했어요.');
              try {
                await onImported();
              } catch (error) {
                setImportError(
                  `가져오기는 완료됐어요. 목록을 새로 읽지 못했어요. ${(error as Error).message}`
                );
              }
              await refreshStatus();
            });
          }}
        >
          <div className="archive-file-field full">
            <label>
              가져올 JSON 파일
              <input
                ref={fileInput}
                aria-label="가져올 JSON 파일"
                aria-describedby={`${id}-import-condition${fileError ? ` ${id}-file-error` : ''}`}
                aria-invalid={!!fileError}
                type="file"
                accept="application/json,.json"
                disabled={busy !== null}
                onChange={(event) => void readFile(event.target.files?.[0])}
              />
            </label>
            {fileSelected && (
              <IconButton
                label="선택한 파일 해제"
                icon={CloseIcon}
                disabled={busy !== null}
                onClick={clearSelection}
              />
            )}
          </div>
          {reading && (
            <p className="full" role="status">
              파일을 읽고 있어요…
            </p>
          )}
          {fileError && (
            <p id={`${id}-file-error`} className="error full" role="alert">
              {fileError}
            </p>
          )}
          <div className="archive-import-actions form-actions full">
            <button disabled={busy !== null || reading || !archive || status !== 'allowed'}>
              <UploadIcon size={18} aria-hidden="true" />{' '}
              {busy === 'import' ? '가져오는 중…' : '빈 DB에 가져오기'}
            </button>
            {!fileSelected && <small>먼저 JSON 백업 파일을 선택해 주세요.</small>}
          </div>
          {importError && (
            <p className="error full" role="alert">
              {importError}
            </p>
          )}
          {importMessage && (
            <p className="full" role="status">
              {importMessage}
            </p>
          )}
        </form>
        <details>
          <summary>서버 관리자를 위한 복원 안내</summary>
          <p className="muted">
            JSON 파일은 새 빈 데이터베이스에서 위 가져오기를 사용해요. SQLite 백업은 서버를 종료하고
            새 NR_DB 경로에 보관해 다시 열 수 있어요. 이미 자료가 있는 DB로의 가져오기는 서버가
            거절해요.
          </p>
        </details>
      </section>
      <section aria-label="채팅 본문 가져오기">
        <h3>채팅 본문 가져오기</h3>
        <p className="muted" id={`${id}-transcript-help`}>
          외부에서 만든 uimori-chat-transcript 형식의 본문 JSON을 새 채팅으로 읽어요. 원문·요청·최신
          번역·메모만 담은 한 분기의 자료이며, 완전 백업은 위의 채팅 백업 가져오기를 사용해요. 봇은
          이 서재에 있어야 해요.
        </p>
        <div className="archive-file-field">
          <label>
            채팅 본문 JSON 파일
            <input
              aria-label="채팅 본문 JSON 파일"
              aria-describedby={`${id}-transcript-help`}
              type="file"
              accept="application/json,.json"
              disabled={busy !== null || transcriptBusy}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) void importTranscript(file);
              }}
            />
          </label>
        </div>
        {transcriptBusy && <p role="status">채팅을 만들고 있어요…</p>}
        {transcriptError && (
          <p className="error" role="alert">
            {transcriptError}
          </p>
        )}
        {transcriptMessage && <p role="status">{transcriptMessage}</p>}
      </section>
    </Container>
  );
}
