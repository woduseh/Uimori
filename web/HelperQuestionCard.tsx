import { CircleHelp } from 'lucide-react';
import type { HelperQuestion } from '../core/helper.js';
import { t, useI18n } from './i18n.js';

export function HelperQuestionCard({
  question,
  open,
  disabled,
  onAnswer,
}: {
  question: HelperQuestion;
  open: boolean;
  disabled: boolean;
  onAnswer?: (choice: string) => void;
}) {
  useI18n();
  return (
    <div
      className="helper-question-card"
      data-state={open ? 'open' : 'answered'}
      data-testid="helper-question-card"
      role="group"
      aria-label={t('helperQuestion.title')}
    >
      <p className="helper-question-title">
        <CircleHelp size={16} aria-hidden="true" />
        <strong>{question.question}</strong>
      </p>
      <div className="helper-question-options">
        {question.options.map((option) => (
          <button
            key={option.label}
            type="button"
            className="secondary helper-question-option"
            disabled={!open || disabled || !onAnswer}
            onClick={() => onAnswer?.(option.label)}
          >
            <span className="helper-question-option-label">{option.label}</span>
            {option.description && (
              <small className="helper-question-option-desc">{option.description}</small>
            )}
          </button>
        ))}
      </div>
      {open ? (
        question.allowFreeform && (
          <p className="helper-result-note">{t('helperQuestion.freeformHint')}</p>
        )
      ) : (
        <p className="helper-result-note">{t('helperQuestion.answered')}</p>
      )}
    </div>
  );
}
