import { useEffect, useRef, useState } from 'react';
import { CloseIcon, EditIcon, SaveIcon } from './ui-icons.js';
import './draft-discard.css';

export function DraftDiscardActions({
  onContinue,
  onDiscard,
  onSave,
  onSavingChange,
  discardLabel = '초안 버리고 이동',
  disabled = false,
  open = true,
}: {
  onContinue: () => void;
  onDiscard: () => void | Promise<void>;
  onSave?: () => Promise<boolean>;
  onSavingChange?: (saving: boolean) => void;
  discardLabel?: string;
  disabled?: boolean;
  open?: boolean;
}) {
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
          {discardLabel}
        </button>
        <button
          type="button"
          className="draft-continue"
          ref={continueButton}
          disabled={disabled || saving}
          onClick={onContinue}
        >
          <EditIcon size={18} aria-hidden="true" />
          계속 편집
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
                if (!(await onSave()))
                  setError('저장하지 못했어요. 계속 편집에서 오류나 미적용 입력을 확인해 주세요.');
              } catch (caught) {
                setError((caught as Error).message);
              } finally {
                setSaving(false);
                onSavingChange?.(false);
              }
            }}
          >
            <SaveIcon size={18} aria-hidden="true" />
            {saving ? '저장 중…' : '저장하고 이동'}
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </>
  );
}
