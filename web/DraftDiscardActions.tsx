import { t, translateMessage, useI18n, message as uiMessage } from './i18n.js';
import { useEffect, useRef, useState } from 'react';
import { CloseIcon, EditIcon, SaveIcon } from './ui-icons.js';
import { NoticeBanner } from './NoticeBanner.js';
import './draft-discard.css';

export function DraftDiscardActions({
  onContinue,
  onDiscard,
  onSave,
  onSavingChange,
  discardLabel = '초안 버리고 이동',
  saveLabel = '저장하고 이동',
  disabled = false,
  open = true,
}: {
  onContinue: () => void;
  onDiscard: () => void | Promise<void>;
  onSave?: () => Promise<boolean>;
  onSavingChange?: (saving: boolean) => void;
  discardLabel?: string;
  saveLabel?: string;
  disabled?: boolean;
  open?: boolean;
}) {
  useI18n();
  const continueButton = useRef<HTMLButtonElement>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!open) return;
    setError('');
    const frame = requestAnimationFrame(() => continueButton.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);
  return (
    <>
      <div className="form-actions draft-discard-actions" aria-busy={saving}>
        <button
          type="button"
          className="secondary draft-discard"
          disabled={disabled || saving}
          onClick={onDiscard}
        >
          <CloseIcon size={18} aria-hidden="true" />
          {translateMessage(discardLabel)}
        </button>
        <button
          type="button"
          className="draft-continue"
          ref={continueButton}
          disabled={disabled || saving}
          onClick={onContinue}
        >
          <EditIcon size={18} aria-hidden="true" />
          {t('shared.continueEditing')}
        </button>
        {onSave && (
          <button
            type="button"
            className="primary draft-save-leave"
            disabled={disabled || saving}
            onClick={async () => {
              setSaving(true);
              onSavingChange?.(true);
              setError('');
              try {
                if (!(await onSave())) setError(uiMessage('shared.saveFailure'));
              } catch (caught) {
                setError((caught as Error).message);
              } finally {
                setSaving(false);
                onSavingChange?.(false);
              }
            }}
          >
            <SaveIcon size={18} aria-hidden="true" />
            {saving ? t('shared.saving') : translateMessage(saveLabel)}
          </button>
        )}
      </div>
      {error && <NoticeBanner tone="error">{translateMessage(error)}</NoticeBanner>}
    </>
  );
}
