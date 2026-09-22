import { useSettingsSaveHandler, type SettingsSaveRegistration } from './useSettingsSaveHandler.js';
import {
  JEV_PROVIDER_DEFINITION,
  jevRegistered,
  type JevProviderStatus,
} from '../core/jev-provider.js';
import { DraftDiscardActions } from './DraftDiscardActions.js';
import { Dialog } from './Dialog.js';
import { Switch } from './BooleanControls.js';
import { useEffect, useRef, useState } from 'react';
import { ActionMenu } from './ActionMenu.js';
import { IconButton } from './IconButton.js';
import { SaveButton } from './SaveButton.js';
import {
  AddIcon,
  BackIcon,
  CloseIcon,
  ConnectionIcon,
  CopyIcon,
  ForwardIcon,
  ModelIcon,
  PowerIcon,
  RefreshIcon,
  SearchIcon,
} from './ui-icons.js';
import { VertexCredentialUpload } from './VertexCredentialUpload.js';
import { ProviderCatalogPicker } from './ProviderCatalogPicker.js';
import { modelHints } from '../core/model-hints.js';
import type {
  Connection,
  Library,
  ModelPreset,
  ProviderProtocol,
  VertexRequestTier,
} from '../core/product.js';
import {
  PROVIDER_DEFINITIONS,
  PROVIDER_CHOICES,
  providerDefinition,
} from '../core/provider-definitions.js';
import { api, ApiError } from './api.js';
import {
  initialModel,
  modelDraft,
  modelDraftError,
  modelPayload,
  ProviderModelFields,
  selectModelConnection,
} from './ProviderModelFields.js';
import { DeleteButton } from './DeleteButton.js';
import { ProviderReadiness } from './ProviderReadiness.js';
import { ProviderModelTest, useProviderModelTests } from './ProviderModelTest.js';
import { JevProviderSettings } from './JevProviderSettings.js';
import './ProviderManagement.css';
import './settings-actions.css';

