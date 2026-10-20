import { t, useI18n, translateMessage } from './i18n.js';
import { useEffect, useRef, useState } from 'react';
import type { Asset } from '../core/product.js';
import { api } from './api.js';
import { LoadingState } from './LoadingState.js';
import { NoticeBanner } from './NoticeBanner.js';

/** Small local form: changing metadata never uploads or recompresses an image. */
export function AssetMetadataEditor({
  asset,
  onSaved,
}: {
  asset: Asset;
  onSaved: () => Promise<void>;
}) {
  useI18n();
  const [draft, setDraft] = useState(asset);
  const accepted = useRef(asset);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    // Refresh pristine fields, while an edited draft keeps its original CAS revision.
    if (
      busy ||
      asset.revision <= accepted.current.revision ||
      draft.title !== accepted.current.title ||
      draft.description !== accepted.current.description
    )
      return;
    accepted.current = asset;
    setDraft(asset);
    setError('');
  }, [asset, busy, draft.title, draft.description]);
  return (
    <details aria-busy={busy}>
      <summary>{t('library.editNameAndDescription')}</summary>
      <label>
        {t('library.imageName')}
        <input
          aria-label={t('library.uploadedImageName')}
          disabled={busy}
          value={draft.title}
          maxLength={200}
          onChange={(event) => setDraft({ ...draft, title: event.target.value })}
        />
      </label>
      <label>
        {t('library.descriptionOptional')}
        <textarea
          aria-label={t('library.uploadedImageDescription')}
          disabled={busy}
          value={draft.description}
          maxLength={2000}
          onChange={(event) => setDraft({ ...draft, description: event.target.value })}
        />
      </label>
      <small>{t('library.savedChangesApplyToTheNextAutomatic')}</small>
      <button
        type="button"
        className="primary"
        disabled={busy || !draft.title.trim()}
        onClick={async () => {
          setBusy(true);
          setError('');
          try {
            const saved = await api<Asset>(
              `/chats/${asset.chatId}/assets/${asset.id}`,
              {
                expectedRevision: draft.revision,
                title: draft.title,
                description: draft.description,
              },
              'PATCH'
            );
            accepted.current = saved;
            setDraft(saved);
            await onSaved();
          } catch (caught) {
            setError((caught as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {t('library.saveImageInformation')}
      </button>
      {busy && <LoadingState presentation="inline" label={t('library.savingImageInformation')} />}
      {error && <NoticeBanner tone="error">{translateMessage(error)}</NoticeBanner>}
    </details>
  );
}
