import { DraftDiscardActions } from './DraftDiscardActions.js';
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
import { PROVIDER_DEFINITIONS, providerDefinition } from '../core/provider-definitions.js';
import { CREDENTIAL_ENV_PATTERN } from '../core/credential-reference.js';
import { api, ApiError } from './api.js';
import {
  initialModel,
  modelDraft,
  modelDraftError,
  modelPayload,
  ProviderModelFields,
  selectModelConnection,
} from './ProviderModelFields.js';
import { ProviderEndpointStatus } from './ProviderEndpointStatus.js';
import { DeleteButton } from './DeleteButton.js';
import { ProviderReadiness } from './ProviderReadiness.js';
import { ProviderModelTest, useProviderModelTests } from './ProviderModelTest.js';
import './ProviderManagement.css';
import './settings-actions.css';

const versionRef = (item: { id: string; revision: number }) => `${item.id}@${item.revision}`;
type ConnectionDraft = {
  title: string;
  protocol: ProviderProtocol;
  endpoint: string;
  credentialEnv: string;
  catalogCredentialEnv: string;
  enabled: boolean;
};
const initialConnection = (): ConnectionDraft => ({
  title: '',
  protocol: 'fixture-sse-v1',
  endpoint: '',
  credentialEnv: '',
  catalogCredentialEnv: '',
  enabled: false,
});
const connectionDraft = (item: Connection): ConnectionDraft => ({
  title: item.title,
  protocol: item.protocol,
  endpoint: item.endpoint,
  credentialEnv: item.credentialEnv ?? '',
  catalogCredentialEnv: item.catalogCredentialEnv ?? '',
  enabled: item.enabled,
});
function connectionPayload(value: ConnectionDraft) {
  return {
    title: value.title,
    protocol: value.protocol,
    endpoint: value.protocol === 'codex-app-server-v1' ? 'codex://local' : value.endpoint,
    ...(value.protocol !== 'codex-app-server-v1' && value.credentialEnv.trim()
      ? { credentialEnv: value.credentialEnv.trim() }
      : {}),
    ...(value.protocol === 'vertex-gemini-v1' && value.catalogCredentialEnv.trim()
      ? { catalogCredentialEnv: value.catalogCredentialEnv.trim() }
      : {}),
    enabled: value.enabled,
  };
}
type Confirmation = {
  kind: 'connection' | 'model';
  id: string;
  title: string;
  body: Record<string, unknown>;
  fromForm: boolean;
};
const matches = (query: string, ...values: (string | undefined)[]) =>
  !query || values.some((value) => value?.toLocaleLowerCase().includes(query));

