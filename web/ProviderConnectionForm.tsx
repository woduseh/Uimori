import type { ReactNode, RefObject, Dispatch, SetStateAction } from 'react';
import type { Connection, ProviderProtocol } from '../core/product.js';
import { PROVIDER_DEFINITIONS, providerDefinition } from '../core/provider-definitions.js';
import { Switch } from './BooleanControls.js';
import { VertexCredentialUpload } from './VertexCredentialUpload.js';
import type { ProviderEditorState, ConnectionDraft } from './provider-editor-state.js';

type Props = {
  hidden: boolean;
  draft: ProviderEditorState['connection'];
  connections: Connection[];
  conflict: boolean;
  busy: boolean;
  operationBusy: boolean;
  formRef: RefObject<HTMLFormElement | null>;
  onChange: Dispatch<SetStateAction<ConnectionDraft>>;
  onUploadBusy: (busy: boolean) => void;
  onSubmit: () => Promise<boolean>;
  onReload: () => void;
  onDone: () => void;
  deleteAction: ReactNode;
};
export function ProviderConnectionForm({
  hidden,
  draft,
  connections,
  conflict,
  busy,
  operationBusy,
  formRef,
  onChange,
  onUploadBusy,
  onSubmit,
  onReload,
  onDone,
  deleteAction,
}: Props) {
  const {
    value: connection,
    editing: editingConnection,
    copy: connectionCopy,
    baseline: connectionBaseline,
  } = draft;
  const codex = connection.protocol === 'codex-app-server-v1';
  const vertex = connection.protocol === 'vertex-gemini-v1';
  const definition = providerDefinition(connection.protocol);
  const endpointLabel = codex
    ? 'Codex 실행 위치'
    : vertex
      ? 'Google Agent Platform endpoint'
      : connection.protocol === 'fixture-sse-v1'
        ? '로컬 endpoint'
        : 'API 기본 주소';
  return (
    <form
      hidden={hidden}
      ref={formRef}
      className="editor-grid provider-management-form"
      aria-label="프로바이더 편집 양식"
      onSubmit={(event) => {
        event.preventDefault();
        void onSubmit();
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
            저장한 변경은 다음 신규 생성부터 적용돼요. 진행 중이거나 완료된 실행의 설정은 유지돼요.
          </p>
          {connections.find((item) => item.id === editingConnection.id)?.revision !==
            editingConnection.revision && (
            <p>다른 곳에서 프로바이더가 변경됐어요. 입력한 초안은 유지했어요.</p>
          )}
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => {
              onReload();
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
      {conflict && (
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
              onChange({
                ...connection,
                protocol,
                endpoint: definition.endpointDefault,
                credentialRef: '',
                apiKey: undefined,
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
            onChange={(event) => onChange({ ...connection, title: event.target.value })}
          />
        </label>
        {vertex && (
          <VertexCredentialUpload
            credentialRef={connection.credentialRef}
            disabled={operationBusy}
            onBusy={onUploadBusy}
            onRegistered={(value) =>
              onChange((current) => ({
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
                onChange({
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
            onChange={(event) => onChange({ ...connection, endpoint: event.target.value })}
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
              onChange={(event) => onChange({ ...connection, apiKey: event.target.value })}
            />
            {connection.credentialRef && (
              <button
                type="button"
                className="ghost"
                onClick={() => onChange({ ...connection, apiKey: null, credentialRef: '' })}
              >
                등록한 키 삭제
              </button>
            )}
          </label>
        )}
        <label className="check">
          <Switch
            checked={connection.enabled}
            onChange={(event) => onChange({ ...connection, enabled: event.target.checked })}
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
                : '로그인한 에이전트 모델 목록'}
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
        {editingConnection && deleteAction}
        <small className="provider-save-status">
          {editingConnection
            ? JSON.stringify(connection) === connectionBaseline
              ? '저장한 프로바이더예요.'
              : '아직 저장하지 않은 변경이 있어요.'
            : '아직 저장하지 않은 프로바이더예요.'}
        </small>
        <button type="button" className="secondary" disabled={busy} onClick={() => onDone()}>
          프로바이더 편집 끝내기
        </button>
        <button className="primary" disabled={busy}>
          {editingConnection ? '프로바이더 변경 저장' : '프로바이더 등록'}
        </button>
      </div>
    </form>
  );
}
