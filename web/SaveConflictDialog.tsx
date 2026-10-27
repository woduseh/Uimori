import { t, translateMessage, useI18n, message as uiMessage } from './i18n.js';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Dialog } from './Dialog.js';
import { LoadingState } from './LoadingState.js';
import { NoticeBanner } from './NoticeBanner.js';
import './save-conflict-dialog.css';
import './settings-layout.css';

export type SavedSettingField = { label: string; value: string };
type SavedReview = SavedSettingField[] | { content: ReactNode; actions?: ReactNode };
type SavedReviewSource = SavedReview | (() => SavedReview);

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
  readSaved: () => Promise<SavedReviewSource>;
  onAcceptSaved?: () => void;
}) {
  useI18n();
  const [fields, setFields] = useState<SavedReviewSource | null>(null);
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
    setFields(null);
    setError('');
    try {
      const saved = await readSaved();
      if (request === version.current) setFields(() => saved);
    } catch (caught) {
      if (request === version.current)
        setError(caught instanceof Error ? caught.message : uiMessage('shared.savedFailure'));
    } finally {
      if (request === version.current) setLoading(false);
    }
  }
  const savedReview = typeof fields === 'function' ? fields() : fields;
  const reviewActions = savedReview && !Array.isArray(savedReview) ? savedReview.actions : null;
  const reviewContent = (
    <>
      <p>{t('shared.reviewPreserves')}</p>
      {savedReview && (
        <section
          aria-label={t('shared.currentSaved')}
          className="settings-group-body saved-version-review"
        >
          <h3>{t('shared.currentSaved')}</h3>
          {Array.isArray(savedReview)
            ? savedReview.map((field) => (
                <div className="settings-row" key={field.label}>
                  <span className="settings-row-copy">{field.label}</span>
                  <span className="settings-row-control">{field.value || t('shared.none')}</span>
                </div>
              ))
            : savedReview.content}
        </section>
      )}
      {loading && <LoadingState presentation="placeholder" label={t('shared.reviewLoading')} />}
      {error && <NoticeBanner tone="error">{translateMessage(error)}</NoticeBanner>}
    </>
  );
  return (
    <Dialog
      open={open}
      title={title}
      variant="confirmation"
      role="alertdialog"
      onClose={onClose}
      className={reviewActions ? 'saved-review-dialog' : ''}
    >
      {reviewActions ? <div className="saved-review-content">{reviewContent}</div> : reviewContent}
      <div className="form-actions">
        <button
          type="button"
          className="secondary"
          disabled={loading}
          aria-busy={loading}
          onClick={() => void review()}
        >
          {loading ? t('shared.reviewBusy') : t('shared.reviewSaved')}
        </button>
        {savedReview && onAcceptSaved && (
          <button
            type="button"
            className="secondary"
            disabled={loading}
            onClick={() => {
              onAcceptSaved();
              onClose();
            }}
          >
            {t('shared.reviewDone')}
          </button>
        )}
        {reviewActions ?? (
          <button ref={keepInput} type="button" className="primary" onClick={onClose}>
            {t('shared.keepInput')}
          </button>
        )}
      </div>
    </Dialog>
  );
}
