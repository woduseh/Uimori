import { ProviderConnectionForm } from './ProviderConnectionForm.js';
import { ProviderModelForm } from './ProviderModelForm.js';
import {
  initialProviderEditorState,
  providerEditorReducer,
  initialConnection,
  connectionDraft,
  connectionPayload,
  type ConnectionDraft,
} from './provider-editor-state.js';
import type { ModelDraft } from './provider-model-draft.js';
import { compareModelDisplayOrder } from '../core/model-order.js';
import { useSettingsSaveHandler, type SettingsSaveRegistration } from './useSettingsSaveHandler.js';
import {
  JEV_PROVIDER_DEFINITION,
  jevRegistered,
  type JevProviderStatus,
} from '../core/jev-provider.js';
import { DraftDiscardActions } from './DraftDiscardActions.js';
import { Dialog } from './Dialog.js';
import { useEffect, useRef, useState, useReducer, type SetStateAction } from 'react';
import { ActionMenu } from './ActionMenu.js';
import { IconButton } from './IconButton.js';
import {
  AddIcon,
  BackIcon,
  ConnectionIcon,
  CopyIcon,
  ForwardIcon,
  ModelIcon,
  PowerIcon,
  RefreshIcon,
  SearchIcon,
  UpIcon,
  DownIcon,
} from './ui-icons.js';
import type {
  Connection,
  Library,
  ModelPreset,
  ProviderProtocol,
  VertexRequestTier,
} from '../core/product.js';
import { PROVIDER_CHOICES, providerDefinition } from '../core/provider-definitions.js';
import { api, ApiError } from './api.js';
import {
  initialModel,
  modelDraft,
  modelDraftError,
  modelPayload,
  selectModelConnection,
} from './ProviderModelFields.js';
import { DeleteButton } from './DeleteButton.js';
import { ProviderModelTest, useProviderModelTests } from './ProviderModelTest.js';
import { JevProviderSettings } from './JevProviderSettings.js';
import './ProviderManagement.css';
import './settings-actions.css';

const versionRef = (item: { id: string; revision: number }) => `${item.id}@${item.revision}`;
const matches = (query: string, ...values: (string | undefined)[]) =>
  !query || values.some((value) => value?.toLocaleLowerCase().includes(query));

