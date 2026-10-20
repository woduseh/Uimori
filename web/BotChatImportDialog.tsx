import { t, useI18n, translateMessage, message as retainedMessage } from './i18n.js';
import { LoadingState } from './LoadingState.js';
import { NoticeBanner } from './NoticeBanner.js';
import { useRef, useState } from 'react';
import { validateChatTranscript, type ChatTranscript } from '../core/chat-transcript.js';
import type { Content } from '../core/product.js';
import { api, ApiError } from './api.js';
import { Dialog } from './Dialog.js';
import { ContentAvatar } from './ContentAvatar.js';
import './bot-chat-import.css';

export function BotChatImportDialog({
  bot,
  onClose,
  onImported,
  onOpenBackups,
}: {
  bot: Content;
  onClose: () => void;
  onImported: () => Promise<void>;
  onOpenBackups: () => void;
}) {
  useI18n();
  const [selection, setSelection] = useState<{
    name: string;
    transcript: ChatTranscript;
    idempotencyKey: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
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
        retainedMessage('transfer.transcriptImported', {
          title: result.chat.title,
          skipped: result.skippedAttachments.length,
        })
      );
      await onImported().catch(() => setError(retainedMessage('transfer.m104')));
    } catch (caught) {
      const definite =
        caught instanceof ApiError &&
        caught.status >= 400 &&
        caught.status < 500 &&
        caught.status !== 408;
      setUncertain(!definite);
      setError(definite ? caught.message : retainedMessage('transfer.m105'));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  const blocked = busy || uncertain;
  return (
    <Dialog
      open
      title={t('transfer.m106')}
      className="bot-chat-import-dialog"
      onClose={() => {
        if (!blocked) onClose();
      }}
    >
      <div className="chat-import-target">
        <ContentAvatar content={bot} />
        <div>
          <strong>{bot.title}</strong>
          <small>{t('transfer.m107')}</small>
        </div>
      </div>
      <section aria-label={t('transfer.m108')} className="chat-transcript-import">
        <p className="muted">{t('transfer.m109')}</p>
        <label>
          {t('transfer.m110')}
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
              {t('transfer.transcriptSummary', {
                name: selection.name,
                entries: selection.transcript.entries.length,
                notes: selection.transcript.notes.length,
              })}
            </small>
            <p>{t('transfer.transcriptTarget', { title: bot.title })}</p>
            <button type="button" disabled={busy} onClick={() => void restore()}>
              {busy ? t('transfer.m115') : uncertain ? t('transfer.m116') : t('transfer.m117')}
            </button>
          </div>
        )}
        {busy && (
          <LoadingState
            presentation="inline"
            label={selection ? t('transfer.m118') : t('transfer.m119')}
          />
        )}
        {message && <NoticeBanner>{translateMessage(message)}</NoticeBanner>}
        {error && <NoticeBanner tone="error">{translateMessage(error)}</NoticeBanner>}
      </section>
      <div className="form-actions">
        <button
          type="button"
          className="ghost"
          disabled={blocked || !!selection}
          title={t('transfer.m120')}
          onClick={onOpenBackups}
        >
          {t('transfer.m121')}
        </button>
        <button type="button" className="secondary" disabled={blocked} onClick={onClose}>
          {t('transfer.m122')}
        </button>
      </div>
    </Dialog>
  );
}
