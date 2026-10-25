import { t, useI18n, translateMessage } from './i18n.js';
import { Switch } from './BooleanControls.js';
import { Prose } from './Prose.js';
import {
  DEFAULT_READABILITY,
  QUOTE_PAIRS,
  type ReadabilitySettings as ReadingStyle,
  type QuoteRole,
} from './reading-preferences.js';
import './reading.css';
import './settings-layout.css';
import { readingSample, readingSampleCredit } from './reading-sample.js';
const preset = (name: string): ReadingStyle => ({
  ...DEFAULT_READABILITY,
  ...(name === 'dialogue' ? { emphasis: 'subtle', dialogueBreaks: true } : {}),
  ...(name === 'relaxed' ? { lineHeight: 2.2, paragraphSpacing: 1.5 } : {}),
});
function currentPreset(value: ReadingStyle) {
  return (
    ['default', 'relaxed', 'dialogue'].find((name) => {
      const expected = preset(name);
      return (
        value.emphasis === expected.emphasis &&
        value.dialogueBreaks === expected.dialogueBreaks &&
        value.thoughtBreaks === expected.thoughtBreaks &&
        value.lineHeight === expected.lineHeight &&
        value.paragraphSpacing === expected.paragraphSpacing
      );
    }) ?? 'custom'
  );
}

export function ReadabilitySettings({
  value,
  onChange,
}: {
  value: ReadingStyle;
  onChange: (value: ReadingStyle) => void;
}) {
  useI18n();
  return (
    <section className="reading-settings" aria-label={t('reader.readingStyleSettings')}>
      <section
        className="settings-group reading-settings-group"
        aria-label={t('reader.styleAndSpacing')}
      >
        <header className="settings-group-heading">
          <h4>{t('reader.readingStyle')}</h4>
        </header>
        <div className="settings-group-body reading-settings-rows">
          <label>
            {t('reader.style')}
            <select
              aria-label={t('reader.readingStyle')}
              data-reading-setting="style"
              value={currentPreset(value)}
              onChange={(event) =>
                onChange({ ...preset(event.target.value), quoteRoles: value.quoteRoles })
              }
            >
              <option value="default">{t('reader.default')}</option>
              <option value="relaxed">{t('reader.relaxed')}</option>
              <option value="dialogue">{t('reader.dialogueFocused')}</option>
              <option value="custom" disabled>
                {t('reader.custom')}
              </option>
            </select>
          </label>
          <label>
            {t('reader.quoteEmphasis')}
            <select
              aria-label={t('reader.quoteEmphasis')}
              data-reading-setting="emphasis"
              value={value.emphasis}
              onChange={(event) =>
                onChange({ ...value, emphasis: event.target.value as ReadingStyle['emphasis'] })
              }
            >
              <option value="off">{t('reader.off')}</option>
              <option value="subtle">{t('reader.subtle')}</option>
              <option value="strong">{t('reader.strong')}</option>
            </select>
          </label>
          <div className="reading-spacing">
            <label>
              {t('reader.lineSpacing')}
              <select
                aria-label={t('reader.lineSpacing')}
                data-reading-setting="line-spacing"
                value={value.lineHeight ?? 'default'}
                onChange={(event) =>
                  onChange({
                    ...value,
                    lineHeight:
                      event.target.value === 'default' ? null : Number(event.target.value),
                  })
                }
              >
                <option value="default">{t('reader.default')}</option>
                <option value="1.6">{t('reader.tight')}</option>
                <option value="1.9">{t('reader.normal')}</option>
                <option value="2.2">{t('reader.relaxed')}</option>
              </select>
            </label>
            <label>
              {t('reader.paragraphSpacing')}
              <select
                aria-label={t('reader.paragraphSpacing')}
                data-reading-setting="paragraph-spacing"
                value={value.paragraphSpacing ?? 'default'}
                onChange={(event) =>
                  onChange({
                    ...value,
                    paragraphSpacing:
                      event.target.value === 'default' ? null : Number(event.target.value),
                  })
                }
              >
                <option value="default">{t('reader.default')}</option>
                <option value="0.5">{t('reader.narrow')}</option>
                <option value="1">{t('reader.normal')}</option>
                <option value="1.5">{t('reader.relaxed')}</option>
                <option value="2">{t('reader.wide')}</option>
              </select>
            </label>
          </div>
        </div>
      </section>

      <section
        className="settings-group reading-settings-group"
        aria-label={t('reader.readingAids')}
      >
        <header className="settings-group-heading">
          <div>
            <h4>{t('reader.readingAids')}</h4>
            <p>{t('reader.addParagraphSpacingAroundDialogueAndThoughtsTheOriginal')}</p>
          </div>
        </header>
        <div className="settings-group-body reading-settings-rows">
          <label className="settings-row settings-row-toggle">
            <span>{t('reader.dialogueLineBreaks')}</span>
            <span className="settings-row-control">
              <Switch
                data-reading-setting="dialogue"
                checked={value.dialogueBreaks}
                onChange={(event) => onChange({ ...value, dialogueBreaks: event.target.checked })}
              />
            </span>
          </label>
          <label className="settings-row settings-row-toggle">
            <span>{t('reader.thoughtLineBreaks')}</span>
            <span className="settings-row-control">
              <Switch
                data-reading-setting="thought"
                checked={value.thoughtBreaks}
                onChange={(event) => onChange({ ...value, thoughtBreaks: event.target.checked })}
              />
            </span>
          </label>
          <details className="reading-quote-settings">
            <summary data-reading-setting="punctuation">{t('reader.styleByPunctuation')}</summary>
            <p>{t('reader.stylesFollowPunctuationTheyDoNotDetermineTheActual')}</p>
            <div className="reading-quote-rules">
              {QUOTE_PAIRS.map(({ id, label }) => (
                <label key={id}>
                  {translateMessage(label)}
                  <select
                    aria-label={t('reader.valueStyle', { v0: translateMessage(label) })}
                    value={value.quoteRoles[id]}
                    onChange={(event) =>
                      onChange({
                        ...value,
                        quoteRoles: { ...value.quoteRoles, [id]: event.target.value as QuoteRole },
                      })
                    }
                  >
                    <option value="dialogue">{t('reader.dialogue')}</option>
                    <option value="thought">{t('reader.thought')}</option>
                    <option value="quote">{t('reader.generalQuote')}</option>
                    <option value="off">{t('reader.noProcessing')}</option>
                  </select>
                </label>
              ))}
            </div>
          </details>
        </div>
      </section>

      <section
        className="settings-group reading-settings-group reading-preview-group"
        aria-label={t('reader.preview')}
      >
        <header className="settings-group-heading">
          <h4>{t('reader.preview')}</h4>
        </header>
        <div className="reading-preview" aria-label={t('reader.readingStylePreview')}>
          <div className="prose" data-testid="reading-preview">
            <Prose text={readingSample} reading={value} />
            <small className="muted">{readingSampleCredit}</small>
          </div>
        </div>
      </section>

      <div className="reading-settings-footer">
        <small>{t('reader.appliesToRegularTextAndHelperContentBotCreated')}</small>
        <button
          type="button"
          data-reading-setting="reset"
          className="secondary"
          onClick={() => onChange(DEFAULT_READABILITY)}
        >
          {t('reader.resetReadingStyle')}
        </button>
      </div>
    </section>
  );
}