const versionRef = (item: { id: string; revision: number }) => `${item.id}@${item.revision}`;
type ConnectionDraft = {
  title: string;
  protocol: ProviderProtocol;
  endpoint: string;
  credentialRef: string;
  catalogCredentialRef: string;
  apiKey?: string | null;
  catalogApiKey?: string | null;
  enabled: boolean;
};
const initialConnection = (): ConnectionDraft => ({
  title: '',
  protocol: 'fixture-sse-v1',
  endpoint: '',
  credentialRef: '',
  catalogCredentialRef: '',
  enabled: false,
});
const connectionDraft = (item: Connection): ConnectionDraft => ({
  title: item.title,
  protocol: item.protocol,
  endpoint: item.endpoint,
  credentialRef: item.credentialRef ?? '',
  catalogCredentialRef: item.catalogCredentialRef ?? '',
  enabled: item.enabled,
});
function connectionPayload(value: ConnectionDraft) {
  return {
    title: value.title,
    protocol: value.protocol,
    endpoint: value.protocol === 'codex-app-server-v1' ? 'codex://local' : value.endpoint,
    ...(value.protocol !== 'codex-app-server-v1' && value.credentialRef.trim()
      ? { credentialRef: value.credentialRef.trim() }
      : {}),
    ...(value.protocol === 'vertex-gemini-v1' && value.catalogCredentialRef.trim()
      ? { catalogCredentialRef: value.catalogCredentialRef.trim() }
      : {}),
    ...(value.apiKey !== undefined ? { apiKey: value.apiKey } : {}),
    ...(value.catalogApiKey !== undefined ? { catalogApiKey: value.catalogApiKey } : {}),
    enabled: value.enabled,
  };
}
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
  const [setup, setSetup] = useState(false),
    [connectionStarted, setConnectionStarted] = useState(false),
    [modelStarted, setModelStarted] = useState(false);
  const [modelSection, setModelSection] = useState<'basic' | 'advanced'>('basic');
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

  const [connection, setConnection] = useState(initialConnection);
  const [editingConnection, setEditingConnection] = useState<Connection>();
  const [connectionCopy, setConnectionCopy] = useState(false);
  const [model, setModel] = useState(initialModel);
  const [editingModel, setEditingModel] = useState<ModelPreset>();
  const [modelCopy, setModelCopy] = useState(false);
  const [connectionBaseline, setConnectionBaseline] = useState(() =>
      JSON.stringify(initialConnection())
    ),
    [modelBaseline, setModelBaseline] = useState(() => JSON.stringify(initialModel()));
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
  const [conflict, setConflict] = useState<'connection' | 'model' | null>(null);
  const [registeredModel, setRegisteredModel] = useState<ModelPreset>();
  const operationLock = useRef(false);
  const jevSave = useRef<(() => Promise<boolean>) | null>(null);
  const connectionForm = useRef<HTMLFormElement>(null);
  const modelForm = useRef<HTMLFormElement>(null);
  const chosen = library.connections.find((item) => item.id === model.connectionRef);
  const modelConnections = library.connections;
  const codex = connection.protocol === 'codex-app-server-v1',
    definition = providerDefinition(connection.protocol),
    vertex = connection.protocol === 'vertex-gemini-v1';

  const endpointLabel = codex
    ? 'Codex 실행 위치'
    : vertex
      ? 'Google Agent Platform endpoint'
      : connection.protocol === 'fixture-sse-v1'
        ? '로컬 endpoint'
        : 'API 기본 주소';
  const filter = query.trim().toLocaleLowerCase();
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

  async function deletedConnection(item: Connection) {
    if (editingConnection?.id === item.id) {
      const next = initialConnection();
      setEditingConnection(undefined);
      setConnection(next);
      setConnectionBaseline(JSON.stringify(next));
      setConnectionStarted(false);
      setConnectionCopy(false);
      if (screen === 'connection') navigate('connections');
    }
    if (model.connectionRef === item.id) {
      setModel((current) => ({ ...current, connectionRef: '' }));
      setModelBaseline((current) => JSON.stringify({ ...JSON.parse(current), connectionRef: '' }));
    }
    setConflict(null);
    setError('');
    onError('');
    setMessage(item.title + ' 프로바이더를 삭제했어요.');
    await reload();
  }
  async function deletedModel(item: ModelPreset) {
    if (editingModel?.id === item.id) {
      const next = initialModel();
      setEditingModel(undefined);
      setModel(next);
      setModelBaseline(JSON.stringify(next));
      setModelStarted(false);
      setModelCopy(false);
      if (screen === 'model') navigate('models');
    }
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
      await reload();
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
    setConnection(next);
    setConnectionBaseline(JSON.stringify(next));
    setEditingConnection(copy ? undefined : structuredClone(item));
    setConnectionCopy(copy);
    setConflict(null);
    setError('');
    onError('');
    setConnectionStarted(true);
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
    const next = { ...modelDraft(item), ...(copy ? { title: item.title + ' 복사' } : {}) };
    setModel(next);
    setModelBaseline(JSON.stringify(next));
    setEditingModel(copy ? undefined : structuredClone(item));
    setModelCopy(copy);
    setConflict(null);
    setModelStarted(true);
    setModelSection('basic');
    returnItem.current = { screen: 'models', id: item.id };
    navigate('model');
  }
  function startModelFor(item: Connection) {
    const next = selectModelConnection(initialModel(), item);
    setModel(next);
    setModelBaseline(JSON.stringify(next));
    setEditingModel(undefined);
    setModelCopy(false);
    setModelStarted(true);
    setModelSection('basic');
    navigate('model');
  }
  function chooseConnection(item: Connection) {
    setModel((current) => selectModelConnection(current, item));
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
      setEditingConnection(saved);
      setConnection(connectionDraft(saved));
      setConnectionBaseline(JSON.stringify(connectionDraft(saved)));
      setConnectionCopy(false);
      setConflict(null);
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
      setEditingModel(saved);
      setModel(modelDraft(saved));
      setModelBaseline(JSON.stringify(modelDraft(saved)));
      setModelCopy(false);
      setConflict(null);
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
    setMessage(
      result.protocol === 'vertex-gemini-v1' && !result.catalogCredentialRef
        ? '로컬 지원 모델 목록 확인 완료 · 공급자 조회 없음'
        : '모델 목록 조회 완료'
    );
  }
  function statusConnection(item: Connection) {
    const body = {
      ...connectionPayload(connectionDraft(item)),
      enabled: !item.enabled,
      expectedRevision: item.revision,
    };
    void perform(() => saveConnection(body, item.id, false));
  }
  function statusModel(item: ModelPreset) {
    const { id, revision, source: _, capabilityProtocol: _protocol, ...body } = item;
    const updated = { ...body, enabled: item.enabled === false, expectedRevision: revision };
    void perform(() => saveModel(updated, id, false));
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
    setConnection(next);
    setConnectionBaseline(JSON.stringify(next));
    setEditingConnection(undefined);
    setConnectionCopy(false);
    setConflict(null);
    setError('');
    onError('');
    setConnectionStarted(true);
    navigate('connection');
  }
  function newModel(approved = false) {
    if (!approved) {
      replaceDraft('model', () => newModel(true));
      return;
    }
    const linked =
      chosen ?? library.connections.find((item) => item.enabled) ?? library.connections[0];
    if (linked) {
      const next = selectModelConnection(initialModel(), linked);
      setModel(next);
      setModelBaseline(JSON.stringify(next));
    } else {
      setModel(initialModel());
      setModelBaseline(JSON.stringify(initialModel()));
    }
    setEditingModel(undefined);
    setModelCopy(false);
    setConflict(null);
    setError('');
    setSetup(false);
    setModelStarted(true);
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
                    aria-label={
                      item.title +
                      ' ' +
                      (item.protocol === 'vertex-gemini-v1'
                        ? '로컬 지원 모델 확인'
                        : '모델 목록 새로고침')
                    }
                    onClick={() => {
                      void perform(() => catalog(item));
                    }}
                  >
                    <RefreshIcon size={18} aria-hidden="true" />
                    {item.protocol === 'vertex-gemini-v1'
                      ? '로컬 지원 모델 확인'
                      : '모델 목록 새로고침'}
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
                  <strong>JEV</strong>
                  <span className="provider-item-subtitle">
                    TypeSafe AI · {JEV_PROVIDER_DEFINITION.modelId} · 판단 전용
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
          )}
          {models.map((item) => (
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
                    {library.connections.find((c) => c.id === item.connectionId)?.title ??
                      '프로바이더 확인 필요'}
                    {item.enabled === false
                      ? ' · 비활성'
                      : library.connections.find((c) => c.id === item.connectionId)?.enabled ===
                          false
                        ? ' · 프로바이더 비활성'
                        : ''}
                  </span>
                </button>
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
                      item.title + ' 모델 ' + (item.enabled === false ? '활성화' : '비활성')
                    }
                    onClick={() => statusModel(item)}
                  >
                    <PowerIcon size={18} aria-hidden="true" />{' '}
                    {item.enabled === false ? '활성화' : '비활성'}
                  </button>
                  {deleteModel(item)}
                </ActionMenu>
              </div>
              <ProviderModelTest
                model={item}
                record={modelTests.records[versionRef(item)]}
                available={
                  item.enabled !== false &&
                  library.connections.some(
                    (connection) => connection.id === item.connectionId && connection.enabled
                  )
                }
                busy={busy}
                onStart={modelTests.start}
              />
            </article>
          ))}
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
      <form
        hidden={screen !== 'connection'}
        ref={connectionForm}
        className="editor-grid provider-management-form"
        aria-label="프로바이더 편집 양식"
        onSubmit={(event) => {
          event.preventDefault();
          void submitConnection();
        }}
      >
        <h3 className="full">
          {editingConnection
            ? '프로바이더 수정'
            : connectionCopy
              ? '프로바이더 복제 검토'
              : '프로바이더 등록'}
        </h3>
        {editingConnection && (
          <div className="provider-draft-note full">
            <p>
              저장한 변경은 다음 신규 생성부터 적용돼요. 진행 중이거나 완료된 실행의 설정은
              유지돼요.
            </p>
            {library.connections.find((item) => item.id === editingConnection.id)?.revision !==
              editingConnection.revision && (
              <p>다른 곳에서 프로바이더가 변경됐어요. 입력한 초안은 유지했어요.</p>
            )}
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => {
                void perform(() => latest('connection'), 'connection');
              }}
            >
              최신 프로바이더 설정 불러오기
            </button>
          </div>
        )}
        {connectionCopy && (
          <p className="provider-draft-note full">
            새 프로바이더로 복사해요. 주소와 키를 확인하고 저장해 주세요.
          </p>
        )}
        {conflict === 'connection' && (
          <p className="error full" role="alert">
            다른 곳에서 프로바이더가 변경됐어요. 초안은 유지했어요. 최신 설정을 불러와 주세요.
          </p>
        )}
        <fieldset className="editor-fields full provider-connection-fields" disabled={busy}>
          <label>
            프로바이더 종류
            <select
              aria-label="프로바이더 프로토콜"
              value={connection.protocol}
              onChange={(event) => {
                const protocol = event.target.value as ProviderProtocol,
                  definition = providerDefinition(protocol);
                setConnection({
                  ...connection,
                  protocol,
                  endpoint: definition.endpointDefault,
                  credentialRef: '',
                  apiKey: undefined,
                  catalogApiKey: undefined,
                });
              }}
            >
              {PROVIDER_DEFINITIONS.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            프로바이더 이름
            <input
              aria-label="프로바이더 이름"
              required
              maxLength={160}
              value={connection.title}
              onChange={(event) => setConnection({ ...connection, title: event.target.value })}
            />
          </label>
          {vertex && (
            <VertexCredentialUpload
              credentialRef={connection.credentialRef}
              disabled={operationBusy}
              onBusy={setUploadingCredential}
              onRegistered={(value) =>
                setConnection((current) => ({
                  ...current,
                  credentialRef: value.credentialRef,
                  endpoint: `https://aiplatform.googleapis.com/v1/projects/${value.projectId}/locations/global/publishers/google/models`,
                }))
              }
            />
          )}
          {vertex && (
            <label className="full">
              Google Cloud 프로젝트 ID
              <input
                aria-label="Google Cloud 프로젝트 ID"
                placeholder="my-project"
                value={
                  connection.endpoint.match(/\/projects\/([^/]+)\/locations\/global\//)?.[1] ?? ''
                }
                onChange={(event) =>
                  setConnection({
                    ...connection,
                    endpoint: event.target.value.trim()
                      ? `https://aiplatform.googleapis.com/v1/projects/${event.target.value.trim()}/locations/global/publishers/google/models`
                      : '',
                  })
                }
              />
              <small>프로젝트 ID를 입력하면 global 주소를 채워요.</small>
            </label>
          )}
          <label className="full">
            {endpointLabel}
            <input
              aria-label={endpointLabel}
              type="url"
              required
              readOnly={codex}
              placeholder={
                vertex
                  ? 'https://aiplatform.googleapis.com/v1/projects/PROJECT_ID/locations/global/publishers/google/models'
                  : connection.protocol === 'fixture-sse-v1'
                    ? 'http://127.0.0.1:포트'
                    : 'https://provider.example/v1'
              }
              value={connection.endpoint}
              onChange={(event) => setConnection({ ...connection, endpoint: event.target.value })}
            />
          </label>
          {!codex && !vertex && (
            <label className="full">
              API 키
              <input
                aria-label="API 키"
                type="password"
                autoComplete="new-password"
                placeholder={
                  connection.credentialRef
                    ? '등록됨 · 변경할 때 입력'
                    : 'API 키 입력 · 인증 없는 서버는 생략'
                }
                value={connection.apiKey ?? ''}
                onChange={(event) => setConnection({ ...connection, apiKey: event.target.value })}
              />
              {connection.credentialRef && (
                <button
                  type="button"
                  className="ghost"
                  onClick={() => setConnection({ ...connection, apiKey: null, credentialRef: '' })}
                >
                  등록한 키 삭제
                </button>
              )}
            </label>
          )}
          {vertex && (
            <label className="full">
              모델 목록용 Gemini API 키 · 선택
              <input
                aria-label="모델 목록 API 키"
                type="password"
                autoComplete="new-password"
                placeholder={
                  connection.catalogCredentialRef ? '등록됨 · 변경할 때 입력' : '목록 조회용 키'
                }
                value={connection.catalogApiKey ?? ''}
                onChange={(event) =>
                  setConnection({ ...connection, catalogApiKey: event.target.value })
                }
              />
            </label>
          )}
          <label className="check">
            <Switch
              checked={connection.enabled}
              onChange={(event) => setConnection({ ...connection, enabled: event.target.checked })}
            />
            이 프로바이더 사용
          </label>
          <small className="full">
            {codex
              ? '에이전트 설정에서 Codex에 로그인해 주세요.'
              : vertex
                ? '서비스 계정 JSON을 등록하면 사용할 수 있어요.'
                : 'API 키는 서버 DB에 저장돼요. 키를 저장하면 재시작 없이 사용할 수 있어요.'}
          </small>
          <details className="provider-definition full">
            <summary>프로바이더 템플릿 정보</summary>
            <dl>
              <dt>정의</dt>
              <dd>{definition.id}</dd>
              <dt>확인일</dt>
              <dd>{definition.source.checkedAt}</dd>
              <dt>근거</dt>
              <dd>로컬 어댑터 · {definition.source.reference}</dd>
              <dt>인증 방식</dt>
              <dd>{definition.auth}</dd>
              <dt>목록 방식</dt>
              <dd>
                {definition.catalog === 'remote'
                  ? '명시 요청 시 원격 조회'
                  : definition.catalog === 'agent-runtime'
                    ? '로그인한 에이전트 모델 목록'
                    : '로컬 지원 목록'}
              </dd>
              <dt>설정할 수 있는 옵션</dt>
              <dd>{definition.optionKeys.join(', ')}</dd>
            </dl>
            <ul>
              {definition.limitations.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            <p>프로바이더 템플릿은 로컬 구현의 설명이에요. 모델별 기능과 가격은 미확인이에요.</p>
          </details>
        </fieldset>
        <div className="provider-actions full provider-save-actions">
          {editingConnection && deleteConnection(editingConnection)}
          <small className="provider-save-status">
            {editingConnection
              ? JSON.stringify(connection) === connectionBaseline
                ? '저장한 프로바이더예요.'
                : '아직 저장하지 않은 변경이 있어요.'
              : '아직 저장하지 않은 프로바이더예요.'}
          </small>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => navigate('connections')}
          >
            프로바이더 편집 끝내기
          </button>
          <button className="primary" disabled={busy}>
            {editingConnection ? '프로바이더 변경 저장' : '프로바이더 등록'}
          </button>
        </div>
      </form>
      <form
        hidden={screen !== 'model'}
        ref={modelForm}
        className="editor-grid provider-management-form"
        aria-label="모델 편집 양식"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submitModel();
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
          (conflict === 'model' ||
            library.models.find((item) => item.id === editingModel.id)?.revision !==
              editingModel.revision) && (
            <div className="provider-draft-note full">
              {library.models.find((item) => item.id === editingModel.id)?.revision !==
                editingModel.revision && (
                <p>다른 곳에서 모델이 변경됐어요. 입력한 초안은 유지했어요.</p>
              )}
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => {
                  void perform(() => latest('model'), 'model');
                }}
              >
                최신 모델 설정 불러오기
              </button>
            </div>
          )}
        {modelCopy && (
          <p className="provider-draft-note full">설정을 검토한 뒤 새 프리셋으로 저장해요.</p>
        )}
        {conflict === 'model' && (
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
              onClick={() => setModelSection(section)}
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
                onChange={(event) => setModel({ ...model, title: event.target.value })}
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
                  if (item) chooseConnection(item);
                  else setModel({ ...model, connectionRef: '' });
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
            {chosen && (
              <>
                {!chosen.enabled && (
                  <p className="provider-draft-note full">
                    비활성 프로바이더를 사용하는 모델은 새로 실행할 수 없어요. 프로바이더를
                    활성화하면 다시 사용할 수 있어요.
                  </p>
                )}
                <details className="provider-readiness-details full">
                  <summary>프로바이더 준비 상태와 목록 새로고침</summary>
                  <ProviderReadiness
                    key={versionRef(chosen)}
                    connection={chosen}
                    busy={busy}
                    onCatalog={(item) => {
                      void perform(() => catalog(item));
                    }}
                  />
                </details>
              </>
            )}
            <ProviderCatalogPicker
              key={chosen?.id}
              connection={chosen}
              selectedId={model.modelId}
              busy={busy}
              onChoose={(item) =>
                setModel((current) => {
                  // Picking from the list is an explicit choice: published limits prefill and stay editable.
                  const hints = chosen ? modelHints(chosen, item.id) : undefined;
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
            value={model}
            onChange={setModel}
            connection={chosen}
            forcedVertexTier={forcedVertexTier}
          />
        </fieldset>
        <div className="provider-actions full provider-save-actions provider-model-save-actions">
          {editingModel && deleteModel(editingModel, true)}
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
            onClick={() => navigate('models')}
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
