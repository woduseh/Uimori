import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Dialog } from './Dialog.js';
import './save-conflict-dialog.css';
import './settings-layout.css';

export type SavedSettingField = { label: string; value: string };
type SavedReview = SavedSettingField[] | { content: ReactNode };

/** Reviewing the saved version never changes the editable draft or its revision. */
export function SaveConflictDialog({
  open,
  title,
  onClose,
  readSaved,
  onAcceptSaved,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  readSaved: () => Promise<SavedReview>;
  onAcceptSaved?: () => void;
}) {
  const [fields, setFields] = useState<SavedReview | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const version = useRef(0);
  const keepInput = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    version.current++;
    setFields(null);
    setError('');
    setLoading(false);
    const focus = open ? requestAnimationFrame(() => keepInput.current?.focus()) : null;
    return () => {
      version.current++;
      if (focus !== null) cancelAnimationFrame(focus);
    };
  }, [open]);
  async function review() {
    const request = ++version.current;
    setLoading(true);
    setError('');
    try {
      const saved = await readSaved();
      if (request === version.current) setFields(saved);
    } catch (caught) {
      if (request === version.current)
        setError(caught instanceof Error ? caught.message : '저장본을 확인하지 못했어요.');
    } finally {
      if (request === version.current) setLoading(false);
    }
  }
  return (
    <Dialog open={open} title={title} variant="confirmation" role="alertdialog" onClose={onClose}>
      <p>다른 곳에서 저장 내용이 바뀌었어요. 현재 입력은 그대로 남아 있어요.</p>
      <p className="muted">저장본을 확인한 뒤 계속 편집할 수 있어요.</p>
      {fields && (
        <section aria-label="현재 저장본" className="settings-group-body saved-version-review">
          <h3>현재 저장본</h3>
          {Array.isArray(fields)
            ? fields.map((field) => (
                <div className="settings-row" key={field.label}>
                  <span className="settings-row-copy">{field.label}</span>
                  <span className="settings-row-control">{field.value || '없음'}</span>
                </div>
              ))
            : fields.content}
        </section>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        <button
          type="button"
          className="secondary"
          disabled={loading}
          aria-busy={loading}
          onClick={() => void review()}
        >
          {loading ? '저장본 확인 중…' : '저장본 확인'}
        </button>
        {fields && onAcceptSaved && (
          <button
            type="button"
            className="secondary"
            disabled={loading}
            onClick={() => {
              onAcceptSaved();
              onClose();
            }}
          >
            저장본 확인 완료
          </button>
        )}
        <button ref={keepInput} type="button" className="primary" onClick={onClose}>
          현재 입력 유지
        </button>
      </div>
    </Dialog>
  );
}
