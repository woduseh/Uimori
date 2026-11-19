import { Check } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Dialog } from './Dialog.js';
import { t, useI18n } from './i18n.js';
import './illustration-appearance.css';

export type ImageChoice = {
  id: string;
  title: string;
  description?: string;
  url: string;
  disabled?: boolean;
};

export function ImageChoiceDialog({
  open,
  images,
  selectedId,
  onChoose,
  onClose,
}: {
  open: boolean;
  images: ImageChoice[];
  selectedId?: string;
  onChoose: (id: string) => void;
  onClose: () => void;
}) {
  useI18n();
  const [query, setQuery] = useState('');
  useEffect(() => {
    if (open) setQuery('');
  }, [open]);
  const found = images.filter((image) =>
    `${image.title} ${image.description ?? ''}`
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase())
  );
  return (
    <Dialog open={open} title={t('visuals.chooseReferenceImage')} onClose={onClose}>
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
            aria-pressed={selectedId === image.id}
            disabled={image.disabled}
            onClick={() => {
              onChoose(image.id);
              onClose();
            }}
          >
            <img src={image.url} alt="" loading="lazy" />
            <span>{image.title}</span>
            {selectedId === image.id && <Check size={18} aria-hidden="true" />}
          </button>
        ))}
        {!found.length && query && <p className="muted">{t('library.noSearchResults')}</p>}
      </div>
    </Dialog>
  );
}
