import { useEffect, useRef } from 'react';
import { CloseIcon, EditIcon } from './ui-icons.js';
import './draft-discard.css';

export function DraftDiscardActions({
  onContinue,
  onDiscard,
  discardLabel = '초안 버리고 이동',
  disabled = false,
  open = true,
}: {
  onContinue: () => void;
  onDiscard: () => void | Promise<void>;
  discardLabel?: string;
  disabled?: boolean;
  open?: boolean;
}) {
  const continueButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => continueButton.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);
  return (
    <div className="form-actions draft-discard-actions">
      <button
        type="button"
        className="secondary draft-discard danger"
        disabled={disabled}
        onClick={onDiscard}
      >
        <CloseIcon size={18} aria-hidden="true" />
        {discardLabel}
      </button>
      <button
        type="button"
        className="draft-continue"
        ref={continueButton}
        disabled={disabled}
        onClick={onContinue}
      >
        <EditIcon size={18} aria-hidden="true" />
        계속 편집
      </button>
    </div>
  );
}
