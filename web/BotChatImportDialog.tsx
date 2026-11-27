import { readJsonFile } from './json-input.js';
import { t, useI18n, translateMessage, message as descriptor } from './i18n.js';
import { UiError, uiMessage } from './ui-message.js';
import { LoadingState } from './LoadingState.js';
import { NoticeBanner } from './NoticeBanner.js';
import { useRef, useState } from 'react';
import { validateChatTranscript, type ChatTranscript } from '../core/chat-transcript.js';
import type { Content } from '../core/product.js';
import { api, definiteRejection } from './api.js';
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
      if (file.size > 60 * 1024 * 1024) throw new UiError(uiMessage('transfer.m101'));
      let transcript: ChatTranscript;
      try {
        transcript = validateChatTranscript(await readJsonFile(file, 'transfer.m102'));
      } catch {
        throw new UiError(uiMessage('transfer.m102'));
      }
      if (transcript.packageAttachments.some((item) => item.role !== 'bot' && item.id === bot.id))
        throw new UiError(uiMessage('transfer.m103'));
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
        descriptor('transfer.transcriptImported', {
          title: result.chat.title,
          skipped: result.skippedAttachments.length,
        })
      );
      await onImported().catch(() => setError(descriptor('transfer.m104')));
    } catch (caught) {
      const unresolved = uncertain || !definiteRejection(caught);
      setUncertain(unresolved);
      setError(unresolved ? descriptor('transfer.m105') : (caught as Error).message);
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
        </div>
      </div>
      <section aria-label={t('transfer.m108')} className="chat-transcript-import">
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
            label={selection ? uiMessage('transfer.m118') : uiMessage('transfer.m119')}
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
