import { useEffect, useId, useRef, useState } from 'react';
import { Ellipsis, X } from 'lucide-react';
import './composer-more.css';

type Props = { selected: boolean; disabled: boolean; onChange: (value: boolean) => void };

export function LoreResetChip({ selected, disabled, onChange }: Props) {
  return selected ? (
    <div className="composer-request-chips">
      <button
        type="button"
        className="lore-reset-chip"
        disabled={disabled}
        aria-label="조회 로어 제외 해제"
        onClick={() => onChange(false)}
      >
        조회 로어 제외
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  ) : null;
}

export function ComposerMore({ selected, disabled, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null),
    trigger = useRef<HTMLButtonElement>(null),
    choice = useRef<HTMLInputElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    choice.current?.focus();
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  return (
    <div
      className="composer-more"
      ref={root}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          trigger.current?.focus();
        }
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="icon-button"
        aria-label="입력창 더보기"
        title="더보기"
        aria-expanded={open}
        aria-controls={id}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        <Ellipsis size={18} />
      </button>
      {open && (
        <div id={id} className="composer-more-panel" role="group" aria-label="이번 요청 옵션">
          <label>
            <input
              ref={choice}
              type="checkbox"
              checked={selected}
              aria-describedby={`${id}-description`}
              onChange={(event) => {
                onChange(event.target.checked);
                setOpen(false);
                trigger.current?.focus();
              }}
            />
            <span>다음 생성에서 조회 로어 제외</span>
          </label>
          <p id={`${id}-description`}>
            이전에 읽은 로어를 다음 생성에 전달하지 않아요. 고정 자료는 유지해요.
          </p>
        </div>
      )}
    </div>
  );
}
