import { t, useI18n, translateMessage } from './i18n.js';
import { LoadingState } from './LoadingState.js';
import { useEffect, useRef, useState } from 'react';
import type {
  ManuscriptExportMetadata,
  ManuscriptExportMode,
  ManuscriptExportResult,
} from '../core/manuscript-export.js';
import { api } from './api.js';
import { Dialog } from './Dialog.js';

export function ManuscriptExportDialog({
  open,
  chatId,
  onClose,
}: {
  open: boolean;
  chatId: string;
  onClose: () => void;
}) {
  useI18n();
  const [metadata, setMetadata] = useState<ManuscriptExportMetadata | null>(null);
  const [mode, setMode] = useState<ManuscriptExportMode>('source');
  const [range, setRange] = useState(false);
  const [from, setFrom] = useState(0);
  const [to, setTo] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const active = useRef(0);
  useEffect(() => {
    const generation = ++active.current;
    if (!open) return;
    const controller = new AbortController();
    setMetadata(null);
    setMode('source');
    setRange(false);
    setBusy(false);
    setError('');
    void api<ManuscriptExportMetadata>(
      `/chats/${chatId}/manuscript`,
      undefined,
      'GET',
      controller.signal
    )
      .then((next) => {
        if (active.current !== generation) return;
        setMetadata(next);
        setFrom(next.scenes[0]?.number ?? 0);
        setTo(next.scenes.at(-1)?.number ?? 0);
      })
      .catch((cause) => {
        if (!controller.signal.aborted && active.current === generation)
          setError((cause as Error).message);
      });
    return () => {
      controller.abort();
      active.current++;
    };
  }, [open, chatId]);
  async function download() {
    if (!metadata || busy) return;
    const generation = active.current;
    setBusy(true);
    setError('');
    try {
      const result = await api<ManuscriptExportResult>(`/chats/${chatId}/manuscript`, {
        mode,
        expectedHeadRevision: metadata.headRevision,
        ...(range ? { fromScene: from, toScene: to } : {}),
      });
      if (active.current !== generation) return;
      const url = URL.createObjectURL(
        new Blob([result.markdown], { type: 'text/markdown;charset=utf-8' })
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = result.filename;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      onClose();
    } catch (cause) {
      if (active.current === generation) setError((cause as Error).message);
    } finally {
      if (active.current === generation) setBusy(false);
    }
  }
  return (
    <Dialog
      open={open}
      title={t('transfer.m192')}
      headerTitle={t('transfer.m192')}
      onClose={onClose}
      scopeKey={chatId}
    >
      <p>{t('transfer.m193')}</p>
      <fieldset className="editor-fields" disabled={busy || !metadata}>
        <label className="full">
          {t('transfer.m194')}
          <select
            value={mode}
            onChange={(event) => {
              setMode(event.target.value as ManuscriptExportMode);
              setError('');
            }}
          >
            <option value="source">{t('transfer.m195')}</option>
            <option value="translation">{t('transfer.m196')}</option>
          </select>
        </label>
        <label className="full">
          {t('transfer.m197')}
          <select
            value={range ? 'range' : 'all'}
            onChange={(event) => {
              setRange(event.target.value === 'range');
              setError('');
            }}
          >
            <option value="all">{t('transfer.m198')}</option>
            <option value="range">{t('transfer.m199')}</option>
          </select>
        </label>
        {range && (
          <>
            <label>
              {t('transfer.m200')}
              <select
                value={from}
                onChange={(event) => {
                  setFrom(Number(event.target.value));
                  setError('');
                }}
              >
                {metadata?.scenes.map((scene) => (
                  <option key={scene.number} value={scene.number}>
                    {scene.number === 0
                      ? t('transfer.m029')
                      : t('transfer.d011', { v0: scene.number })}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t('transfer.m201')}
              <select
                value={to}
                onChange={(event) => {
                  setTo(Number(event.target.value));
                  setError('');
                }}
              >
                {metadata?.scenes.map((scene) => (
                  <option key={scene.number} value={scene.number}>
                    {scene.number === 0
                      ? t('transfer.m029')
                      : t('transfer.d011', { v0: scene.number })}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
      </fieldset>
      <p className="muted">{t('transfer.m202')}</p>
      {mode === 'translation' && <p className="muted">{t('transfer.m203')}</p>}
      {!metadata && (
        <LoadingState
          presentation="inline"
          loading={!error}
          error={translateMessage(error)}
          label={t('transfer.m204')}
        />
      )}
      {metadata && !metadata.scenes.length && <p role="status">{t('transfer.m205')}</p>}
      {metadata && error && (
        <p className="error" role="alert">
          {translateMessage(error)}
        </p>
      )}
      <div className="form-actions">
        <button type="button" className="secondary" onClick={onClose}>
          {t('transfer.m206')}
        </button>
        <button
          type="button"
          className="primary"
          disabled={busy || !metadata?.scenes.length || (range && from > to)}
          onClick={() => void download()}
        >
          {busy ? t('transfer.m207') : t('transfer.m208')}
        </button>
      </div>
    </Dialog>
  );
}
