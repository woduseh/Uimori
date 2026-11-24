import type { Ref } from 'react';
import { SOURCE_TEXT_MAX_CHARS as SUMMARY_MAX_CHARS } from '../core/content-limits.js';
import { t, useI18n } from './i18n.js';
import { NoticeBanner } from './NoticeBanner.js';
import { SaveButton } from './SaveButton.js';
import { CloseIcon } from './ui-icons.js';
import './context.css';

export function SummaryEditor({
  value,
  busy,
  conflict,
  conflictMessage,
  saveDisabled,
  rebaseDisabled,
  inputRef,
  onChange,
  onRebase,
  onCancel,
  onSave,
}: {
  value: string;
  busy: boolean;
  conflict: boolean;
  conflictMessage: string;
  saveDisabled: boolean;
  rebaseDisabled: boolean;
  inputRef?: Ref<HTMLTextAreaElement>;
  onChange: (value: string) => void;
  onRebase: () => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  useI18n();
  return (
    <form
      className="context-summary-editor"
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
    >
      {conflict && (
        <NoticeBanner
          tone="error"
          actions={
            <button
              type="button"
              className="secondary"
              disabled={rebaseDisabled}
              onClick={onRebase}
            >
              {t('settings.m304')}
            </button>
          }
        >
          {conflictMessage}
        </NoticeBanner>
      )}
      <label>
        {t('settings.m306')}
        <textarea
          ref={inputRef}
          rows={8}
          required
          maxLength={SUMMARY_MAX_CHARS}
          value={value}
          disabled={busy}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
      <div className="form-actions">
        <button type="button" className="secondary" disabled={busy} onClick={onCancel}>
          <CloseIcon size={18} aria-hidden="true" />
          {t('settings.m308')}
        </button>
        <SaveButton
          className="primary"
          label={t('settings.m307')}
          aria-busy={busy}
          disabled={saveDisabled}
        />
      </div>
    </form>
  );
}
