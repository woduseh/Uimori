import { t, useI18n, translateMessage } from './i18n.js';
import { LoadingState } from './LoadingState.js';
import { useEffect, useState } from 'react';
import type { SourceVersions as Versions } from '../core/source-versions.js';
import { api } from './api.js';

export function SourceVersions({
  sourceId,
  revision,
  draft,
  disabled,
  onApply,
}: {
  sourceId: string;
  revision: number;
  draft: string;
  disabled: boolean;
  onApply: (text: string) => void;
}) {
  useI18n();
  const [open, setOpen] = useState(false);
  const [versions, setVersions] = useState<Versions | null>(null);
  const [selected, setSelected] = useState(0);
  const [error, setError] = useState('');
  const [priorDraft, setPriorDraft] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setVersions(null);
    setError('');
    void api<Versions>(`/sources/${sourceId}/versions`, undefined, 'GET', controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setVersions(result);
        setSelected(result.versions[1]?.revision ?? 0);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError((cause as Error).message);
      });
    return () => controller.abort();
  }, [open, sourceId]);
  const version = versions?.versions.find((item) => item.revision === selected);
  const label = (value: number) =>
    value === versions?.currentRevision
      ? t('reader.currentSavedVersion')
      : value === 0
        ? t('reader.initialOriginal')
        : t('reader.previousSavedVersion');
  return (
    <details className="source-versions" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{t('reader.compareSavedVersions')}</summary>
      {open && (
        <>
          {error && (
            <p role="alert" className="error">
              {translateMessage(error)}
            </p>
          )}
          {!versions && !error && (
            <LoadingState presentation="inline" label={t('reader.loadingSavedVersions')} />
          )}
          {versions && version && (
            <>
              <label>
                {t('reader.versionToCompare')}
                <select
                  value={selected}
                  onChange={(event) => setSelected(Number(event.target.value))}
                >
                  {versions.versions.map((item) => (
                    <option key={item.revision} value={item.revision}>
                      {label(item.revision)}
                    </option>
                  ))}
                </select>
              </label>
              <div className="source-versions-comparison">
                <div>
                  <strong>{label(selected)}</strong>
                  <pre>{version.text}</pre>
                </div>
                <div>
                  <strong>{t('reader.draftBeingEdited')}</strong>
                  <pre>{draft}</pre>
                </div>
              </div>
              <div className="form-actions">
                <button
                  type="button"
                  className="secondary"
                  disabled={
                    disabled || versions.currentRevision !== revision || draft === version.text
                  }
                  onClick={() => {
                    setPriorDraft(draft);
                    onApply(version.text);
                  }}
                >
                  {t('reader.loadSelectedVersionIntoDraft')}
                </button>
                {priorDraft !== null && (
                  <button
                    type="button"
                    className="secondary"
                    disabled={disabled}
                    onClick={() => {
                      onApply(priorDraft);
                      setPriorDraft(null);
                    }}
                  >
                    {t('reader.returnToDraftBeforeLoading')}
                  </button>
                )}
              </div>
              <small>{t('reader.saveTheOriginalToApplyItToTheText')}</small>
              {versions.currentRevision !== revision && (
                <p role="alert">{t('reader.theSavedVersionChangedReopenTheEditorToReview')}</p>
              )}
            </>
          )}
        </>
      )}
    </details>
  );
}
