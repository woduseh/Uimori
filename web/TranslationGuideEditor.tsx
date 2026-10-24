import { t, useI18n } from './i18n.js';
import { Plus, Trash2, Languages } from 'lucide-react';
import { IconButton } from './IconButton.js';
import { TRANSLATION_GUIDE_LIMITS, type TranslationGuide } from '../core/translation-guide.js';
import './translation-guide.css';

export function TranslationGuideEditor({
  value,
  onChange,
}: {
  value: TranslationGuide;
  onChange: (value: TranslationGuide) => void;
}) {
  useI18n();
  const term = (index: number, change: Partial<TranslationGuide['terms'][number]>) =>
    onChange({
      ...value,
      terms: value.terms.map((item, i) => (i === index ? { ...item, ...change } : item)),
    });
  return (
    <section
      className="translation-guide-editor"
      aria-label={t('library.botTranslationGuideEditor')}
    >
      <div className="translation-guide-intro">
        <Languages size={22} aria-hidden="true" />
        <div>
          <h3>{t('library.translationGuideWhenUsedAsABot')}</h3>
          <p>{t('library.addThisWorkSTerminologyAndVoice')}</p>
        </div>
      </div>
      <label>
        {t('library.voiceAddressAndStyleInstructions')}
        <textarea
          aria-label={t('library.botTranslationGuide')}
          rows={6}
          placeholder={t('library.exampleMiraUsuallySpeaksCalmlyAndAddresses')}
          value={value.instructions}
          maxLength={TRANSLATION_GUIDE_LIMITS.instructions}
          onChange={(e) => onChange({ ...value, instructions: e.target.value })}
        />
      </label>
      <div className="translation-guide-terms-heading">
        <div>
          <h3>{t('library.namesAndTerminology')}</h3>
          <p className="muted">{t('library.theTranslationModelUsesTerminologyAndConditions')}</p>
        </div>
        <button
          type="button"
          className="secondary"
          disabled={value.terms.length >= TRANSLATION_GUIDE_LIMITS.terms}
          onClick={() =>
            onChange({ ...value, terms: [...value.terms, { source: '', target: '' }] })
          }
        >
          <Plus size={16} aria-hidden="true" />
          {t('library.addTerm')}
        </button>
      </div>
      <div className="translation-guide-terms">
        {value.terms.map((item, index) => (
          <fieldset className="translation-guide-term" key={index}>
            <legend>{t('library.termNumber', { number: index + 1 })}</legend>
            <label>
              {t('library.originalTerm')}
              <input
                aria-label={t('library.termOriginal', { v0: index + 1 })}
                value={item.source}
                maxLength={TRANSLATION_GUIDE_LIMITS.term}
                placeholder="Mira"
                onChange={(e) => term(index, { source: e.target.value })}
              />
            </label>
            <label>
              {t('library.preferredTerm')}
              <input
                aria-label={t('library.termTranslation', { v0: index + 1 })}
                value={item.target}
                maxLength={TRANSLATION_GUIDE_LIMITS.term}
                placeholder={t('library.mira')}
                onChange={(e) => term(index, { target: e.target.value })}
              />
            </label>
            <label className="translation-guide-term-note">
              <span>
                {t('library.conditionsOrDescription')}{' '}
                <span className="muted">{t('library.optional')}</span>
              </span>
              <input
                aria-label={t('library.termConditionsOrDescription', { v0: index + 1 })}
                value={item.note ?? ''}
                maxLength={TRANSLATION_GUIDE_LIMITS.note}
                placeholder={t('library.applyOnlyWhenUsedAsAPerson')}
                onChange={(e) => term(index, { note: e.target.value })}
              />
            </label>
            <IconButton
              type="button"
              className="ghost translation-guide-term-delete"
              icon={Trash2}
              size={16}
              label={t('library.deleteTerm', { v0: index + 1 })}
              onClick={() =>
                onChange({ ...value, terms: value.terms.filter((_, i) => i !== index) })
              }
            />
          </fieldset>
        ))}
      </div>
      <details className="translation-guide-preview">
        <summary>{t('library.previewInstructionsSentToTranslation')}</summary>
        <p className="muted">{t('library.thisPreviewsCurrentEditsSaveChangesTo')}</p>
        <pre>{JSON.stringify(value, null, 2)}</pre>
      </details>
    </section>
  );
}
