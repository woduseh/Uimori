import { useI18n, translateMessage } from './i18n.js';
import { Check, Languages, Square, Undo2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { INPUT_TRANSLATION_LANGUAGES } from '../core/input-translation.js';
import type { InputTranslationState } from './useInputTranslation.js';
import { LoadingState } from './LoadingState.js';
import './input-translation.css';
import './activity-status.css';

type Props = { translation: InputTranslationState; disabled: boolean };
export function InputTranslationControls({
  translation,
  disabled,
  empty,
}: Props & { empty: boolean }) {
  const { t } = useI18n();
  const languageMenu = useRef<HTMLDetailsElement>(null);
  const languageTrigger = useRef<HTMLElement>(null);
  const [languageMenuOpen, setLanguageMenuOpen] = useState(false);
  useEffect(() => {
    if (!languageMenuOpen) return;
    const outside = (event: PointerEvent) => {
      const menu = languageMenu.current;
      if (menu && !menu.contains(event.target as Node)) menu.open = false;
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [languageMenuOpen]);
  const current =
    INPUT_TRANSLATION_LANGUAGES.find((language) => language.code === translation.language) ??
    INPUT_TRANSLATION_LANGUAGES[0];
  return (
    <div
      className="input-translation-controls"
      role="group"
      aria-label={t('prompts.uiInputTranslationTools')}
    >
      <button
        type="button"
        className="input-translation-button"
        aria-label={
          translation.busy ? t('prompts.uiCancelInputTranslation') : t('prompts.uiTranslateInput')
        }
        title={
          translation.busy
            ? t('prompts.uiCancelInputTranslation')
            : t('prompts.uiTranslateInputWithoutSendingItAutomatically')
        }
        disabled={!translation.busy && (disabled || empty)}
        onClick={() => {
          if (translation.busy) translation.cancel();
          else void translation.translate();
        }}
      >
        {translation.busy ? (
          <Square size={15} aria-hidden="true" />
        ) : (
          <Languages size={17} aria-hidden="true" />
        )}
        <span>{translation.busy ? t('prompts.uiCancel') : t('prompts.uiTranslation')}</span>
      </button>
      <label className="input-translation-language-desktop">
        <span className="sr-only">{t('prompts.uiInputTranslationLanguage')}</span>
        <select
          aria-label={t('prompts.uiInputTranslationLanguage')}
          value={translation.language}
          disabled={disabled}
          onChange={(event) => translation.changeLanguage(event.target.value)}
        >
          {INPUT_TRANSLATION_LANGUAGES.map((language) => (
            <option key={language.code} value={language.code}>
              {t(`prompts.language.${language.code}`)}
            </option>
          ))}
        </select>
      </label>
      <details
        ref={languageMenu}
        className="input-translation-language-mobile"
        onToggle={(event) => setLanguageMenuOpen(event.currentTarget.open)}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false;
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || !event.currentTarget.open) return;
          event.preventDefault();
          event.stopPropagation();
          event.currentTarget.open = false;
          languageTrigger.current?.focus();
        }}
      >
        <summary
          ref={languageTrigger}
          aria-label={t('prompts.inputLanguageNamed', {
            name: t(`prompts.language.${current.code}`),
          })}
          title={t('prompts.inputLanguageNamed', { name: t(`prompts.language.${current.code}`) })}
        >
          {current.code.toUpperCase()}
        </summary>
        <div
          className="input-translation-language-menu"
          role="group"
          aria-label={t('prompts.uiSelectInputTranslationLanguage')}
        >
          {INPUT_TRANSLATION_LANGUAGES.map((language) => (
            <button
              key={language.code}
              type="button"
              aria-pressed={translation.language === language.code}
              disabled={disabled}
              onClick={(event) => {
                translation.changeLanguage(language.code);
                event.currentTarget.closest('details')?.removeAttribute('open');
                languageTrigger.current?.focus();
              }}
            >
              {t(`prompts.language.${language.code}`)}
              {translation.language === language.code && <Check size={16} aria-hidden="true" />}
            </button>
          ))}
        </div>
      </details>
    </div>
  );
}

export function InputTranslationFeedback({ translation, disabled }: Props) {
  const { t } = useI18n();
  if (
    !translation.busy &&
    translation.original === null &&
    !translation.candidate &&
    !translation.error
  )
    return null;
  return (
    <section
      className="input-translation-feedback"
      aria-label={t('prompts.uiInputTranslationStatus')}
    >
      {translation.busy && (
        <LoadingState
          presentation="placeholder"
          label={t('prompts.uiTranslatingYourInputYouCanKeepEditing')}
        />
      )}
      {translation.original !== null && (
        <div className="input-translation-original">
          <details>
            <summary>{t('prompts.uiViewOriginalInput')}</summary>
            <pre>{translation.original}</pre>
          </details>
          <button
            type="button"
            className="link-button"
            disabled={disabled}
            onClick={translation.restore}
          >
            <Undo2 size={14} aria-hidden="true" />
            {t('prompts.uiUndo')}
          </button>
        </div>
      )}
      {translation.candidate && (
        <details className="input-translation-candidate" open>
          <summary>{t('prompts.uiEarlierDraftTranslationCurrentInputPreserved')}</summary>
          <pre>{translation.candidate.text}</pre>
          <details>
            <summary>{t('prompts.uiDraftUsedForTranslation')}</summary>
            <pre>{translation.candidate.source}</pre>
          </details>
          <div className="input-translation-candidate-actions">
            <button
              type="button"
              className="link-button"
              disabled={disabled}
              onClick={translation.applyCandidate}
            >
              {t('prompts.uiReplaceInputWithThisTranslation')}
            </button>
            <button type="button" className="link-button" onClick={translation.dismissCandidate}>
              {t('prompts.uiClose')}
            </button>
          </div>
        </details>
      )}
      {translation.error && (
        <p className="error" role="alert">
          {t('prompts.inputErrorKept', { error: translateMessage(translation.error) })}
        </p>
      )}
    </section>
  );
}
