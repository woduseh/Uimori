import { t, useI18n } from './i18n.js';
import { Plus, Trash2 } from 'lucide-react';
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
        </div>
        <IconButton
          className="secondary"
          icon={Plus}
          size={18}
          label={t('library.addTerm')}
          disabled={value.terms.length >= TRANSLATION_GUIDE_LIMITS.terms}
          onClick={() =>
            onChange({ ...value, terms: [...value.terms, { source: '', target: '' }] })
          }
        />
      </div>
      {value.terms.length > 0 && (
        <div className="translation-guide-terms">
          <div className="translation-guide-term-columns" aria-hidden="true">
            <span>{t('library.originalTerm')}</span>
            <span>{t('library.preferredTerm')}</span>
            <span>{t('library.conditionsOrDescription')}</span>
          </div>
          {value.terms.map((item, index) => (
            <div
              className="translation-guide-term"
              role="group"
              aria-label={t('library.termNumber', { number: index + 1 })}
              key={index}
            >
              <input
                aria-label={t('library.termOriginal', { v0: index + 1 })}
                value={item.source}
                maxLength={TRANSLATION_GUIDE_LIMITS.term}
                placeholder="Mira"
                onChange={(e) => term(index, { source: e.target.value })}
              />
              <input
                aria-label={t('library.termTranslation', { v0: index + 1 })}
                value={item.target}
                maxLength={TRANSLATION_GUIDE_LIMITS.term}
                placeholder={t('library.mira')}
                onChange={(e) => term(index, { target: e.target.value })}
              />
              <input
                className="translation-guide-term-note"
                aria-label={t('library.termConditionsOrDescription', { v0: index + 1 })}
                value={item.note ?? ''}
                maxLength={TRANSLATION_GUIDE_LIMITS.note}
                placeholder={t('library.applyOnlyWhenUsedAsAPerson')}
                onChange={(e) => term(index, { note: e.target.value })}
              />
              <IconButton
                type="button"
                className="ghost"
                icon={Trash2}
                size={16}
                label={t('library.deleteTerm', { v0: index + 1 })}
                onClick={() =>
                  onChange({ ...value, terms: value.terms.filter((_, i) => i !== index) })
                }
              />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
