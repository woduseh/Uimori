import { Plus, Trash2 } from 'lucide-react';
import { IconButton } from './IconButton.js';
import { t, useI18n } from './i18n.js';
import type { IllustrationAppearanceProfile } from '../core/illustration-profiles.js';

export function IllustrationAppearanceEditor({
  value,
  onChange,
}: {
  value: IllustrationAppearanceProfile[];
  onChange: (value: IllustrationAppearanceProfile[]) => void;
}) {
  useI18n();
  const edit = (index: number, change: Partial<IllustrationAppearanceProfile>) =>
    onChange(value.map((profile, i) => (i === index ? { ...profile, ...change } : profile)));
  return (
    <section className="translation-guide-editor" aria-label={t('visuals.defaultAppearances')}>
      <h3>{t('visuals.defaultAppearances')}</h3>
      <p className="muted">{t('visuals.defaultAppearancesHelp')}</p>
      {value.map((profile, index) => (
        <div key={profile.id}>
          <label>
            {t('visuals.characterName')}
            <input
              value={profile.name}
              maxLength={200}
              onChange={(event) => edit(index, { name: event.target.value })}
            />
          </label>
          <label>
            {t('visuals.characterAppearance')}
            <textarea
              rows={3}
              value={profile.appearance}
              maxLength={2000}
              onChange={(event) => edit(index, { appearance: event.target.value })}
            />
          </label>
          <IconButton
            icon={Trash2}
            label={t('visuals.removeCharacterProfile')}
            onClick={() => onChange(value.filter((_, i) => i !== index))}
          />
        </div>
      ))}
      <IconButton
        icon={Plus}
        label={t('visuals.addCharacterProfile')}
        disabled={value.length >= 32}
        onClick={() => onChange([...value, { id: crypto.randomUUID(), name: '', appearance: '' }])}
      />
    </section>
  );
}
