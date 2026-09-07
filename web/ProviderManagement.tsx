import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Boxes, Plus, Plug, Search } from 'lucide-react';
import { VertexCredentialUpload } from './VertexCredentialUpload.js';
import { ProviderCatalogPicker } from './ProviderCatalogPicker.js';
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
import { ProviderRegistrationAssistant } from './ProviderRegistrationAssistant.js';
import { ProviderModelTest, useProviderModelTests } from './ProviderModelTest.js';
import './ProviderManagement.css';

const versionRef = (item: { id: string; revision: number }) => `${item.id}@${item.revision}`;
type ConnectionDraft = {
  title: string;
  protocol: ProviderProtocol;
  endpoint: string;
  credentialEnv: string;
  enabled: boolean;
};
const initialConnection = (): ConnectionDraft => ({
  title: '',
  protocol: 'fixture-sse-v1',
  endpoint: '',
  credentialEnv: '',
  enabled: false,
});
const connectionDraft = (item: Connection): ConnectionDraft => ({
  title: item.title,
  protocol: item.protocol,
  endpoint: item.endpoint,
  credentialEnv: item.credentialEnv ?? '',
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
const capability = (value: boolean | null | undefined) =>
  value === true ? '사용자 확인 · 지원' : value === false ? '사용자 확인 · 미지원' : '미확인';

export function ConnectionEditor({
  library,
  reload,
  onError,
}: {
  library: Library;
  reload: () => Promise<void>;
  onError: (error: string) => void;
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
  const [modelSection, setModelSection] = useState<'basic' | 'generation' | 'advanced'>('basic');
  const heading = useRef<HTMLDivElement>(null);
  function navigate(next: typeof screen) {
    setConfirmation(undefined);
    setDiscard(undefined);
    setScreen(next);
    requestAnimationFrame(() => {
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
  const official = ['anthropic-messages-v1', 'vercel-chat-v1'].includes(connection.protocol);
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
    setMessage(item.title + ' 연결을 삭제했어요.');
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
      label="연결 삭제"
      description="이 연결을 사용하는 모델 프리셋을 먼저 삭제해 주세요. 서버에 등록한 인증 파일과 과거 실행 기록은 유지돼요."
      disabled={busy}
      onDeleted={() => deletedConnection(item)}
      onError={onError}
    />
  );
  const deleteModel = (item: ModelPreset) => (
    <DeleteButton
      path={`/model-presets/${encodeURIComponent(item.id)}`}
      revision={item.revision}
      title={item.title}
      label="모델 삭제"
      description="이 모델을 사용 중인 이야기 설정을 먼저 변경해 주세요. 과거 실행에 저장된 모델 설정은 유지돼요."
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
    setMessage(saved.title + (id ? ' 연결 변경 저장됨' : ' 연결 등록됨'));
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
      result.protocol === 'vertex-gemini-v1'
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
    const {
      id,
      revision,
      source: _,
      capabilityProtocol: _protocol,
      capabilityRevision: _capability,
      ...body
    } = item;
    const updated = { ...body, enabled: item.enabled === false, expectedRevision: revision };
    if (item.enabled !== false)
      setConfirmation({ kind: 'model', id, title: item.title, body: updated, fromForm: false });
    else void perform(() => saveModel(updated, id, false));
  }
  async function latest(kind: 'connection' | 'model') {
    const fresh = await api<Library>('/library');
    if (kind === 'connection' && editingConnection) {
      const value = fresh.connections.find((item) => item.id === editingConnection.id);
      if (!value) throw new Error('연결을 찾지 못했어요.');
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
    <section className="connection-editor" data-testid="connection-editor" aria-label="연결과 모델">
      {discard && (
        <section
          className="provider-impact"
          role="alertdialog"
          aria-label="편집 중인 초안 확인"
          tabIndex={-1}
          ref={discardPanel}
        >
          <strong>
            저장하지 않은 {discard.kind === 'connection' ? '연결' : '모델'} 초안이 있어요
          </strong>
          <p>다른 항목을 편집하면 현재 초안이 교체돼요.</p>
          <div className="provider-actions">
            <button
              type="button"
              onClick={() => {
                const action = discard.proceed;
                setDiscard(undefined);
                action();
              }}
            >
              초안 버리고 계속
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                const kind = discard.kind;
                setDiscard(undefined);
                navigate(kind);
              }}
            >
              계속 편집
            </button>
          </div>
        </section>
      )}
      <div className="provider-workspace-heading" ref={heading} tabIndex={-1}>
        <p className="muted">연결은 한 번 준비하고, 모델별 설정은 프리셋으로 관리해요.</p>
        <div className="provider-workspace-navigation" aria-label="연결과 모델 화면">
          <button
            type="button"
            className={screen === 'models' ? 'selected' : 'secondary'}
            aria-label="모델 프리셋"
            aria-pressed={screen === 'models'}
            disabled={busy}
            onClick={() => {
              setSetup(false);
              navigate('models');
            }}
          >
            <Boxes size={17} />
            모델 프리셋 <span>{library.models.length}</span>
          </button>
          <button
            type="button"
            className={screen === 'connections' ? 'selected' : 'secondary'}
            aria-label="연결 관리"
            aria-pressed={screen === 'connections'}
            disabled={busy}
            onClick={() => {
              setSetup(false);
              navigate('connections');
            }}
          >
            <Plug size={17} />
            연결 관리 <span>{library.connections.length}</span>
          </button>
          <button
            type="button"
            className="secondary provider-refresh"
            disabled={busy}
            onClick={() => {
              void perform(async () => {
                await reload();
                setMessage('목록을 새로 읽었어요. 편집 초안은 유지돼요.');
              });
            }}
          >
            목록 새로고침
          </button>
        </div>
      </div>
      {(screen === 'models' || screen === 'connections') && (
        <>
          <div className="provider-toolbar">
            <label className="provider-search">
              <Search size={16} aria-hidden="true" />
              <input
                type="search"
                aria-label="연결·모델 검색"
                placeholder={
                  screen === 'models'
                    ? '프리셋 이름, 모델 ID로 검색'
                    : '연결 이름, 제공자, 주소로 검색'
                }
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <div className="provider-actions">
              <button
                type="button"
                disabled={busy}
                onClick={() => (screen === 'connections' ? newConnection() : newModel())}
              >
                <Plus size={16} />
                {screen === 'connections' ? '새 연결 입력' : '새 모델 입력'}
              </button>
              {screen === 'models' && (
                <button type="button" className="secondary" disabled={busy} onClick={newConnection}>
                  빠른 연결 시작
                </button>
              )}
            </div>
          </div>
          {screen === 'connections' && connectionStarted && (
            <button
              type="button"
              className="provider-resume secondary"
              disabled={busy}
              onClick={() => navigate('connection')}
            >
              연결 편집 이어서 · {connection.title || '이름 없는 초안'}
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
          {!library.connections.length && screen === 'models' && (
            <div className="provider-welcome">
              <Plug size={28} />
              <h4>첫 모델을 연결해 보세요</h4>
              <p>제공자를 고르고 연결 정보를 저장한 뒤 사용할 모델을 선택해요.</p>
              <button type="button" disabled={busy} onClick={newConnection}>
                제공자 선택하기 <ArrowRight size={16} />
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
            <ArrowLeft size={16} />
            목록으로
          </button>
          {setup && (
            <ol className="provider-steps" aria-label="빠른 연결 진행">
              <li aria-current={screen === 'providers' ? 'step' : undefined}>1 제공자</li>
              <li aria-current={screen === 'connection' ? 'step' : undefined}>2 연결</li>
              <li aria-current={screen === 'model' ? 'step' : undefined}>3 모델</li>
            </ol>
          )}
        </div>
      )}
      {screen === 'providers' && (
        <section className="provider-selection" aria-label="제공자 선택">
          <h4>어디에 연결할까요?</h4>
          <p className="muted">
            현재 지원하는 연결 방식이에요. 선택하면 주소와 인증 참조의 기본값을 채워요.
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
                  <Plug size={20} />
                </span>
                <strong>{item.label}</strong>
                <small>
                  {item.id === 'codex-app-server-v1'
                    ? '개인 ChatGPT 구독 · 서버 실행'
                    : item.id === 'vertex-gemini-v1'
                      ? 'Gemini 모델 연결 · global'
                      : item.id === 'openai-chat-v1'
                        ? '호환 API 또는 로컬 서버'
                        : '서버 API 키 인증'}
                </small>
                <ArrowRight size={16} />
              </button>
            ))}
          </div>
          <details className="provider-test-template">
            <summary>개발·검사용 연결</summary>
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
      <section hidden={screen !== 'connections'} aria-label="저장한 연결">
        <h3>
          저장한 연결 <small>{connections.length}개</small>
        </h3>
        <div className="connection-list provider-saved-list">
          {connections.map((item) => (
            <article
              className="compact-card"
              key={versionRef(item)}
              aria-label={item.title + ' 연결'}
            >
              <div className="provider-section-heading">
                <strong>{item.title}</strong>
                <span className="provider-status">{item.enabled ? '사용 허용' : '비활성'}</span>
              </div>
              <small>
                {providerDefinition(item.protocol).label}
                {item.protocol === 'vertex-gemini-v1' ? ' · global' : ''}
              </small>
              <code>{item.endpoint}</code>
              {item.catalogError && (
                <p className="error">모델 목록 조회 실패 · 마지막 저장 목록을 유지해요.</p>
              )}
              <div className="provider-actions">
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  aria-label={item.title + ' 연결 수정'}
                  onClick={() => showConnection(item)}
                >
                  수정
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  aria-label={item.title + ' 연결 복제'}
                  onClick={() => showConnection(item, true)}
                >
                  복제
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  aria-label={item.title + ' 연결 ' + (item.enabled ? '비활성' : '활성화')}
                  onClick={() => statusConnection(item)}
                >
                  {item.enabled ? '비활성' : '활성화'}
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
                  모델 입력에 사용
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
                  {item.protocol === 'vertex-gemini-v1'
                    ? '로컬 지원 모델 확인'
                    : '모델 목록 새로고침'}
                </button>
                {deleteConnection(item)}
              </div>
            </article>
          ))}
          {connections.length === 0 && (
            <p className="provider-empty">
              {filter ? '검색 조건에 맞는 연결이 없어요.' : '아직 저장한 연결이 없어요.'}
            </p>
          )}
        </div>
      </section>
      <section
        hidden={screen !== 'models'}
        className="registered-models"
        aria-label="저장한 모델 프리셋"
      >
        <h3>
          저장한 모델 프리셋 <small>{models.length}개</small>
        </h3>
        <div className="provider-saved-list">
          {models.map((item) => (
            <article
              className="compact-card"
              key={versionRef(item)}
              aria-label={item.title + ' 모델'}
            >
              <div className="provider-section-heading">
                <strong>{item.title}</strong>
                <span className="provider-status">
                  {item.enabled === false ? '비활성' : '모델 활성'}
                </span>
              </div>
              <small>
                {item.modelId} ·{' '}
                {library.connections.find((c) => c.id === item.connectionId)?.protocol ===
                'codex-app-server-v1'
                  ? '출력 목표'
                  : '최대'}{' '}
                {item.maxOutputTokens.toLocaleString()} 토큰
                {item.timeoutMs !== undefined && ` · 제한 ${item.timeoutMs / 1000}초`}
              </small>
              <small>
                {library.connections.find((c) => c.id === item.connectionId)?.title ??
                  '연결 확인 필요'}
              </small>
              <details className="provider-capabilities">
                <summary>기능·출처·가격 확인</summary>
                <p>모델별 공급자 기능: 미확인 · 가격: 미확인</p>
                <p>
                  도구 호출: {capability(item.userOverrides?.tools)}
                  <br />
                  구조화 출력: {capability(item.userOverrides?.structuredOutput)}
                </p>
                {item.userOverrides?.note && (
                  <p className="provider-override-note">사용자 메모: {item.userOverrides.note}</p>
                )}
                <p>
                  등록 출처:{' '}
                  {item.source?.kind === 'catalog'
                    ? '목록에서 선택'
                    : item.source?.kind === 'manual'
                      ? '직접 입력'
                      : '미기록'}
                  <br />
                  목록 확인일: {item.source?.catalogUpdatedAt ?? '미확인'}
                </p>
              </details>
              <div className="provider-actions">
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  aria-label={item.title + ' 모델 수정'}
                  onClick={() => {
                    void perform(() => showModel(item), 'model');
                  }}
                >
                  수정
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  aria-label={item.title + ' 모델 복제'}
                  onClick={() => {
                    void perform(() => showModel(item, true), 'model');
                  }}
                >
                  복제
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
                  {item.enabled === false ? '활성화' : '비활성'}
                </button>
                {deleteModel(item)}
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
          {models.length === 0 && (
            <p className="provider-empty">
              {filter ? '검색 조건에 맞는 모델이 없어요.' : '아직 저장한 모델 프리셋이 없어요.'}
            </p>
          )}
        </div>
      </section>
      {confirmation && (
        <section ref={confirmationPanel} className="provider-impact" aria-label="비활성 영향 확인">
          <strong>{confirmation.title} · 비활성으로 바꿀까요?</strong>
          <p>
            {confirmation.kind === 'connection'
              ? '이 연결을 사용하는 기존 이야기의 다음 호출도 차단돼요. 저장된 원고와 이야기의 모델 선택은 유지돼요.'
              : '새 모델 선택과 기존 이야기의 다음 실행이 차단돼요. 저장된 모델 선택은 유지돼요.'}
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
              {confirmation.kind === 'connection' ? '연결' : '모델'} 비활성 확인
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
        aria-label="연결 편집 양식"
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
          {editingConnection ? '연결 수정' : connectionCopy ? '연결 복제 검토' : '연결 등록'}
        </h3>
        {editingConnection && (
          <div className="provider-draft-note full">
            <p>
              저장한 변경은 다음 신규 생성부터 적용돼요. 진행 중이거나 완료된 실행의 설정은
              유지돼요.
            </p>
            {library.connections.find((item) => item.id === editingConnection.id)?.revision !==
              editingConnection.revision && (
              <p>다른 곳에서 연결이 변경됐어요. 입력한 초안은 유지했어요.</p>
            )}
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => {
                void perform(() => latest('connection'), 'connection');
              }}
            >
              최신 연결 설정 불러오기
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
            다른 곳에서 연결이 변경됐어요. 초안은 유지했어요. 최신 설정을 불러와 주세요.
          </p>
        )}
        <fieldset className="editor-fields full" disabled={busy || !!confirmation}>
          <label>
            연결 이름
            <input
              aria-label="연결 이름"
              required
              maxLength={160}
              value={connection.title}
              onChange={(event) => setConnection({ ...connection, title: event.target.value })}
            />
          </label>
          <label>
            연결 프로토콜
            <select
              aria-label="연결 프로토콜"
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
          <label className="check">
            <input
              type="checkbox"
              checked={connection.enabled}
              onChange={(event) => setConnection({ ...connection, enabled: event.target.checked })}
            />
            이 연결 사용
          </label>
          <small className="full">
            {codex ? (
              '설정 → 에이전트에서 Uimori 전용 Codex 로그인을 준비해 주세요. 서버의 공식 Codex로 실행하며 API 키 방식으로 자동 전환하지 않아요.'
            ) : vertex && connection.credentialEnv.startsWith('NARRATIVE_PROVIDER_VERTEX_FILE_') ? (
              <>
                <span>
                  등록한 JSON으로 인증해요. 프로젝트 ID는 키 파일의 프로젝트와 같아야 해요.
                </span>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setConnection({ ...connection, credentialEnv: '' })}
                >
                  서버 ADC / 환경변수 방식으로 변경
                </button>
              </>
            ) : vertex ? (
              '환경변수 이름을 비우면 서버의 GOOGLE_APPLICATION_CREDENTIALS 파일로 인증해요. global에서 Gemini 모델에 연결해요.'
            ) : connection.protocol === 'openai-chat-v1' ? (
              '기본 주소 뒤에 /chat/completions를 붙여요. 인증 없는 로컬 서버는 환경변수 이름을 비워 두세요.'
            ) : (
              '인증 키 값은 입력하지 마세요. 서버 환경변수에 인증 키를 설정하면 사용할 수 있어요. 주소 허용 상태는 위에서 확인해요.'
            )}
          </small>
          {connection.protocol === 'vercel-chat-v1' && (
            <small className="full">
              Vercel AI Gateway key를 환경변수에 넣고 모델 ID는 공급자/모델 형식으로 지정해요.
            </small>
          )}
          <details className="provider-definition full">
            <summary>연결 템플릿 정보</summary>
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
            <p>연결 템플릿은 로컬 구현의 설명이에요. 모델별 기능과 가격은 미확인이에요.</p>
          </details>
        </fieldset>
        <div className="provider-actions full">
          <button disabled={busy || !!confirmation}>
            {editingConnection ? '연결 변경 저장' : '연결 등록'}
          </button>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => navigate('connections')}
          >
            연결 편집 끝내기
          </button>
          {editingConnection && deleteConnection(editingConnection)}
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
            setModelSection('generation');
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
        {editingModel && (
          <div className="provider-draft-note full">
            <p>
              저장한 변경은 이 모델을 사용하는 다음 신규 생성부터 적용돼요. 진행 중이거나 완료된
              실행의 설정은 유지돼요.
            </p>
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
          <p className="provider-draft-note full">
            설정과 연결을 검토하고 새 ID로 등록해요. 원래 모델과 이야기의 선택은 바뀌지 않아요.
          </p>
        )}
        {conflict === 'model' && (
          <p className="error full" role="alert">
            다른 곳에서 모델이 변경됐어요. 초안은 유지했어요. 최신 설정을 불러와 주세요.
          </p>
        )}
        <div className="provider-model-tabs full" aria-label="모델 편집 항목">
          {(['basic', 'generation', 'advanced'] as const).map((section, index) => (
            <button
              type="button"
              className={modelSection === section ? 'selected' : 'secondary'}
              aria-pressed={modelSection === section}
              key={section}
              onClick={() => setModelSection(section)}
            >
              {['기본 정보', '생성 설정', '고급 옵션'][index]}
            </button>
          ))}
        </div>
        <fieldset className="editor-fields full" disabled={busy || !!confirmation}>
          <div className="provider-model-section full" hidden={modelSection !== 'basic'}>
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
              모델 연결
              <select
                aria-label="모델 연결"
                required
                value={model.connectionRef}
                onChange={(event) => {
                  const item = modelConnections.find((item) => item.id === event.target.value);
                  if (item) chooseConnection(item);
                  else setModel({ ...model, connectionRef: '' });
                }}
              >
                <option value="">연결 선택</option>
                {model.connectionRef && !chosen && (
                  <option value={model.connectionRef} disabled>
                    연결 확인 필요
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
                    비활성 연결을 사용하는 모델은 새로 실행할 수 없어요. 연결을 활성화하면 다시
                    사용할 수 있어요.
                  </p>
                )}
                <details className="provider-readiness-details full">
                  <summary>연결 준비 상태와 목록 새로고침</summary>
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
                setModel((current) => ({
                  ...current,
                  modelId: item.id,
                  title:
                    !current.title ||
                    current.title === current.modelId ||
                    current.title ===
                      chosen?.catalog.find((entry) => entry.id === current.modelId)?.name
                      ? item.name
                      : current.title,
                }))
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
        <div className="provider-actions full">
          <button
            disabled={
              busy ||
              !!confirmation ||
              !chosen ||
              (model.evaluationToolsEnabled && model.userOverrides?.tools === false)
            }
          >
            {editingModel ? '모델 변경 저장' : '모델 프리셋 등록'}
          </button>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => navigate('models')}
          >
            모델 편집 끝내기
          </button>
          {editingModel && deleteModel(editingModel)}
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
          <p>비활성 연결로 등록했다면 연결을 활성화한 뒤 역할에 배정해 주세요.</p>
          <ol>
            <li>설정 창을 닫고 새 이야기에서 본문·번역 모델을 선택해요.</li>
            <li>
              기존 이야기는 이야기 설정 → 모델에서 필요한 역할을 선택하고 저장해요. 상태·기억은
              이야기 설정의 해당 작업 설정에서 선택해요.
            </li>
          </ol>
          <small>
            {registeredModel.enabled === false
              ? '지금은 새 선택에서 제외된 모델이에요. 활성화한 뒤 새로 배정할 수 있어요.'
              : '역할 선택 전에는 기존 이야기의 모델을 바꾸지 않아요.'}
          </small>
        </section>
      )}
      <div hidden={screen !== 'models'}>
        <ProviderRegistrationAssistant library={library} reload={reload} onError={onError} />
      </div>
    </section>
  );
}
