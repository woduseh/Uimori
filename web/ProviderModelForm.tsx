import { t, useI18n } from './i18n.js';
import type { ReactNode, RefObject, Dispatch, SetStateAction } from 'react';
import { NoticeBanner } from './NoticeBanner.js';
import type { LibraryConnection, ModelPreset, VertexRequestTier } from '../core/product.js';
import { modelHints } from '../core/model-hints.js';
import { ProviderCatalogPicker } from './ProviderCatalogPicker.js';
import { useConnectionCatalog } from './connection-catalog.js';
import { ProviderModelFields } from './ProviderModelFields.js';
import { selectModelConnection, type ModelDraft } from './provider-model-draft.js';
import type { ProviderEditorState } from './provider-editor-state.js';
import { IconButton } from './IconButton.js';
import { SaveButton } from './SaveButton.js';
import { CloseIcon } from './ui-icons.js';

type Props = {
  hidden: boolean;
  draft: ProviderEditorState['model'];
  models: ModelPreset[];
  modelConnections: LibraryConnection[];
  conflict: boolean;
  busy: boolean;
  saving: boolean;
  forcedVertexTier?: VertexRequestTier;
  modelSection: 'basic' | 'advanced';
  onSectionChange: (section: 'basic' | 'advanced') => void;
  formRef: RefObject<HTMLFormElement | null>;
  onChange: Dispatch<SetStateAction<ModelDraft>>;
  onSubmit: () => Promise<boolean>;
  onReload: () => void;
  onDone: () => void;
  onCatalog: (connection: LibraryConnection) => void;
  deleteAction: ReactNode;
};
export function ProviderModelForm({
  hidden,
  draft,
  models,
  modelConnections,
  conflict,
  busy,
  saving,
  forcedVertexTier,
  modelSection,
  onSectionChange,
  formRef,
  onChange,
  onSubmit,
  onReload,
  onDone,
  onCatalog,
  deleteAction,
}: Props) {
  useI18n();
  const { value: model, editing: editingModel, baseline: modelBaseline } = draft;
  const { connection: chosen, ...catalogState } = useConnectionCatalog(
    modelConnections.find((connection) => connection.id === model.connectionRef),
    !hidden
  );
  const savedModel = editingModel && models.find((item) => item.id === editingModel.id);
  const deletedModel = !!editingModel && !savedModel;
  const staleModel = !!savedModel && savedModel.revision !== editingModel?.revision;
  const reloadButton = editingModel && (
    <button
      type="button"
      className="secondary"
      disabled={busy}
      onClick={() => {
        onReload();
      }}
    >
      {t('providers.m280')}
    </button>
  );
  return (
    <form
      hidden={hidden}
      ref={formRef}
      className="editor-grid provider-management-form"
      aria-label={t('providers.m275')}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void onSubmit();
      }}
    >
      {editingModel && (
        <h3 className="full">
          {t('providers.m276')}
          {JSON.stringify(model) !== modelBaseline && (
            <small className="provider-heading-status">{t('settings.unsavedItem')}</small>
          )}
        </h3>
      )}
      {deletedModel ? (
        <NoticeBanner tone="error" className="full">
          {t('providers.modelDeletedElsewhere')}
        </NoticeBanner>
      ) : conflict ? (
        <NoticeBanner tone="error" className="full" actions={reloadButton}>
          {t('providers.m282')}
        </NoticeBanner>
      ) : (
        staleModel && (
          <div className="provider-draft-note full">
            <p>{t('providers.m279')}</p>
            {reloadButton}
          </div>
        )
      )}
      <div className="provider-model-tabs full" aria-label={t('providers.m283')}>
        {(['basic', 'advanced'] as const).map((section, index) => (
          <button
            type="button"
            className={modelSection === section ? 'selected' : 'secondary'}
            aria-pressed={modelSection === section}
            key={section}
            onClick={() => onSectionChange(section)}
          >
            {[t('providers.m284'), t('providers.m285')][index]}
          </button>
        ))}
      </div>
      <fieldset className="editor-fields full" disabled={busy}>
        <div className="provider-model-section full" hidden={modelSection !== 'basic'}>
          <h4 className="provider-field-heading full">{t('providers.m286')}</h4>
          <label className="full">
            {t('providers.m49')}
            <input
              aria-label={t('providers.m49')}
              required
              maxLength={160}
              value={model.title}
              onChange={(event) => onChange({ ...model, title: event.target.value })}
            />
          </label>
          <label className="full">
            {t('providers.m57')}
            <select
              aria-label={t('providers.m57')}
              required
              value={model.connectionRef}
              onChange={(event) => {
                const item = modelConnections.find((item) => item.id === event.target.value);
                if (item) onChange((value) => selectModelConnection(value, item));
                else onChange({ ...model, connectionRef: '' });
              }}
            >
              <option value="">{t('providers.m87')}</option>
              {model.connectionRef && !chosen && (
                <option value={model.connectionRef} disabled>
                  {t('providers.m116')}
                </option>
              )}
              {modelConnections.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title}
                  {item.enabled ? '' : t('providers.m120')}
                </option>
              ))}
            </select>
          </label>
          {chosen && !chosen.enabled && (
            <p className="provider-draft-note full">{t('providers.m287')}</p>
          )}
          <ProviderCatalogPicker
            key={chosen?.id}
            connection={chosen}
            selectedId={model.modelId}
            busy={busy}
            catalogState={catalogState}
            onRefresh={onCatalog}
            onChoose={(item) =>
              onChange((current) => {
                const hints = chosen ? modelHints(chosen, item.id, current.modelFamily) : undefined;
                return {
                  ...current,
                  modelId: item.id,
                  title:
                    !current.title ||
                    current.title === current.modelId ||
                    current.title ===
                      chosen?.catalog.find((entry) => entry.id === current.modelId)?.name
                      ? item.name
                      : current.title,
                  ...(hints?.maxOutputTokens !== undefined
                    ? { maxOutputTokens: String(hints.maxOutputTokens) }
                    : {}),
                  ...(hints?.inputTokenLimit !== undefined
                    ? { inputTokenLimit: String(hints.inputTokenLimit) }
                    : {}),
                };
              })
            }
          />
        </div>
        <ProviderModelFields
          section={modelSection}
          session={`${editingModel?.id ?? ''}:${modelBaseline}`}
          value={model}
          onChange={onChange}
          connection={chosen}
          forcedVertexTier={forcedVertexTier}
        />
      </fieldset>
      <div className="provider-actions full provider-save-actions provider-model-save-actions">
        {editingModel && deleteAction}
        <IconButton
          icon={CloseIcon}
          label={t('providers.m290')}
          disabled={busy}
          onClick={() => onDone()}
        />
        <SaveButton
          label={editingModel ? t('providers.m291') : t('providers.m278')}
          text={editingModel ? t('shared.save') : t('library.register')}
          disabled={busy || !chosen}
          aria-busy={saving}
        />
      </div>
    </form>
  );
}
