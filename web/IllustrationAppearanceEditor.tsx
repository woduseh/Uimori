import { Check, ImagePlus, Plus, Trash2, Unlink } from 'lucide-react';
import { useState } from 'react';
import type { IllustrationAppearanceProfile } from '../core/illustration-profiles.js';
import type { PackageImage } from '../core/package-images.js';
import { Dialog } from './Dialog.js';
import { IconButton } from './IconButton.js';
import { t, useI18n } from './i18n.js';
import './illustration-appearance.css';

export function IllustrationAppearanceEditor({
  value,
  images,
  onChange,
}: {
  value: IllustrationAppearanceProfile[];
  images: PackageImage[];
  onChange: (value: IllustrationAppearanceProfile[]) => void;
}) {
  useI18n();
  const [picking, setPicking] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const edit = (id: string, change: Partial<IllustrationAppearanceProfile>) =>
    onChange(value.map((profile) => (profile.id === id ? { ...profile, ...change } : profile)));
  const selected = value.find((profile) => profile.id === picking);
  const found = images.filter((image) =>
    `${image.title} ${image.description}`
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase())
  );
  return (
    <section className="appearance-editor" aria-label={t('visuals.defaultAppearances')}>
      {value.map((profile) => {
        const image = images.find((item) => item.id === profile.referenceImageId);
        return (
          <div className="appearance-row" key={profile.id}>
            <div className="appearance-portrait">
              <button
                type="button"
                className="secondary appearance-image-picker"
                aria-label={t('visuals.chooseReferenceImage')}
                disabled={!images.length}
                onClick={() => {
                  setQuery('');
                  setPicking(profile.id);
                }}
              >
                {image ? (
                  <img src={`/api/package-image-blobs/${image.blobHash}`} alt={image.title} />
                ) : (
                  <ImagePlus size={24} aria-hidden="true" />
                )}
              </button>
              {profile.referenceImageId && (
                <IconButton
                  icon={Unlink}
                  label={t('visuals.unlinkReferenceImage')}
                  onClick={() => {
                    onChange(
                      value.map((item) => {
                        if (item.id !== profile.id) return item;
                        const next = { ...item };
                        delete next.referenceImageId;
                        return next;
                      })
                    );
                  }}
                />
              )}
            </div>
            <div className="appearance-fields">
              <label>
                {t('visuals.characterName')}
                <input
                  value={profile.name}
                  maxLength={200}
                  onChange={(event) => edit(profile.id, { name: event.target.value })}
                />
              </label>
              <label>
                {t('visuals.characterAppearance')}
                <textarea
                  rows={3}
                  value={profile.appearance}
                  maxLength={2000}
                  onChange={(event) => edit(profile.id, { appearance: event.target.value })}
                />
              </label>
            </div>
            <IconButton
              icon={Trash2}
              label={t('visuals.removeCharacterProfile')}
              onClick={() => onChange(value.filter((item) => item.id !== profile.id))}
            />
          </div>
        );
      })}
      <button
        type="button"
        className="appearance-add"
        disabled={value.length >= 32}
        onClick={() => onChange([...value, { id: crypto.randomUUID(), name: '', appearance: '' }])}
      >
        <Plus size={18} aria-hidden="true" />
        {t('visuals.addCharacterProfile')}
      </button>
      <Dialog
        open={!!selected}
        title={t('visuals.chooseReferenceImage')}
        onClose={() => setPicking(null)}
      >
        <input
          type="search"
          aria-label={t('library.searchImages')}
          placeholder={t('library.nameOrDescription')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.preventDefault();
          }}
        />
        <div className="appearance-image-choices">
          {found.map((image) => (
            <button
              type="button"
              className="secondary"
              key={image.id}
              aria-pressed={selected?.referenceImageId === image.id}
              onClick={() => {
                if (selected) edit(selected.id, { referenceImageId: image.id });
                setPicking(null);
              }}
            >
              <img src={`/api/package-image-blobs/${image.blobHash}`} alt="" loading="lazy" />
              <span>{image.title}</span>
              {selected?.referenceImageId === image.id && <Check size={18} aria-hidden="true" />}
            </button>
          ))}
          {!found.length && query && <p className="muted">{t('library.noSearchResults')}</p>}
        </div>
      </Dialog>
    </section>
  );
}
