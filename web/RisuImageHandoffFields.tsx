import { useI18n } from './i18n.js';
import type { RisuImageHandoff } from '../core/risu-image-handoff.js';
import { SelectionCheckbox } from './BooleanControls.js';

export function RisuImageHandoffFields({
  policy,
  selected,
  onChange,
  disabled = false,
}: {
  policy: RisuImageHandoff;
  selected: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();

  return (
    <details className="full risu-import-preview">
      <summary>{t('native.handoffSummary', { count: policy.ranges.length })}</summary>
      <p className="muted">
        {t('native.handoffDescription', { tags: policy.tagTemplates.join(', ') })}
      </p>
      {!policy.ranges.length && <p>{t('native.text_0725ff9528')}</p>}
      {policy.ranges.map((range) => (
        <details key={range.id}>
          <summary>
            {range.field}: {range.start}–{range.end}
            {range.confidence === 'candidate'
              ? t('native.text_baf852faae')
              : t('native.text_7069bd6597')}
          </summary>
          <pre style={{ whiteSpace: 'pre-wrap', maxHeight: 280, overflow: 'auto' }}>
            {range.text}
          </pre>
          <label>
            <SelectionCheckbox
              disabled={disabled}
              checked={selected.includes(range.id)}
              onChange={(event) =>
                onChange(
                  event.target.checked
                    ? [...selected, range.id]
                    : selected.filter((id) => id !== range.id)
                )
              }
            />{' '}
            {t('native.text_01aca5a6d5')}
          </label>
        </details>
      ))}
    </details>
  );
}
