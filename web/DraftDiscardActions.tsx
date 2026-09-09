import { useEffect, useRef } from 'react';
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
    <div className="draft-discard-actions">
      <button
        type="button"
        className="draft-continue"
        ref={continueButton}
        disabled={disabled}
        onClick={onContinue}
      >
        계속 편집
      </button>
      <button
        type="button"
        className="secondary draft-discard"
        disabled={disabled}
        onClick={onDiscard}
      >
        {discardLabel}
      </button>
    </div>
  );
}
