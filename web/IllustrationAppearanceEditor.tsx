import { ImagePlus, Plus, Trash2, Unlink } from 'lucide-react';
import { useState } from 'react';
import type { IllustrationAppearanceProfile } from '../core/illustration-profiles.js';
import type { PackageImage } from '../core/package-images.js';
import { IconButton } from './IconButton.js';
import { ImageChoiceDialog } from './ImageChoiceDialog.js';
import { NativeDeleteDialog } from './NativeDeleteDialog.js';
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
  const [removing, setRemoving] = useState<IllustrationAppearanceProfile | null>(null);
  const remove = (id: string) => onChange(value.filter((item) => item.id !== id));
  const edit = (id: string, change: Partial<IllustrationAppearanceProfile>) =>
    onChange(value.map((profile) => (profile.id === id ? { ...profile, ...change } : profile)));
  const selected = value.find((profile) => profile.id === picking);
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
                onClick={() => setPicking(profile.id)}
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
              onClick={() =>
                profile.name.trim() || profile.appearance.trim() || profile.referenceImageId
                  ? setRemoving(profile)
                  : remove(profile.id)
              }
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
      <ImageChoiceDialog
        open={!!selected}
        images={images.map((image) => ({
          id: image.id,
          title: image.title,
          description: image.description,
          url: `/api/package-image-blobs/${image.blobHash}`,
        }))}
        selectedId={selected?.referenceImageId}
        onChoose={(id) => {
          if (selected) edit(selected.id, { referenceImageId: id });
        }}
        onClose={() => setPicking(null)}
      />
      <NativeDeleteDialog
        target={removing ? removing.name.trim() || t('visuals.characterName') : null}
        action={t('visuals.removeCharacterProfile')}
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          if (removing) remove(removing.id);
          setRemoving(null);
        }}
      />
    </section>
  );
}
