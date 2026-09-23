import type { ReactNode, RefObject, Dispatch, SetStateAction } from 'react';
import type { Connection, ModelPreset, VertexRequestTier } from '../core/product.js';
import { modelHints } from '../core/model-hints.js';
import { ProviderCatalogPicker } from './ProviderCatalogPicker.js';
import { ProviderModelFields } from './ProviderModelFields.js';
import { selectModelConnection, updateModelId, type ModelDraft } from './provider-model-draft.js';
import type { ProviderEditorState } from './provider-editor-state.js';
import { IconButton } from './IconButton.js';
import { SaveButton } from './SaveButton.js';
import { CloseIcon } from './ui-icons.js';

type Props = {
  hidden: boolean;
  draft: ProviderEditorState['model'];
  models: ModelPreset[];
  modelConnections: Connection[];
  conflict: boolean;
  busy: boolean;
  forcedVertexTier?: VertexRequestTier;
  modelSection: 'basic' | 'advanced';
  onSectionChange: (section: 'basic' | 'advanced') => void;
  formRef: RefObject<HTMLFormElement | null>;
  onChange: Dispatch<SetStateAction<ModelDraft>>;
  onSubmit: () => Promise<boolean>;
  onReload: () => void;
  onDone: () => void;
  onCatalog: (connection: Connection) => void;
  deleteAction: ReactNode;
};
export function ProviderModelForm({
  hidden,
  draft,
  models,
  modelConnections,
  conflict,
  busy,
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
  const { value: model, editing: editingModel, copy: modelCopy, baseline: modelBaseline } = draft;
  const chosen = modelConnections.find((connection) => connection.id === model.connectionRef);
  return (
    <form
      hidden={hidden}
      ref={formRef}
      className="editor-grid provider-management-form"
      aria-label="모델 편집 양식"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void onSubmit();
      }}
    >
      <h3 className="full">
        {editingModel
          ? '모델 프리셋 수정'
          : modelCopy
            ? '모델 프리셋 복제 검토'
            : '모델 프리셋 등록'}
      </h3>
      {editingModel &&
        (conflict ||
          models.find((item) => item.id === editingModel.id)?.revision !==
            editingModel.revision) && (
          <div className="provider-draft-note full">
            {models.find((item) => item.id === editingModel.id)?.revision !==
              editingModel.revision && (
              <p>다른 곳에서 모델이 변경됐어요. 입력한 초안은 유지했어요.</p>
            )}
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => {
                onReload();
              }}
            >
              최신 모델 설정 불러오기
            </button>
          </div>
        )}
      {modelCopy && (
        <p className="provider-draft-note full">설정을 검토한 뒤 새 프리셋으로 저장해요.</p>
      )}
      {conflict && (
        <p className="error full" role="alert">
          다른 곳에서 모델이 변경됐어요. 초안은 유지했어요. 최신 설정을 불러와 주세요.
        </p>
      )}
      <div className="provider-model-tabs full" aria-label="모델 편집 항목">
        {(['basic', 'advanced'] as const).map((section, index) => (
          <button
            type="button"
            className={modelSection === section ? 'selected' : 'secondary'}
            aria-pressed={modelSection === section}
            key={section}
            onClick={() => onSectionChange(section)}
          >
            {['기본', '고급'][index]}
          </button>
        ))}
      </div>
      <fieldset className="editor-fields full" disabled={busy}>
        <div className="provider-model-section full" hidden={modelSection !== 'basic'}>
          <h4 className="provider-field-heading full">모델 선택</h4>
          <label className="full">
            모델 프리셋 이름
            <input
              aria-label="모델 프리셋 이름"
              required
              maxLength={160}
              value={model.title}
              onChange={(event) => onChange({ ...model, title: event.target.value })}
            />
          </label>
          <label className="full">
            프로바이더
            <select
              aria-label="프로바이더"
              required
              value={model.connectionRef}
              onChange={(event) => {
                const item = modelConnections.find((item) => item.id === event.target.value);
                if (item) onChange((value) => selectModelConnection(value, item));
                else onChange({ ...model, connectionRef: '' });
              }}
            >
              <option value="">프로바이더 선택</option>
              {model.connectionRef && !chosen && (
                <option value={model.connectionRef} disabled>
                  프로바이더 확인 필요
                </option>
              )}
              {modelConnections.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title}
                  {item.enabled ? '' : ' · 비활성'}
                </option>
              ))}
            </select>
          </label>
          {chosen && !chosen.enabled && (
            <p className="provider-draft-note full">
              비활성 프로바이더를 사용하는 모델은 새로 실행할 수 없어요. 프로바이더를 활성화하면
              다시 사용할 수 있어요.
            </p>
          )}
          <ProviderCatalogPicker
            key={chosen?.id}
            connection={chosen}
            selectedId={model.modelId}
            busy={busy}
            onRefresh={(item) => {
              onCatalog(item);
            }}
            onChoose={(item) =>
              onChange((current) => {
                // Picking from the list is an explicit choice: published limits prefill and stay editable.
                const selected = updateModelId(current, item.id);
                const hints = chosen
                  ? modelHints(chosen, item.id, selected.modelFamily)
                  : undefined;
                return {
                  ...selected,
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
          value={model}
          onChange={onChange}
          connection={chosen}
          forcedVertexTier={forcedVertexTier}
        />
      </fieldset>
      <div className="provider-actions full provider-save-actions provider-model-save-actions">
        {editingModel && deleteAction}
        <small className="provider-save-status">
          {editingModel
            ? JSON.stringify(model) === modelBaseline
              ? '저장한 모델 프리셋이에요.'
              : '아직 저장하지 않은 변경이 있어요.'
            : '아직 저장하지 않은 모델 프리셋이에요.'}
        </small>
        <IconButton
          icon={CloseIcon}
          label="모델 편집 끝내기"
          disabled={busy}
          onClick={() => onDone()}
        />
        {editingModel ? (
          <SaveButton label="모델 변경 저장" disabled={busy || !chosen} aria-busy={busy} />
        ) : (
          <button className="primary" disabled={busy || !chosen}>
            모델 프리셋 등록
          </button>
        )}
      </div>
    </form>
  );
}
