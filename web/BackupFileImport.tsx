import { t, useI18n, translateMessage, message as retainedMessage } from './i18n.js';
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
  useI18n();
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
            ? retainedMessage('transfer.m126')
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
        setMessage(retainedMessage('transfer.d006', { v0: result.items.length }));
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
          retainedMessage('transfer.d007', {
            v0: result.chat.title,
            v1: result.chats.length,
            v2: result.sources,
          })
        );
      }
      setSelection(null);
      setUncertain(false);
      if (input.current) input.current.value = '';
      await onImported().catch(() => setError(retainedMessage('transfer.m127')));
    } catch (caught) {
      setUncertain(uncertain || !definiteRejection(caught));
      setError((caught as Error).message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  return (
    <section className="settings-group chat-backup-import" aria-label={t('transfer.m128')}>
      <header className="settings-group-heading archive-card-heading">
        <div>
          <h3>{t('transfer.m128')}</h3>
          <p className="muted" id={`${id}-help`}>
            {t('transfer.m129')}
          </p>
        </div>
      </header>
      <div className="settings-group-body archive-management-card">
        <div className="archive-file-field">
          <label>
            {t('transfer.m130')}
            <input
              ref={input}
              type="file"
              accept=".json,application/json,.uimori,.zip,application/zip,.sqlite,.sqlite3,.db"
              aria-label={t('transfer.m130')}
              aria-describedby={`${id}-help`}
              disabled={disabled || busy || reading || uncertain}
              onChange={(event) => void read(event.currentTarget.files?.[0])}
            />
          </label>
        </div>
        {reading && <LoadingState presentation="inline" label={t('transfer.m131')} />}
        {database && <NoticeBanner>{t('transfer.m132')}</NoticeBanner>}
        {selection && (
          <div className="archive-file-summary">
            {selection.kind === 'resources' ? (
              <>
                <p>
                  {t('transfer.resourcesSummary', {
                    contents: selection.preview.summary.contents,
                    prompts: selection.preview.summary.prompts,
                    images: selection.preview.summary.images,
                  })}
                </p>
                {!!selection.preview.modelRequirements.length && <p>{t('transfer.m137')}</p>}
              </>
            ) : (
              <>
                <p>
                  {t('transfer.chatSummary', {
                    title: selection.archive?.backup?.title ?? selection.backup!.title,
                    chats: selection.archive?.backup?.chats ?? selection.backup!.chats.length,
                    sources:
                      selection.archive?.backup?.sources ??
                      selection.backup!.chats.reduce(
                        (sum, chat) => sum + chat.transcript.entries.length,
                        0
                      ),
                  })}
                </p>
                <small className="muted archive-import-note">{t('transfer.m141')}</small>
              </>
            )}
            <div className="archive-import-actions">
              <button type="button" disabled={disabled || busy} onClick={() => void restore()}>
                {busy
                  ? t('transfer.m142')
                  : uncertain
                    ? t('transfer.m058')
                    : selection.kind === 'resources'
                      ? t('transfer.m143')
                      : t('transfer.m117')}
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
                {t('transfer.m144')}
              </button>
            </div>
          </div>
        )}
        {busy && <LoadingState presentation="inline" label={t('transfer.m145')} />}
        {uncertain && <NoticeBanner>{t('transfer.m146')}</NoticeBanner>}
        {message && <NoticeBanner>{translateMessage(message)}</NoticeBanner>}
        {error && <NoticeBanner tone="error">{translateMessage(error)}</NoticeBanner>}
      </div>
    </section>
  );
}
