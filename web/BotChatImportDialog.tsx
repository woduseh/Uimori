import { useRef, useState } from 'react';
import { ChevronRight, Database, FileText } from 'lucide-react';
import { validateChatTranscript, type ChatTranscript } from '../core/chat-transcript.js';
import type { Content } from '../core/product.js';
import { api, ApiError } from './api.js';
import { Dialog } from './Dialog.js';
import { ContentAvatar } from './ContentAvatar.js';
import { ChatBackupImport } from './ChatBackupImport.js';
import './bot-chat-import.css';

export function BotChatImportDialog({
  bot,
  onClose,
  onImported,
}: {
  bot: Content;
  onClose: () => void;
  onImported: () => Promise<void>;
}) {
  const [mode, setMode] = useState<'choose' | 'transcript' | 'backup'>('choose');
  const [selection, setSelection] = useState<{
    name: string;
    transcript: ChatTranscript;
    idempotencyKey: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [backupDirty, setBackupDirty] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const lock = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  async function read(file?: File) {
    if (!file || lock.current) return;
    lock.current = true;
    setBusy(true);
    setSelection(null);
    setError('');
    setMessage('');
    try {
      if (file.size > 60 * 1024 * 1024) throw new Error('본문 파일은 60MB까지 가져올 수 있어요.');
      let transcript: ChatTranscript;
      try {
        transcript = validateChatTranscript(JSON.parse(await file.text()));
      } catch {
        throw new Error('Uimori에서 내보낸 본문 JSON 파일을 선택해 주세요.');
      }
      if (transcript.packageAttachments.some((item) => item.role !== 'bot' && item.id === bot.id))
        throw new Error(
          '이 파일은 선택한 봇을 다른 역할의 자료로도 사용해요. 역할을 유지하려면 데이터 관리의 개별 채팅 가져오기를 이용해 주세요.'
        );
      // The confirmation explicitly chooses this bot; other authored attachment roles stay intact.
      transcript = validateChatTranscript({
        ...transcript,
        packageAttachments: [
          { id: bot.id, revision: bot.revision, role: 'bot' },
          ...transcript.packageAttachments.filter((item) => item.role !== 'bot'),
        ],
      });
      setSelection({ name: file.name, transcript, idempotencyKey: crypto.randomUUID() });
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function restore() {
    if (!selection || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await api<{ chat: { title: string }; skippedAttachments: unknown[] }>(
        '/chats/import-transcript',
        {
          transcript: selection.transcript,
          idempotencyKey: selection.idempotencyKey,
        }
      );
      setSelection(null);
      setUncertain(false);
      if (fileInput.current) fileInput.current.value = '';
      setMessage(
        `“${result.chat.title}”을 새 채팅으로 가져왔어요.${result.skippedAttachments.length ? ` 찾을 수 없는 연결 자료 ${result.skippedAttachments.length}개는 제외됐어요.` : ''}`
      );
      await onImported().catch(() =>
        setError('가져오기는 완료했어요. 채팅 목록을 새로고침해 주세요.')
      );
    } catch (caught) {
      const definite =
        caught instanceof ApiError &&
        caught.status >= 400 &&
        caught.status < 500 &&
        caught.status !== 408;
      setUncertain(!definite);
      setError(
        definite
          ? caught.message
          : '결과를 확인하지 못했어요. 같은 요청 확인을 눌러 중복 없이 확인할 수 있어요.'
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  const blocked = busy || uncertain;
  return (
    <Dialog
      open
      title="채팅 가져오기"
      className="bot-chat-import-dialog"
      onClose={() => {
        if (!blocked) onClose();
      }}
    >
      <div className="chat-import-target">
        <ContentAvatar content={bot} />
        <div>
          <strong>{bot.title}</strong>
          <small>
            {mode === 'backup'
              ? '채팅 백업은 파일에 담긴 원래 봇 소속을 유지해요.'
              : '본문을 가져올 봇'}
          </small>
        </div>
      </div>
      {mode === 'choose' ? (
        <div className="chat-import-choices">
          <button type="button" onClick={() => setMode('transcript')}>
            <FileText size={20} />
            <span>
              <strong>본문만 가져오기</strong>
              <small>원문·요청·번역·메모를 새 채팅으로 가져와요.</small>
            </span>
            <ChevronRight size={18} />
          </button>
          <button type="button" onClick={() => setMode('backup')}>
            <Database size={20} />
            <span>
              <strong>채팅 백업 복원</strong>
              <small>본문·번역·메모·변수와 사용 자료를 새 채팅으로 복원해요.</small>
            </span>
            <ChevronRight size={18} />
          </button>
          <p className="muted">채팅 백업의 봇과 자료도 독립 사본으로 가져와요.</p>
        </div>
      ) : (
        <>
          <button
            type="button"
            className="secondary chat-import-back"
            disabled={blocked || backupDirty}
            onClick={() => {
              setMode('choose');
              setSelection(null);
              setError('');
              setMessage('');
            }}
          >
            가져오기 방식 변경
          </button>
          {mode === 'backup' ? (
            <ChatBackupImport
              onImported={onImported}
              onDirtyChange={setBackupDirty}
              onBusyChange={setBusy}
            />
          ) : (
            <section aria-label="본문 가져오기" className="chat-transcript-import">
              <label>
                본문 JSON 파일
                <input
                  ref={fileInput}
                  type="file"
                  accept=".json,application/json"
                  disabled={blocked}
                  onChange={(event) => void read(event.currentTarget.files?.[0])}
                />
              </label>
              {selection && (
                <div className="chat-import-review">
                  <strong>{selection.transcript.title}</strong>
                  <small>
                    {selection.name} · 본문 {selection.transcript.entries.length}개 · 메모{' '}
                    {selection.transcript.notes.length}개
                  </small>
                  <p>“{bot.title}”의 새 채팅으로 가져와요.</p>
                  <button type="button" disabled={busy} onClick={() => void restore()}>
                    {busy ? '가져오는 중…' : uncertain ? '같은 요청 확인' : '새 채팅으로 가져오기'}
                  </button>
                </div>
              )}
              {busy && !selection && !message && <p role="status">파일을 읽고 있어요…</p>}
              {message && <p role="status">{message}</p>}
              {error && (
                <p role="alert" className="error">
                  {error}
                </p>
              )}
            </section>
          )}
        </>
      )}
      <div className="form-actions">
        <button type="button" className="secondary" disabled={blocked} onClick={onClose}>
          닫기
        </button>
      </div>
    </Dialog>
  );
}