export function ConnectionEditor({
  library,
  reload,
  onError,
  onDirtyChange,
}: {
  library: Library;
  reload: () => Promise<void>;
  onError: (error: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
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
    'models' | 'connections' | 'providers' | 'connection' | 'model'
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
    setConfirmation(undefined);
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
  const [operationBusy, setOperationBusy] = useState(false),
    [message, setMessage] = useState(''),
    [error, setError] = useState('');
  const busy = operationBusy || uploadingCredential;
  const dirty =
    busy ||
    (connectionStarted && JSON.stringify(connection) !== connectionBaseline) ||
    (modelStarted && JSON.stringify(model) !== modelBaseline);
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  const setBusy = setOperationBusy;
  const [conflict, setConflict] = useState<'connection' | 'model' | 'status' | null>(null),
    [confirmation, setConfirmation] = useState<Confirmation>();
  const [registeredModel, setRegisteredModel] = useState<ModelPreset>();
  const operationLock = useRef(false),
    discardPanel = useRef<HTMLElement>(null);
  useEffect(() => {
    if (discard) {
      discardPanel.current?.scrollIntoView({ block: 'nearest' });
      discardPanel.current?.focus();
    }
  }, [discard]);
  const connectionForm = useRef<HTMLFormElement>(null),
    modelForm = useRef<HTMLFormElement>(null),
    confirmationPanel = useRef<HTMLElement>(null);
  useEffect(() => {
    if (confirmation) confirmationPanel.current?.scrollIntoView({ block: 'nearest' });
  }, [confirmation]);
  const chosen = library.connections.find((item) => item.id === model.connectionRef);
  const modelConnections = library.connections;
  const codex = connection.protocol === 'codex-app-server-v1',
    definition = providerDefinition(connection.protocol),
    vertex = connection.protocol === 'vertex-gemini-v1';
  const official = ['anthropic-messages-v1', 'vercel-chat-v1', 'deepseek-chat-v1'].includes(
    connection.protocol
  );
  const endpointLabel = codex
    ? 'Codex 실행 위치'
    : vertex
      ? 'Google Agent Platform endpoint'
      : connection.protocol === 'fixture-sse-v1'
        ? '로컬 endpoint'
        : 'API 기본 주소';
  const filter = query.trim().toLocaleLowerCase();
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
    setConfirmation(undefined);
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
    setConfirmation(undefined);
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
      description="삭제하면 현재 전역 역할 선택에서 해제돼요. 해당 모델을 쓰는 작문 보조는 꺼지고 상태 계산도 새 작업 전에 모델 설정을 확인해야 해요. 과거 실행에 저장된 모델 설정은 유지돼요."
      disabled={busy}
      onDeleted={() => deletedModel(item)}
      onError={onError}
    />
  );

  async function perform(
    work: () => Promise<void>,
    scope: 'connection' | 'model' | 'status' = 'status'
  ) {
    if (operationLock.current) return;
    operationLock.current = true;
    setBusy(true);
    setError('');
    onError('');
    setMessage('');
    try {
      await work();
      await reload();
    } catch (caught) {
      const detail = caught instanceof Error ? caught.message : '작업을 완료하지 못했어요.';
      setError(detail);
      onError(detail);
      if (caught instanceof ApiError && caught.status === 409) setConflict(scope);
      await reload().catch(() => undefined);
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
    setConfirmation(undefined);
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
    setConfirmation(undefined);
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
  async function saveConnection(body: Record<string, unknown>, id?: string, fromForm = true) {
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
      if (!id) {
        replaceDraft('model', () => startModelFor(saved));
      }
    }
    setConfirmation(undefined);
    setMessage(saved.title + (id ? ' 프로바이더 변경 저장됨' : ' 프로바이더 등록됨'));
  }
  async function saveModel(body: Record<string, unknown>, id?: string, fromForm = true) {
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
      navigate('models');
    }
    setConfirmation(undefined);
    setMessage(saved.title + (id ? ' 모델 변경 저장됨' : ' 모델 프리셋 등록됨'));
  }
  async function catalog(item: Connection) {
    const result = await api<Connection>(`/connections/${item.id}/catalog`, {});
    if (result.catalogError)
      throw new Error('모델 목록을 확인하지 못했어요. 마지막 저장 목록과 수동 모델 ID를 유지해요.');
    setMessage(
      result.protocol === 'vertex-gemini-v1' && !result.catalogCredentialEnv
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
    if (item.enabled)
      setConfirmation({
        kind: 'connection',
        id: item.id,
        title: item.title,
        body,
        fromForm: false,
      });
    else void perform(() => saveConnection(body, item.id, false));
  }
  function statusModel(item: ModelPreset) {
    const { id, revision, source: _, capabilityProtocol: _protocol, ...body } = item;
    const updated = { ...body, enabled: item.enabled === false, expectedRevision: revision };
    if (item.enabled !== false)
      setConfirmation({ kind: 'model', id, title: item.title, body: updated, fromForm: false });
    else void perform(() => saveModel(updated, id, false));
  }
  async function latest(kind: 'connection' | 'model') {
    const fresh = await api<Library>('/library');
    if (kind === 'connection' && editingConnection) {
      const value = fresh.connections.find((item) => item.id === editingConnection.id);
      if (!value) throw new Error('프로바이더를 찾지 못했어요.');
      showConnection(value, false, true);
    }
    if (kind === 'model' && editingModel) {
      const value = fresh.models.find((item) => item.id === editingModel.id);
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
      credentialEnv: template.credentialEnvDefault,
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

  return (
    <section
      className="connection-editor"
      data-testid="connection-editor"
      aria-label="프로바이더·모델 등록"
    >
      {discard && (
        <section
          className="provider-impact"
          role="alertdialog"
          aria-label="편집 중인 초안 확인"
          tabIndex={-1}
          ref={discardPanel}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            const kind = discard.kind;
            setDiscard(undefined);
            navigate(kind);
          }}
        >
          <strong>
            저장하지 않은 {discard.kind === 'connection' ? '프로바이더' : '모델'} 초안이 있어요
          </strong>
          <p>다른 항목을 편집하면 현재 초안이 교체돼요.</p>
          <DraftDiscardActions
            onContinue={() => {
              const kind = discard.kind;
              setDiscard(undefined);
              navigate(kind);
            }}
            onDiscard={() => {
              const action = discard.proceed;
              setDiscard(undefined);
              action();
            }}
            discardLabel="초안 버리고 계속"
          />
        </section>
      )}
      <div className="provider-workspace-heading" ref={heading} tabIndex={-1}>
        <div className="provider-workspace-navigation" aria-label="프로바이더·모델 등록 화면">
          <button
            type="button"
            className={
              ['connections', 'connection', 'providers'].includes(screen) ? 'selected' : 'secondary'
            }
            aria-label="프로바이더 관리"
            aria-pressed={['connections', 'connection', 'providers'].includes(screen)}
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
            className={screen === 'models' || screen === 'model' ? 'selected' : 'secondary'}
            aria-label="모델 프리셋"
            aria-pressed={screen === 'models' || screen === 'model'}
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
            disabled={busy}
            onClick={() => {
              void perform(async () => {
                await reload();
                setMessage('목록을 새로 읽었어요. 편집 초안은 유지돼요.');
              });
            }}
          />
        </div>
      </div>
      {(screen === 'models' || screen === 'connections') && (
        <>
          {(screen === 'models' ? library.models.length : library.connections.length) > 0 && (
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
          {!library.connections.length && (
            <div className="provider-welcome">
              <ConnectionIcon size={28} aria-hidden="true" />
              <h4>첫 프로바이더를 준비해요</h4>
              <p>프로바이더를 추가한 뒤 사용할 모델을 등록해요.</p>
              <button type="button" disabled={busy} onClick={newConnection}>
                프로바이더 추가 <ForwardIcon size={18} aria-hidden="true" />
              </button>
            </div>
          )}
          {library.connections.length > 0 && !library.models.length && screen === 'models' && (
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
      {(screen === 'connection' || screen === 'model' || screen === 'providers') && (
        <div className="provider-editor-heading">
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => {
              setSetup(false);
              navigate(screen === 'model' ? 'models' : 'connections');
            }}
          >
            <BackIcon size={16} />
            목록으로
          </button>
          {setup && (
            <ol className="provider-steps" aria-label="빠른 프로바이더 진행">
              <li aria-current={screen === 'providers' ? 'step' : undefined}>1. 프로바이더 종류</li>
              <li aria-current={screen === 'connection' ? 'step' : undefined}>2. 접속 정보</li>
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
            {PROVIDER_DEFINITIONS.filter((item) => item.id !== 'fixture-sse-v1').map((item) => (
              <button
                type="button"
                className="secondary provider-template"
                key={item.id}
                disabled={busy}
                onClick={() => startProvider(item.id)}
              >
                <span className="provider-template-icon">
                  <ConnectionIcon size={20} />
                </span>
                <strong>{item.label}</strong>
                <small>
                  {item.id === 'codex-app-server-v1'
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
      <section hidden={screen !== 'connections'} aria-label="저장한 프로바이더">
        <div className="connection-list provider-saved-list">
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
          {connections.length === 0 && library.connections.length > 0 && (
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
          {models.length === 0 && library.models.length > 0 && (
            <div className="provider-empty" role="status">
              <p>검색 조건에 맞는 모델이 없어요.</p>
              <button type="button" className="secondary" onClick={() => setQuery('')}>
                검색 지우기
              </button>
            </div>
          )}
        </div>
      </section>
      {confirmation && (
        <section ref={confirmationPanel} className="provider-impact" aria-label="비활성 영향 확인">
          <strong>{confirmation.title} · 비활성으로 바꿀까요?</strong>
          <p>
            {confirmation.kind === 'connection'
              ? '이 프로바이더를 사용하는 이후 호출이 차단돼요. 저장된 원고와 전역 역할의 모델 선택은 유지돼요.'
              : '새 모델 선택과 이 모델을 사용하는 이후 실행이 차단돼요. 전역 역할의 모델 선택은 유지돼요.'}
          </p>
          <p>이미 저장된 원문·번역과 과거 실행 기록은 바꾸지 않아요.</p>
          <div className="provider-actions">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                void perform(
                  () =>
                    confirmation.kind === 'connection'
                      ? saveConnection(confirmation.body, confirmation.id, confirmation.fromForm)
                      : saveModel(confirmation.body, confirmation.id, confirmation.fromForm),
                  confirmation.fromForm ? confirmation.kind : 'status'
                );
              }}
            >
              {confirmation.kind === 'connection' ? '프로바이더' : '모델'} 비활성 확인
            </button>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => setConfirmation(undefined)}
            >
              비활성 취소
            </button>
          </div>
          {conflict === 'status' && (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => {
                void perform(async () => {
                  await reload();
                  setConfirmation(undefined);
                  setConflict(null);
                  setMessage('최신 목록에서 대상을 다시 선택해 주세요.');
                });
              }}
            >
              최신 목록 다시 불러오기
            </button>
          )}
        </section>
      )}
      <form
        hidden={screen !== 'connection'}
        ref={connectionForm}
        className="editor-grid provider-management-form"
        aria-label="프로바이더 편집 양식"
        onSubmit={(event) => {
          event.preventDefault();
          const body = {
            ...connectionPayload(connection),
            ...(editingConnection ? { expectedRevision: editingConnection.revision } : {}),
          };
          if (editingConnection?.enabled && !connection.enabled) {
            setConfirmation({
              kind: 'connection',
              id: editingConnection.id,
              title: connection.title,
              body,
              fromForm: true,
            });
            return;
          }
          void perform(() => saveConnection(body, editingConnection?.id), 'connection');
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
            새 ID로 복제해요. 사용 허용은 꺼져 있으며, 아래에 복사된 서버 환경변수 이름을 확인한 뒤
            등록하세요.
          </p>
        )}
        {conflict === 'connection' && (
          <p className="error full" role="alert">
            다른 곳에서 프로바이더가 변경됐어요. 초안은 유지했어요. 최신 설정을 불러와 주세요.
          </p>
        )}
        <fieldset
          className="editor-fields full provider-connection-fields"
          disabled={busy || !!confirmation}
        >
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
                  credentialEnv: definition.credentialEnvDefault,
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
              credentialEnv={connection.credentialEnv}
              disabled={operationBusy}
              onBusy={setUploadingCredential}
              onRegistered={(value) =>
                setConnection((current) => ({
                  ...current,
                  credentialEnv: value.credentialEnv,
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
              readOnly={official || codex}
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
          <ProviderEndpointStatus protocol={connection.protocol} endpoint={connection.endpoint} />
          <label
            className="full"
            hidden={
              codex ||
              (vertex && connection.credentialEnv.startsWith('NARRATIVE_PROVIDER_VERTEX_FILE_'))
            }
          >
            서버 환경변수 이름
            <input
              aria-label="서버 환경변수 이름"
              autoComplete="off"
              required={official}
              pattern={CREDENTIAL_ENV_PATTERN}
              placeholder={vertex ? '비우면 서버 ADC 사용' : 'OPENAI_API_KEY'}
              value={connection.credentialEnv}
              onChange={(event) =>
                setConnection({ ...connection, credentialEnv: event.target.value })
              }
            />
          </label>
          {vertex && (
            <label className="full">
              Gemini 목록용 API 키 환경변수 이름 (선택)
              <input
                aria-label="Gemini 목록용 API 키 환경변수 이름"
                autoComplete="off"
                pattern={CREDENTIAL_ENV_PATTERN}
                placeholder="GEMINI_API_KEY"
                value={connection.catalogCredentialEnv}
                onChange={(event) =>
                  setConnection({ ...connection, catalogCredentialEnv: event.target.value })
                }
              />
              <small>
                비우면 앱 힌트 표만 목록으로 써요. 서버 환경변수 이름을 넣으면 모델 목록 새로고침이
                Gemini Developer API로 Gemini 모델과 토큰 한도를 받아와요. Agent Platform 실행
                인증과 별개인 API 키이며 생성 요청에는 쓰지 않아요.
              </small>
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
              ? '설정 → 에이전트에서 Uimori 전용 Codex 로그인을 준비해 주세요. 서버의 공식 Codex로 실행하며 API 키 방식으로 자동 전환하지 않아요.'
              : vertex && connection.credentialEnv.startsWith('NARRATIVE_PROVIDER_VERTEX_FILE_')
                ? '등록한 JSON으로 인증해요. 프로젝트 ID는 키 파일의 프로젝트와 같아야 해요.'
                : vertex
                  ? '환경변수 이름을 비우면 서버의 GOOGLE_APPLICATION_CREDENTIALS 파일로 인증해요. global에서 Gemini 모델에 연결해요.'
                  : connection.protocol === 'openai-chat-v1'
                    ? '기본 주소 뒤에 /chat/completions를 붙여요. 인증 없는 로컬 서버는 환경변수 이름을 비워 두세요.'
                    : '인증 키 값은 입력하지 마세요. 서버 환경변수에 인증 키를 설정하면 사용할 수 있어요. 주소 허용 상태는 위에서 확인해요.'}
          </small>
          {vertex && connection.credentialEnv.startsWith('NARRATIVE_PROVIDER_VERTEX_FILE_') && (
            <details className="provider-auth-settings full">
              <summary>고급 인증 설정</summary>
              <div className="provider-auth-settings-body">
                <small>
                  서버에 설정된 인증을 사용할 때 변경해 주세요. 프로바이더 변경을 저장하면 적용돼요.
                </small>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setConnection({ ...connection, credentialEnv: '' })}
                >
                  서버 ADC / 환경변수 방식으로 변경
                </button>
              </div>
            </details>
          )}
          {connection.protocol === 'vercel-chat-v1' && (
            <small className="full">
              Vercel AI Gateway key를 환경변수에 넣고 모델 ID는 공급자/모델 형식으로 지정해요.
            </small>
          )}
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
          <button className="primary" disabled={busy || !!confirmation}>
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
          const invalid = event.currentTarget.querySelector<HTMLInputElement | HTMLSelectElement>(
            'input:invalid,select:invalid,textarea:invalid'
          );
          if (invalid) {
            const section =
              invalid.closest<HTMLElement>('[data-model-section]')?.dataset.modelSection;
            setModelSection((section as typeof modelSection) || 'basic');
            for (
              let parent: HTMLElement | null = invalid.parentElement;
              parent && parent !== event.currentTarget;
              parent = parent.parentElement
            )
              if (parent instanceof HTMLDetailsElement) parent.open = true;
            requestAnimationFrame(() => {
              invalid.focus();
              invalid.reportValidity();
            });
            return;
          }
          if (!chosen) return;
          const optionError = modelDraftError(model, chosen, forcedVertexTier);
          if (optionError) {
            setModelSection('advanced');
            setError(optionError);
            onError(optionError);
            requestAnimationFrame(() =>
              modelForm.current
                ?.querySelector<HTMLElement>('[data-model-section="generation"]')
                ?.scrollIntoView({ block: 'nearest' })
            );
            return;
          }
          const body = {
            ...modelPayload(model, chosen),
            ...(editingModel ? { expectedRevision: editingModel.revision } : {}),
          };
          if (editingModel && editingModel.enabled !== false && !model.enabled) {
            setConfirmation({
              kind: 'model',
              id: editingModel.id,
              title: model.title,
              body,
              fromForm: true,
            });
            return;
          }
          void perform(() => saveModel(body, editingModel?.id), 'model');
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
        <fieldset className="editor-fields full" disabled={busy || !!confirmation}>
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
            <SaveButton
              label="모델 변경 저장"
              disabled={busy || !!confirmation || !chosen}
              aria-busy={busy}
            />
          ) : (
            <button className="primary" disabled={busy || !!confirmation || !chosen}>
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
            <li>
              모든 채팅의 이후 요청에 적용해요. 상태 계산의 독립 모델은 채팅 설정의 해당 작업
              설정에서 선택해요.
            </li>
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