export function ConnectionEditor({
  library,
  reload,
  onError,
  onDirtyChange,
  onSaveHandlerChange,
}: {
  library: Library;
  reload: () => Promise<void>;
  onError: (error: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
  onSaveHandlerChange?: SettingsSaveRegistration;
}) {
  const modelTests = useProviderModelTests();
  const [forcedVertexTier, setForcedVertexTier] = useState<VertexRequestTier>();
  useEffect(() => {
    let current = true;
    void api<{ vertexRequestTier: VertexRequestTier | null }>('/health')
      .then((health) => {
        if (current && ['standard', 'flex'].includes(health.vertexRequestTier ?? ''))
          setForcedVertexTier(health.vertexRequestTier!);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, []);
  const [query, setQuery] = useState('');
  const [screen, setScreen] = useState<
    'models' | 'connections' | 'providers' | 'connection' | 'model' | 'jev'
  >('models');
  const [setup, setSetup] = useState(false);
  const [modelSection, setModelSection] = useState<'basic' | 'advanced'>('basic');
  const [expandedModelGroups, setExpandedModelGroups] = useState<Set<string>>(() => new Set());
  const heading = useRef<HTMLDivElement>(null);
  const returnItem = useRef<{ screen: 'models' | 'connections'; id: string } | undefined>(
    undefined
  );
  function navigate(next: typeof screen) {
    setDiscard(undefined);
    setScreen(next);
    requestAnimationFrame(() => {
      const selected = returnItem.current;
      const target =
        selected?.screen === next
          ? heading.current
              ?.closest('section')
              ?.querySelector<HTMLButtonElement>(
                `button[data-provider-id="${CSS.escape(selected.id)}"]`
              )
          : undefined;
      if (target?.checkVisibility()) {
        target.scrollIntoView({ block: 'nearest' });
        target.focus({ preventScroll: true });
        return;
      }
      heading.current?.scrollIntoView({ block: 'start' });
      heading.current?.focus({ preventScroll: true });
    });
  }

  const [drafts, dispatchDraft] = useReducer(
    providerEditorReducer,
    undefined,
    initialProviderEditorState
  );
  const {
    value: connection,
    editing: editingConnection,
    baseline: connectionBaseline,
    started: connectionStarted,
  } = drafts.connection;
  const {
    value: model,
    editing: editingModel,
    baseline: modelBaseline,
    started: modelStarted,
  } = drafts.model;
  const setConnection = (update: SetStateAction<ConnectionDraft>) =>
    dispatchDraft({ type: 'connection.change', update });
  const setModel = (update: SetStateAction<ModelDraft>) =>
    dispatchDraft({ type: 'model.change', update });
  const conflict = drafts.conflict;
  const setConflict = (kind: typeof conflict) => dispatchDraft({ type: 'conflict', kind });
  const [discard, setDiscard] = useState<{ kind: 'connection' | 'model'; proceed: () => void }>();
  function replaceDraft(kind: 'connection' | 'model', proceed: () => void) {
    const dirty =
      kind === 'connection'
        ? connectionStarted && JSON.stringify(connection) !== connectionBaseline
        : modelStarted && JSON.stringify(model) !== modelBaseline;
    if (dirty) setDiscard({ kind, proceed });
    else proceed();
  }
  const [uploadingCredential, setUploadingCredential] = useState(false);
  const [jevStatus, setJevStatus] = useState<JevProviderStatus | null>(null);
  const [jevListError, setJevListError] = useState(false);
  const [jevReturn, setJevReturn] = useState<'models' | 'connections'>('connections');
  const [jevListRefresh, setJevListRefresh] = useState(0);
  useEffect(() => {
    void jevListRefresh;
    const controller = new AbortController();
    void api<JevProviderStatus>('/provider-management/jev', undefined, 'GET', controller.signal)
      .then((status) => {
        if (!controller.signal.aborted) {
          setJevStatus(status);
          setJevListError(false);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setJevListError(true);
      });
    return () => controller.abort();
  }, [jevListRefresh]);
  const hasJev = jevRegistered(jevStatus);
  function openJev(from: 'models' | 'connections' = 'connections') {
    setJevReturn(from);
    navigate('jev');
  }
  const [jevDirty, setJevDirty] = useState(false);
  const [jevBusy, setJevBusy] = useState(false);
  const [operationBusy, setOperationBusy] = useState(false),
    [message, setMessage] = useState(''),
    [error, setError] = useState('');
  const busy = operationBusy || uploadingCredential || jevBusy;
  const dirty =
    busy ||
    jevDirty ||
    (connectionStarted && JSON.stringify(connection) !== connectionBaseline) ||
    (modelStarted && JSON.stringify(model) !== modelBaseline);
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  const setBusy = setOperationBusy;
  const [registeredModel, setRegisteredModel] = useState<ModelPreset>();
  const operationLock = useRef(false);
  const jevSave = useRef<(() => Promise<boolean>) | null>(null);
  const connectionForm = useRef<HTMLFormElement>(null);
  const modelForm = useRef<HTMLFormElement>(null);
  const chosen = library.connections.find((item) => item.id === model.connectionRef);
  const filter = query.trim().toLocaleLowerCase();
  function modelGroupOpen(groupKey: string) {
    return !!filter || expandedModelGroups.has(groupKey);
  }
  function toggleModelGroup(groupKey: string, open: boolean) {
    if (filter) return;
    setExpandedModelGroups((current) => {
      if (current.has(groupKey) === open) return current;
      const next = new Set(current);
      if (open) next.add(groupKey);
      else next.delete(groupKey);
      return next;
    });
  }
  const jevMatches =
    hasJev &&
    matches(
      query.toLocaleLowerCase(),
      JEV_PROVIDER_DEFINITION.label,
      JEV_PROVIDER_DEFINITION.modelLabel,
      JEV_PROVIDER_DEFINITION.modelId,
      '판단'
    );
  const connections = library.connections.filter((item) =>
    matches(filter, item.title, item.endpoint, providerDefinition(item.protocol).label)
  );
  const models = library.models.filter((item) =>
    matches(
      filter,
      item.title,
      item.modelId,
      library.connections.find((c) => c.id === item.connectionId)?.title
    )
  );
  const orderedModels = [...models].sort(compareModelDisplayOrder);
  const modelGroups: { connection?: Connection; models: ModelPreset[] }[] = library.connections
    .map((connection) => ({
      connection,
      models: orderedModels.filter((item) => item.connectionId === connection.id),
    }))
    .filter((group) => group.models.length > 0);
  const orphanedModels = orderedModels.filter(
    (item) => !library.connections.some((connection) => connection.id === item.connectionId)
  );
  if (orphanedModels.length) modelGroups.push({ models: orphanedModels });

  async function deletedConnection(item: Connection) {
    if (editingConnection?.id === item.id && screen === 'connection') navigate('connections');
    dispatchDraft({ type: 'connection.deleted', id: item.id });
    setError('');
    onError('');
    setMessage(item.title + ' 프로바이더를 삭제했어요.');
    await reload();
  }
  async function deletedModel(item: ModelPreset) {
    if (editingModel?.id === item.id && screen === 'model') navigate('models');
    dispatchDraft({ type: 'model.deleted', id: item.id });
    if (registeredModel?.id === item.id) setRegisteredModel(undefined);

    setConflict(null);
    setError('');
    onError('');
    setMessage(item.title + ' 모델 프리셋을 삭제했어요.');
    await reload();
  }
  const deleteConnection = (item: Connection) => (
    <DeleteButton
      path={`/connections/${encodeURIComponent(item.id)}`}
      revision={item.revision}
      title={item.title}
      label="프로바이더 삭제"
      description="이 프로바이더와 소속 모델을 목록에서 제거하고 현재 전역 역할 선택을 해제해요. 이후 호출은 차단되며 서버 인증 파일과 과거 실행 기록은 유지돼요."
      disabled={busy}
      onDeleted={() => deletedConnection(item)}
      onError={onError}
    />
  );
  const deleteModel = (item: ModelPreset, iconOnly = false) => (
    <DeleteButton
      path={`/model-presets/${encodeURIComponent(item.id)}`}
      revision={item.revision}
      title={item.title}
      label="모델 삭제"
      iconOnly={iconOnly}
      description="삭제하면 현재 전역 역할 선택에서 해제돼요. 해당 모델을 쓰는 작문 보조는 꺼져요. 과거 실행에 저장된 모델 설정은 유지돼요."
      disabled={busy}
      onDeleted={() => deletedModel(item)}
      onError={onError}
    />
  );

  async function perform(
    work: () => Promise<void>,
    scope: 'connection' | 'model' | 'status' = 'status'
  ) {
    if (operationLock.current) return false;
    operationLock.current = true;
    setBusy(true);
    setError('');
    onError('');
    setMessage('');
    try {
      await work();
      // The command has completed. A failed read must not ask the caller to repeat it.
      try {
        await reload();
      } catch (caught) {
        const detail = caught instanceof Error ? caught.message : '목록 조회 실패';
        const warning = `작업은 완료됐어요. 목록을 다시 불러오지 못했어요. ${detail}`;
        setMessage(warning);
        onError(warning);
      }
      return true;
    } catch (caught) {
      const detail = caught instanceof Error ? caught.message : '작업을 완료하지 못했어요.';
      setError(detail);
      onError(detail);
      if (caught instanceof ApiError && caught.status === 409 && scope !== 'status')
        setConflict(scope);
      await reload().catch(() => undefined);
      return false;
    } finally {
      operationLock.current = false;
      setBusy(false);
    }
  }
  function showConnection(item: Connection, copy = false, approved = false) {
    if (!approved) {
      replaceDraft('connection', () => showConnection(item, copy, true));
      return;
    }
    const next = {
      ...connectionDraft(item),
      ...(copy ? { title: item.title + ' 복사', enabled: false } : {}),
    };
    dispatchDraft({ type: 'connection.open', value: next, editing: copy ? undefined : item, copy });
    setError('');
    onError('');
    returnItem.current = { screen: 'connections', id: item.id };
    setSetup(false);
    navigate('connection');
  }
  async function showModel(item: ModelPreset, copy = false, approved = false) {
    if (!approved && modelStarted && JSON.stringify(model) !== modelBaseline) {
      setDiscard({
        kind: 'model',
        proceed: () => {
          void perform(() => showModel(item, copy, true), 'model');
        },
      });
      return;
    }
    const next = {
      ...modelDraft(item),
      ...(copy ? { title: item.title + ' 복사' } : {}),
    };
    dispatchDraft({ type: 'model.open', value: next, editing: copy ? undefined : item, copy });
    setModelSection('basic');
    returnItem.current = { screen: 'models', id: item.id };
    navigate('model');
  }
  function startModelFor(item: Connection) {
    const next = selectModelConnection(initialModel(), item);
    dispatchDraft({ type: 'model.open', value: next });
    setModelSection('basic');
    navigate('model');
  }
  async function saveConnection(
    body: Record<string, unknown>,
    id?: string,
    fromForm = true,
    leave = false
  ) {
    const saved = await api<Connection>(
      id ? `/connections/${id}` : '/connections',
      body,
      id ? 'PUT' : 'POST'
    );
    if (fromForm) {
      dispatchDraft({ type: 'connection.open', value: connectionDraft(saved), editing: saved });
      if (!id && !leave) {
        replaceDraft('model', () => startModelFor(saved));
      }
    }
    setMessage(saved.title + (id ? ' 프로바이더 변경 저장됨' : ' 프로바이더 등록됨'));
  }
  async function saveModel(
    body: Record<string, unknown>,
    id?: string,
    fromForm = true,
    leave = false
  ) {
    const saved = await api<ModelPreset>(
      id ? `/model-presets/${id}` : '/model-presets',
      body,
      id ? 'PUT' : 'POST'
    );
    if (fromForm) {
      dispatchDraft({ type: 'model.open', value: modelDraft(saved), editing: saved });
      setRegisteredModel(saved);
      returnItem.current = { screen: 'models', id: saved.id };
      setSetup(false);
      if (!leave) navigate('models');
    }
    setMessage(saved.title + (id ? ' 모델 변경 저장됨' : ' 모델 프리셋 등록됨'));
  }
  async function catalog(item: Connection) {
    const result = await api<Connection>(`/connections/${item.id}/catalog`, {});
    if (result.catalogError)
      throw new Error('모델 목록을 확인하지 못했어요. 마지막 저장 목록과 수동 모델 ID를 유지해요.');
    setMessage('모델 목록 조회 완료');
  }
  function statusConnection(item: Connection) {
    const body = {
      ...connectionPayload(connectionDraft(item)),
      enabled: !item.enabled,
      expectedRevision: item.revision,
    };
    void perform(() => saveConnection(body, item.id, false));
  }
  function editableModelBody(item: ModelPreset, changes: Record<string, unknown> = {}) {
    const { id: _id, revision, source: _source, capabilityProtocol: _protocol, ...body } = item;
    return { ...body, ...changes, expectedRevision: revision };
  }
  function statusModel(item: ModelPreset) {
    void perform(() =>
      saveModel(editableModelBody(item, { enabled: item.enabled === false }), item.id, false)
    );
  }
  function reorderModel(item: ModelPreset, direction: -1 | 1) {
    void perform(async () => {
      await api(`/model-presets/${item.id}/move`, { direction: direction === -1 ? 'up' : 'down' });
      setMessage('모델 표시 순서를 저장했어요.');
    });
  }
  async function latest(kind: 'connection' | 'model') {
    if (kind === 'connection' && editingConnection) {
      const value = await api<Connection>(`/connections/${editingConnection.id}`);
      if (!value) throw new Error('프로바이더를 찾지 못했어요.');
      showConnection(value, false, true);
    }
    if (kind === 'model' && editingModel) {
      const value = await api<ModelPreset>(`/model-presets/${editingModel.id}`);
      if (!value) throw new Error('모델을 찾지 못했어요.');
      await showModel(value, false, true);
    }
    setMessage('최신 저장 내용으로 편집 초안을 교체했어요.');
  }
  function newConnection() {
    setSetup(true);
    navigate('providers');
  }
  function startProvider(protocol: ProviderProtocol, approved = false) {
    if (!approved) {
      replaceDraft('connection', () => startProvider(protocol, true));
      return;
    }
    const template = providerDefinition(protocol);
    const next = {
      ...initialConnection(),
      protocol,
      title: protocol === 'fixture-sse-v1' ? '' : template.label,
      endpoint: template.endpointDefault,
      credentialRef: '',
      enabled: protocol !== 'fixture-sse-v1',
    };
    dispatchDraft({ type: 'connection.open', value: next });
    setError('');
    onError('');
    navigate('connection');
  }
  function newModel(approved = false) {
    if (!approved) {
      replaceDraft('model', () => newModel(true));
      return;
    }
    const linked =
      chosen ?? library.connections.find((item) => item.enabled) ?? library.connections[0];
    const next = linked ? selectModelConnection(initialModel(), linked) : initialModel();
    dispatchDraft({ type: 'model.open', value: next });
    setError('');
    setSetup(false);
    setModelSection('basic');
    navigate('model');
  }

  async function submitConnection(leave = false): Promise<boolean> {
    if (busy) return false;
    if (!connectionForm.current?.checkValidity()) {
      setScreen('connection');
      requestAnimationFrame(() => connectionForm.current?.reportValidity());
      return false;
    }
    const body = {
      ...connectionPayload(connection),
      ...(editingConnection ? { expectedRevision: editingConnection.revision } : {}),
    };
    return perform(() => saveConnection(body, editingConnection?.id, true, leave), 'connection');
  }
  async function submitModel(leave = false): Promise<boolean> {
    if (busy || !modelForm.current) return false;
    const invalid = modelForm.current.querySelector<HTMLInputElement | HTMLSelectElement>(
      'input:invalid,select:invalid,textarea:invalid'
    );
    if (invalid) {
      setScreen('model');
      const section = invalid.closest<HTMLElement>('[data-model-section]')?.dataset.modelSection;
      setModelSection((section as typeof modelSection) || 'basic');
      for (
        let parent: HTMLElement | null = invalid.parentElement;
        parent && parent !== modelForm.current;
        parent = parent.parentElement
      )
        if (parent instanceof HTMLDetailsElement) parent.open = true;
      requestAnimationFrame(() => {
        invalid.focus();
        invalid.reportValidity();
      });
      return false;
    }
    if (!chosen) return false;
    const optionError = modelDraftError(model, chosen, forcedVertexTier);
    if (optionError) {
      setScreen('model');
      setModelSection('advanced');
      setError(optionError);
      onError(optionError);
      requestAnimationFrame(() =>
        modelForm.current
          ?.querySelector<HTMLElement>('[data-model-section="generation"]')
          ?.scrollIntoView({ block: 'nearest' })
      );
      return false;
    }
    const body = {
      ...modelPayload(model, chosen),
      ...(editingModel ? { expectedRevision: editingModel.revision } : {}),
    };
    return perform(() => saveModel(body, editingModel?.id, true, leave), 'model');
  }
  const savePending = async (): Promise<boolean> => {
    if (busy) return false;
    if (
      connectionStarted &&
      JSON.stringify(connection) !== connectionBaseline &&
      !(await submitConnection(true))
    )
      return false;
    if (modelStarted && JSON.stringify(model) !== modelBaseline && !(await submitModel(true)))
      return false;
    if (jevDirty && !(await jevSave.current?.())) return false;
    return true;
  };
  useSettingsSaveHandler(onSaveHandlerChange, savePending);

  return (
    <section
      className="connection-editor"
      data-testid="connection-editor"
      aria-label="프로바이더·모델 등록"
    >
      <Dialog
        open={!!discard}
        role="alertdialog"
        title="편집 중인 초안 확인"
        variant="confirmation"
        onClose={() => {
          if (!discard || busy || operationLock.current) return;
          const kind = discard.kind;
          setDiscard(undefined);
          setScreen(kind);
        }}
      >
        {discard && (
          <>
            <strong>
              저장하지 않은 {discard.kind === 'connection' ? '프로바이더' : '모델'} 초안이 있어요
            </strong>
            <p>다른 항목을 편집하면 현재 초안이 교체돼요.</p>
            <DraftDiscardActions
              disabled={busy}
              onSave={async () => {
                const pending = discard;
                const saved =
                  pending.kind === 'connection'
                    ? await submitConnection(true)
                    : await submitModel(true);
                if (!saved) return false;
                setDiscard(undefined);
                pending.proceed();
                return true;
              }}
              onContinue={() => {
                const kind = discard.kind;
                setDiscard(undefined);
                setScreen(kind);
              }}
              onDiscard={() => {
                const action = discard.proceed;
                setDiscard(undefined);
                action();
              }}
              discardLabel="초안 버리고 계속"
            />
          </>
        )}
      </Dialog>
      <div className="provider-workspace-heading" ref={heading} tabIndex={-1}>
        <div className="provider-workspace-navigation" aria-label="프로바이더·모델 등록 화면">
          <button
            type="button"
            className={
              ['connections', 'connection', 'providers'].includes(screen) ||
              (screen === 'jev' && jevReturn === 'connections')
                ? 'selected'
                : 'secondary'
            }
            aria-label="프로바이더 관리"
            aria-pressed={
              ['connections', 'connection', 'providers'].includes(screen) ||
              (screen === 'jev' && jevReturn === 'connections')
            }
            disabled={busy}
            onClick={() => {
              setSetup(false);
              navigate('connections');
            }}
          >
            <ConnectionIcon size={18} aria-hidden="true" />
            프로바이더
          </button>
          <button
            type="button"
            className={
              screen === 'models' ||
              screen === 'model' ||
              (screen === 'jev' && jevReturn === 'models')
                ? 'selected'
                : 'secondary'
            }
            aria-label="모델 프리셋"
            aria-pressed={
              screen === 'models' ||
              screen === 'model' ||
              (screen === 'jev' && jevReturn === 'models')
            }
            disabled={busy}
            onClick={() => {
              setSetup(false);
              navigate('models');
            }}
          >
            <ModelIcon size={18} aria-hidden="true" />
            모델 프리셋
          </button>
          <IconButton
            label="목록 새로고침"
            icon={RefreshIcon}
            className="provider-refresh"
            hidden={screen === 'jev'}
            disabled={busy}
            onClick={() => {
              void perform(async () => {
                await reload();
                setJevListRefresh((value) => value + 1);
                setMessage('목록을 새로 읽었어요. 편집 초안은 유지돼요.');
              });
            }}
          />
        </div>
      </div>
      {jevListError && (
        <p className="error" role="alert">
          TypeSafe AI 등록 상태를 확인하지 못했어요. 목록을 새로고침해 주세요.
        </p>
      )}
      {(screen === 'models' || screen === 'connections') && (
        <>
          {((screen === 'models' ? library.models.length : library.connections.length) > 0 ||
            hasJev) && (
            <div className="provider-toolbar">
              <label className="provider-search">
                <SearchIcon size={18} aria-hidden="true" />
                <input
                  type="search"
                  aria-label="프로바이더·모델 검색"
                  placeholder={
                    screen === 'models'
                      ? '프리셋 이름, 모델 ID로 검색'
                      : '프로바이더 이름, 제공자, 주소로 검색'
                  }
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </label>
              <div className="provider-actions">
                <button
                  type="button"
                  className="primary"
                  aria-label={screen === 'connections' ? '새 프로바이더 입력' : '새 모델 입력'}
                  disabled={busy}
                  onClick={() => (screen === 'connections' ? newConnection() : newModel())}
                >
                  <AddIcon size={18} aria-hidden="true" />
                  <span>{screen === 'connections' ? '프로바이더 추가' : '모델 추가'}</span>
                </button>
              </div>
            </div>
          )}
          {jevDirty && (
            <button
              type="button"
              className="provider-resume secondary"
              disabled={busy}
              onClick={() => openJev(screen === 'models' ? 'models' : 'connections')}
            >
              TypeSafe AI 편집 이어서
            </button>
          )}
          {screen === 'connections' && connectionStarted && (
            <button
              type="button"
              className="provider-resume secondary"
              disabled={busy}
              onClick={() => navigate('connection')}
            >
              프로바이더 편집 이어서 · {connection.title || '이름 없는 초안'}
            </button>
          )}
          {screen === 'models' && modelStarted && (
            <button
              type="button"
              className="provider-resume secondary"
              disabled={busy}
              onClick={() => navigate('model')}
            >
              모델 편집 이어서 · {model.title || '이름 없는 초안'}
            </button>
          )}
          {!library.connections.length && !hasJev && (
            <div className="provider-welcome">
              <ConnectionIcon size={28} aria-hidden="true" />
              <h4>첫 프로바이더를 준비해요</h4>
              <p>프로바이더를 추가한 뒤 사용할 모델을 등록해요.</p>
              <button type="button" disabled={busy} onClick={newConnection}>
                프로바이더 추가 <ForwardIcon size={18} aria-hidden="true" />
              </button>
            </div>
          )}
          {library.connections.length > 0 &&
            !library.models.length &&
            !hasJev &&
            screen === 'models' && (
              <div className="provider-welcome">
                <ModelIcon size={28} aria-hidden="true" />
                <h4>사용할 모델을 등록해요</h4>
                <p>준비된 프로바이더를 선택하고 모델과 생성 설정을 저장해요.</p>
                <button type="button" disabled={busy} onClick={() => newModel()}>
                  <AddIcon size={18} aria-hidden="true" /> 새 모델 입력
                </button>
              </div>
            )}
        </>
      )}
      {(screen === 'connection' ||
        screen === 'model' ||
        screen === 'providers' ||
        screen === 'jev') && (
        <div className="provider-editor-heading">
          {(screen === 'providers' || screen === 'jev') && (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => {
                setSetup(false);
                navigate(screen === 'jev' ? jevReturn : 'connections');
              }}
            >
              <BackIcon size={16} />
              목록으로
            </button>
          )}
          {setup && (
            <ol className="provider-steps" aria-label="빠른 프로바이더 진행">
              <li aria-current={screen === 'providers' ? 'step' : undefined}>1. 프로바이더 종류</li>
              <li aria-current={screen === 'connection' || screen === 'jev' ? 'step' : undefined}>
                2. 접속 정보
              </li>
              <li aria-current={screen === 'model' ? 'step' : undefined}>3. 모델</li>
            </ol>
          )}
        </div>
      )}
      {screen === 'providers' && (
        <section className="provider-selection" aria-label="제공자 선택">
          <h4>프로바이더를 선택하세요.</h4>
          <p className="muted">
            현재 지원하는 프로바이더 방식이에요. 선택하면 주소와 인증 참조의 기본값을 채워요.
          </p>
          <div className="provider-template-grid">
            {PROVIDER_CHOICES.filter((item) => item.id !== 'fixture-sse-v1').map((item) => (
              <button
                type="button"
                className="secondary provider-template"
                key={item.id}
                disabled={busy}
                onClick={() => (item.kind === 'judgment' ? openJev() : startProvider(item.id))}
              >
                <span className="provider-template-icon">
                  <ConnectionIcon size={20} />
                </span>
                <strong>{item.label}</strong>
                <small>
                  {item.kind === 'judgment'
                    ? 'JEV · 판단 전용 모델'
                    : item.id === 'codex-app-server-v1'
                      ? '개인 ChatGPT 구독 · 서버 실행'
                      : item.id === 'vertex-gemini-v1'
                        ? 'Gemini 프로바이더 · global'
                        : item.id === 'openai-chat-v1'
                          ? '호환 API 또는 로컬 서버'
                          : '서버 API 키 인증'}
                </small>
                <ForwardIcon size={16} />
              </button>
            ))}
          </div>
          <details className="provider-test-template">
            <summary>개발·검사용 프로바이더</summary>
            <button
              type="button"
              className="secondary"
              onClick={() => startProvider('fixture-sse-v1')}
            >
              로컬 fixture로 설정
            </button>
          </details>
        </section>
      )}
      <JevProviderSettings
        onSaveHandlerChange={(handler) => {
          jevSave.current = handler;
        }}
        active={screen === 'jev'}
        onDirtyChange={setJevDirty}
        onBusyChange={setJevBusy}
        onStatusChange={setJevStatus}
      />
      <section hidden={screen !== 'connections'} aria-label="저장한 프로바이더">
        <div className="connection-list provider-saved-list">
          {jevMatches && (
            <article className="provider-saved-item" aria-label="TypeSafe AI 프로바이더">
              <div className="provider-item-heading">
                <button
                  type="button"
                  className="provider-item-open secondary"
                  disabled={busy}
                  aria-label="TypeSafe AI 프로바이더 수정"
                  data-provider-id={JEV_PROVIDER_DEFINITION.id}
                  onClick={() => openJev('connections')}
                >
                  <strong>TypeSafe AI</strong>
                  <span className="provider-item-subtitle">
                    JEV · 판단 전용 · {jevStatus?.configured ? '등록한 API 키' : 'API 키 없음'}
                  </span>
                </button>
                <ActionMenu label="TypeSafe AI 프로바이더 메뉴">
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() => openJev('connections')}
                  >
                    <ConnectionIcon size={18} aria-hidden="true" /> 연결 설정
                  </button>
                </ActionMenu>
              </div>
            </article>
          )}
          {connections.map((item) => (
            <article
              className="provider-saved-item"
              key={versionRef(item)}
              aria-label={item.title + ' 프로바이더'}
            >
              <div className="provider-item-heading">
                <button
                  type="button"
                  className="provider-item-open secondary"
                  disabled={busy}
                  aria-label={item.title + ' 프로바이더 수정'}
                  data-provider-id={item.id}
                  onClick={() => showConnection(item)}
                >
                  <strong>{item.title}</strong>
                  <span className="provider-item-subtitle">
                    {providerDefinition(item.protocol).label}
                    {item.protocol === 'vertex-gemini-v1' ? ' · global' : ''}
                    {!item.enabled && ' · 비활성'}
                  </span>
                </button>
                <ActionMenu label={item.title + ' 프로바이더 메뉴'}>
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    aria-label={item.title + ' 프로바이더 복제'}
                    onClick={() => showConnection(item, true)}
                  >
                    <CopyIcon size={18} aria-hidden="true" /> 복제
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    aria-label={item.title + ' 프로바이더 ' + (item.enabled ? '비활성' : '활성화')}
                    onClick={() => statusConnection(item)}
                  >
                    <PowerIcon size={18} aria-hidden="true" /> {item.enabled ? '비활성' : '활성화'}
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    aria-label={item.title + ' 모델 입력에 사용'}
                    onClick={() => {
                      setSetup(false);
                      replaceDraft('model', () => startModelFor(item));
                    }}
                  >
                    <ModelIcon size={18} aria-hidden="true" /> 모델 입력에 사용
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    aria-label={item.title + ' 모델 목록 새로고침'}
                    onClick={() => {
                      void perform(() => catalog(item));
                    }}
                  >
                    <RefreshIcon size={18} aria-hidden="true" />
                    모델 목록 새로고침
                  </button>
                  {deleteConnection(item)}
                </ActionMenu>
              </div>
              {item.catalogError && (
                <p className="error provider-item-notice">
                  모델 목록 조회 실패 · 마지막 저장 목록을 유지해요.
                </p>
              )}
            </article>
          ))}
          {connections.length === 0 &&
            !jevMatches &&
            (library.connections.length > 0 || hasJev) && (
              <div className="provider-empty" role="status">
                <p>검색 조건에 맞는 프로바이더가 없어요.</p>
                <button type="button" className="secondary" onClick={() => setQuery('')}>
                  검색 지우기
                </button>
              </div>
            )}
        </div>
      </section>
      <section
        hidden={screen !== 'models'}
        className="registered-models"
        aria-label="저장한 모델 프리셋"
      >
        <div className="provider-saved-list">
          {jevMatches && (
            <details
              className="provider-model-group"
              open={modelGroupOpen(JEV_PROVIDER_DEFINITION.id)}
              onToggle={(event) =>
                toggleModelGroup(JEV_PROVIDER_DEFINITION.id, event.currentTarget.open)
              }
            >
              <summary>
                <span>
                  <strong>{JEV_PROVIDER_DEFINITION.label}</strong>
                  <small>1개 모델</small>
                </span>
              </summary>
              <div className="provider-model-group-list">
                <article className="provider-saved-item" aria-label="JEV 모델">
                  <div className="provider-item-heading">
                    <button
                      type="button"
                      className="provider-item-open secondary"
                      disabled={busy}
                      aria-label="JEV 모델 설정"
                      data-provider-id={JEV_PROVIDER_DEFINITION.id}
                      onClick={() => {
                        setSetup(false);
                        openJev('models');
                      }}
                    >
                      <strong>{JEV_PROVIDER_DEFINITION.modelLabel}</strong>
                      <span className="provider-item-subtitle">
                        {JEV_PROVIDER_DEFINITION.modelId} · 판단 전용
                      </span>
                    </button>
                    <ActionMenu label="JEV 모델 메뉴">
                      <button
                        type="button"
                        className="secondary"
                        disabled={busy}
                        onClick={() => {
                          setSetup(false);
                          openJev('models');
                        }}
                      >
                        <ConnectionIcon size={18} aria-hidden="true" /> 연결 설정
                      </button>
                    </ActionMenu>
                  </div>
                  <section className="provider-model-test" aria-label="JEV 응답 테스트 설정">
                    <div className="provider-actions">
                      <button
                        type="button"
                        className="secondary"
                        disabled={busy}
                        aria-label="JEV 응답 테스트 설정 열기"
                        onClick={() => {
                          setSetup(false);
                          openJev('models');
                        }}
                      >
                        테스트 보기
                      </button>
                      <small>요금이 발생할 수 있어요.</small>
                    </div>
                  </section>
                </article>
              </div>
            </details>
          )}
          {modelGroups.map((group) => {
            const groupKey = group.connection?.id ?? 'missing-provider';
            return (
              <details
                className="provider-model-group"
                key={groupKey}
                open={modelGroupOpen(groupKey)}
                onToggle={(event) => toggleModelGroup(groupKey, event.currentTarget.open)}
              >
                <summary>
                  <span>
                    <strong>{group.connection?.title ?? '프로바이더 확인 필요'}</strong>
                    <small>{group.models.length}개 모델</small>
                  </span>
                </summary>
                <div className="provider-model-group-list">
                  {group.models.map((item, index) => (
                    <article
                      className="provider-saved-item"
                      key={versionRef(item)}
                      aria-label={item.title + ' 모델'}
                    >
                      <div className="provider-item-heading">
                        <button
                          type="button"
                          className="provider-item-open secondary"
                          disabled={busy}
                          aria-label={item.title + ' 모델 수정'}
                          data-provider-id={item.id}
                          onClick={() => {
                            void perform(() => showModel(item), 'model');
                          }}
                        >
                          <strong>{item.title}</strong>
                          <span className="provider-item-subtitle">
                            {item.modelId}
                            {item.enabled === false
                              ? ' · 비활성'
                              : group.connection?.enabled === false
                                ? ' · 프로바이더 비활성'
                                : ''}
                          </span>
                        </button>
                        <div className="provider-model-row-actions">
                          <IconButton
                            icon={UpIcon}
                            label={item.title + ' 모델 위로 이동'}
                            disabled={busy || !!filter || index === 0}
                            onClick={() => reorderModel(item, -1)}
                          />
                          <IconButton
                            icon={DownIcon}
                            label={item.title + ' 모델 아래로 이동'}
                            disabled={busy || !!filter || index === group.models.length - 1}
                            onClick={() => reorderModel(item, 1)}
                          />
                          <ActionMenu label={item.title + ' 모델 메뉴'}>
                            <button
                              type="button"
                              className="secondary"
                              disabled={busy}
                              aria-label={item.title + ' 모델 복제'}
                              onClick={() => {
                                void perform(() => showModel(item, true), 'model');
                              }}
                            >
                              <CopyIcon size={18} aria-hidden="true" /> 복제
                            </button>
                            <button
                              type="button"
                              className="secondary"
                              disabled={busy}
                              aria-label={
                                item.title +
                                ' 모델 ' +
                                (item.enabled === false ? '활성화' : '비활성')
                              }
                              onClick={() => statusModel(item)}
                            >
                              <PowerIcon size={18} aria-hidden="true" />{' '}
                              {item.enabled === false ? '활성화' : '비활성'}
                            </button>
                            {deleteModel(item)}
                          </ActionMenu>
                        </div>
                      </div>
                      <ProviderModelTest
                        model={item}
                        record={modelTests.records[versionRef(item)]}
                        available={
                          item.enabled !== false &&
                          library.connections.some(
                            (connection) =>
                              connection.id === item.connectionId && connection.enabled
                          )
                        }
                        busy={busy}
                        onStart={modelTests.start}
                      />
                    </article>
                  ))}
                </div>
              </details>
            );
          })}
          {models.length === 0 && !jevMatches && (library.models.length > 0 || hasJev) && (
            <div className="provider-empty" role="status">
              <p>검색 조건에 맞는 모델이 없어요.</p>
              <button type="button" className="secondary" onClick={() => setQuery('')}>
                검색 지우기
              </button>
            </div>
          )}
        </div>
      </section>
      <ProviderConnectionForm
        hidden={screen !== 'connection'}
        draft={drafts.connection}
        connections={library.connections}
        conflict={conflict === 'connection'}
        busy={busy}
        operationBusy={operationBusy}
        formRef={connectionForm}
        onChange={setConnection}
        onUploadBusy={setUploadingCredential}
        onSubmit={submitConnection}
        onReload={() => {
          void perform(() => latest('connection'), 'connection');
        }}
        onDone={() => navigate('connections')}
        deleteAction={editingConnection && deleteConnection(editingConnection)}
      />
      <ProviderModelForm
        hidden={screen !== 'model'}
        draft={drafts.model}
        models={library.models}
        modelConnections={library.connections}
        conflict={conflict === 'model'}
        busy={busy}
        forcedVertexTier={forcedVertexTier}
        modelSection={modelSection}
        onSectionChange={setModelSection}
        formRef={modelForm}
        onChange={setModel}
        onSubmit={submitModel}
        onReload={() => {
          void perform(() => latest('model'), 'model');
        }}
        onDone={() => navigate('models')}
        onCatalog={(item) => {
          void perform(() => catalog(item));
        }}
        deleteAction={editingModel && deleteModel(editingModel, true)}
      />
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <p role="status">{message}</p>
      {registeredModel && screen === 'models' && (
        <section className="provider-next-step" aria-label="등록한 모델 사용 방법">
          <strong>{registeredModel.title} · 다음으로 역할에 배정하세요</strong>
          <p>비활성 프로바이더로 등록했다면 프로바이더를 활성화한 뒤 역할에 배정해 주세요.</p>
          <ol>
            <li>설정 → 역할별 모델에서 사용할 역할을 선택하고 저장해요.</li>
            <li>모든 채팅의 이후 요청에 적용해요.</li>
          </ol>
          <small>
            {registeredModel.enabled === false
              ? '지금은 새 선택에서 제외된 모델이에요. 활성화한 뒤 새로 배정할 수 있어요.'
              : '역할 선택 전에는 현재 전역 모델 설정을 바꾸지 않아요.'}
          </small>
        </section>
      )}
    </section>
  );
}
