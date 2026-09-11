import { ProviderRejectionNotice } from './provider-rejection.js';
import { UploadIcon, CheckIcon, PowerIcon } from './ui-icons.js';
import { DeleteButton } from './DeleteButton.js';
import { useEffect, useRef, useState } from 'react';
import type { Connection, ModelRef, ModelPreset } from '../core/product.js';
import type { StateModule } from '../core/state.js';
import { ContextPanel } from './ContextPanel.js';
import type { StoryConfig, StoryDetail, StoryJob, StoryState } from '../core/story.js';
import { api, ApiError, labels } from './api.js';
import './story.css';
import { useModelSelection } from './model-selection.js';

type PanelProps = {
  chatId: string;
  branchId: string;
  headRevision: string | null;
  settingsRevision: number;
  profileRevision?: number;
  models: ModelPreset[];
  connections: Connection[];
  onChanged: () => void;
  onError: (message: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
  active?: boolean;
  hideHeading?: boolean;
  refreshKey?: unknown;
};
const id = encodeURIComponent;
const refKey = (value: ModelRef | null) => (value ? value.id : '');
const pending = (jobs: StoryJob[]) =>
  jobs.some((job) => job.status === 'queued' || job.status === 'running');
const readiness: Record<string, string> = {
  disabled: '사용 안 함',
  ready: '준비됨',
  pending: '상태 확인 중',
  stale: '이전 원고의 상태',
  historical: '이전 원고에 연결된 상태',
  completed: '확인 완료',
};
const sampleModule: StateModule = {
  id: 'synthetic-harbor',
  revision: 1,
  name: '합성 항구 예제',
  mode: 'authoritative',
  fields: {
    coins: { type: 'number', initial: 10, min: 0, max: 100, description: '합성 시험용 동전' },
  },
  rules: { 'buy-ticket': { field: 'coins', delta: -3 } },
};

/** Result guards cover navigation during reads, writes, file reads, and teardown. */
function useScope(key: string) {
  const scope = useRef({ key, alive: true, generation: 0 });
  if (scope.current.key !== key) {
    scope.current.key = key;
    scope.current.generation++;
  }
  useEffect(() => {
    scope.current.alive = true;
    return () => {
      scope.current.alive = false;
    };
  }, []);
  return () => {
    const captured = scope.current.generation;
    return () => scope.current.alive && scope.current.generation === captured;
  };
}

function ModelChoice({
  label,
  value,
  original,
  models,
  connections,
  canSelect,
  onChange,
}: {
  label: string;
  value: ModelRef | null;
  original: ModelRef | null;
  models: ModelPreset[];
  connections: Connection[];
  canSelect: (model: ModelPreset) => boolean;
  onChange: (value: ModelRef | null) => void;
}) {
  const selected = refKey(value);
  const retained = [
    ...new Map(
      [original, value]
        .filter((ref): ref is ModelRef => ref !== null)
        .map((ref) => [refKey(ref), ref])
    ).values(),
  ];
  return (
    <label>
      {label}
      <select
        value={selected}
        onChange={(event) => {
          const model = [...models, ...retained].find(
            (item) => refKey(item) === event.target.value
          );
          onChange(model ? { id: model.id } : null);
        }}
      >
        <option value="">모델 미지정</option>
        {retained
          .filter((ref) => !models.some((model) => refKey(model) === refKey(ref)))
          .map((ref) => (
            <option
              key={refKey(ref)}
              value={refKey(ref)}
              disabled={refKey(ref) !== refKey(original)}
            >
              선택한 모델 · 확인 필요
            </option>
          ))}
        {models
          .filter(
            (model) => canSelect(model) || retained.some((ref) => refKey(ref) === refKey(model))
          )
          .map((model) => (
            <option
              disabled={!canSelect(model) && refKey(model) !== refKey(original)}
              key={refKey(model)}
              value={refKey(model)}
            >
              {model.title} · {!canSelect(model) ? '비활성 · ' : ''}
              {connections.find((entry) => entry.id === model.connectionId)?.title ??
                '프로바이더 확인 필요'}
            </option>
          ))}
      </select>
      {selected && !models.some((model) => refKey(model) === selected && canSelect(model)) && (
        <small>
          저장된 선택은 유지되지만 새 실행은 차단돼요. 모델과 프로바이더를 활성화해 주세요.
        </small>
      )}
    </label>
  );
}

function StateValues({ state }: { state: StoryState | null }) {
  if (!state) return <p className="muted">아직 연결된 상태가 없어요.</p>;
  return (
    <>
      <small>{state.canonical ? '원고에 반영된 상태' : '참고 상태'}</small>
      <dl className="story-state-values">
        {Object.entries(state.values).map(([key, value]) => (
          <div key={key}>
            <dt>{key}</dt>
            <dd>{typeof value === 'boolean' ? (value ? '예' : '아니요') : String(value)}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}

export function StoryJobList({
  jobs,
  busy,
  act,
  rebuild,
}: {
  jobs: StoryJob[];
  busy: boolean;
  act?: (path: string) => void;
  rebuild?: (sourceId: string, kind: 'state') => void;
}) {
  return (
    <ul className="story-records">
      {jobs.map((job) => (
        <li key={job.id}>
          <div>
            <strong>상태 확인</strong> · {labels[job.status] ?? job.status}
            {job.mock && <small> · 모의 처리</small>}
          </div>
          {job.error && <p className="error">{job.error}</p>}
          {job.rejection && <ProviderRejectionNotice rejection={job.rejection} />}
          {act && (
            <div className="form-actions">
              {['failed', 'interrupted', 'cancelled'].includes(job.status) && (
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => act(`/story-jobs/${id(job.id)}/retry`)}
                >
                  다시 시도
                </button>
              )}
              {job.status === 'stale' && rebuild && (
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => rebuild(job.sourceRevision, job.kind)}
                >
                  최신 원문으로 다시 확인
                </button>
              )}
              {['queued', 'running'].includes(job.status) && (
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => act(`/story-jobs/${id(job.id)}/cancel`)}
                >
                  작업 취소
                </button>
              )}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

export function StoryPanel(props: PanelProps) {
  return <StoryPanelEditor key={`${props.chatId}/${props.branchId}`} {...props} />;
}

function StoryPanelEditor({
  chatId,
  branchId,
  headRevision,
  settingsRevision,
  profileRevision,
  models,
  connections,
  onChanged,
  onError,
  onDirtyChange,
  active = true,
  hideHeading = false,
  refreshKey,
}: PanelProps) {
  const { canSelect } = useModelSelection(models, connections);
  const capture = useScope(
    JSON.stringify([chatId, branchId, headRevision, settingsRevision, profileRevision])
  );
  const [detail, setDetail] = useState<StoryDetail | null>(null);
  const [draft, setDraft] = useState<StoryConfig | null>(null);
  const dirty = useRef(false);
  const request = useRef(0);
  const actionLock = useRef(false);
  const [busy, setBusy] = useState(false);
  // Only an in-flight write is an unsaved change; the reload after it is not.
  const [writing, setWriting] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [confirmReset, setConfirmReset] = useState<number | null>(null);
  const [contextDirty, setContextDirty] = useState(false);
  const [commandLabel, setCommandLabel] = useState('');
  const [commandText, setCommandText] = useState('');
  const commandKey = useRef(crypto.randomUUID());
  const runKeys = useRef(new Map<string, string>());
  const base = `/chats/${id(chatId)}`;
  const hasUnsavedChanges =
    writing || dirty.current || contextDirty || commandLabel.length > 0 || commandText.length > 0;
  useEffect(() => {
    onDirtyChange?.(hasUnsavedChanges);
  }, [hasUnsavedChanges, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  function report(caught: unknown) {
    const text = caught instanceof Error ? caught.message : '작업을 완료하지 못했어요.';
    setError(text);
    onError(text);
  }
  async function load() {
    const valid = capture(),
      sequence = ++request.current;
    try {
      const result = await api<StoryDetail>(`${base}/story?branchId=${id(branchId)}`);
      if (!valid() || sequence !== request.current) return;
      setDetail(result);
      if (!dirty.current) setDraft(result.config);
    } catch (caught) {
      if (valid() && sequence === request.current) report(caught);
    }
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: Only scope revisions reset actions; toggling visibility must preserve drafts and pending actions.
  useEffect(() => {
    actionLock.current = false;
    setBusy(false);
    setConfirmReset(null);
    setDetail(null);
  }, [chatId, branchId, headRevision, settingsRevision, profileRevision]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Reload on scope changes or reactivation; render-local load must not replace drafts on every render.
  useEffect(() => {
    if (active) void load();
  }, [active, chatId, branchId, headRevision, settingsRevision, profileRevision, refreshKey]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Pending snapshots and branch/head changes restart polling; local edits keep the existing timer.
  useEffect(() => {
    if (
      !active ||
      !detail ||
      !(
        pending(detail.jobs) ||
        detail.commands.some((command) => command.status === 'pending' && command.runId)
      )
    )
      return;
    const timer = setInterval(() => {
      void load();
    }, 1500);
    return () => clearInterval(timer);
  }, [active, detail, chatId, branchId, headRevision]);
  function change(next: StoryConfig) {
    dirty.current = true;
    setDraft(next);
    setConfirmReset(null);
    setMessage('');
  }
  async function act(path: string, body: unknown = {}, success?: () => void, method = 'POST') {
    if (actionLock.current) return;
    const valid = capture();
    actionLock.current = true;
    setBusy(true);
    setWriting(true);
    setError('');
    setMessage('');
    try {
      await api(path, body, method);
      if (!valid()) return;
      setWriting(false);
      success?.();
      await load();
      if (valid()) {
        setMessage('반영했어요.');
        onChanged();
      }
    } catch (caught) {
      if (valid()) {
        report(caught);
        if (caught instanceof ApiError && caught.status === 409) await load();
      }
    } finally {
      if (valid()) {
        actionLock.current = false;
        setBusy(false);
        setWriting(false);
      }
    }
  }
  async function importModule(file: File | undefined) {
    if (!file || !draft) return;
    const valid = capture();
    try {
      if (file.size > 100_000) throw new Error('상태 정의 파일은 100KB 이하로 선택해 주세요.');
      const parsed = JSON.parse(await file.text()) as StateModule;
      if (!valid()) return;
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        typeof parsed.name !== 'string' ||
        typeof parsed.id !== 'string' ||
        !Number.isSafeInteger(parsed.revision) ||
        !['annotation', 'continuity', 'authoritative'].includes(parsed.mode) ||
        !parsed.fields ||
        typeof parsed.fields !== 'object' ||
        Array.isArray(parsed.fields) ||
        !parsed.rules ||
        typeof parsed.rules !== 'object' ||
        Array.isArray(parsed.rules)
      )
        throw new Error(
          '상태 정의 형식을 확인해 주세요. 이름·필드·규칙이 있는 JSON 파일이 필요해요.'
        );
      dirty.current = true;
      setDraft((current) => (current ? { ...current, module: parsed } : current));
      setMessage('불러온 내용을 확인한 뒤 저장해 주세요. 아직 적용하지 않았어요.');
    } catch (caught) {
      if (valid()) report(caught);
    }
  }
  function runCommand(commandId: string) {
    const key = runKeys.current.get(commandId) ?? crypto.randomUUID();
    runKeys.current.set(commandId, key);
    void act(
      `/scene-commands/${id(commandId)}/run`,
      {
        expectedRevision: headRevision,
        expectedSettingsRevision: settingsRevision,
        ...(profileRevision === undefined ? {} : { expectedProfileRevision: profileRevision }),
        idempotencyKey: key,
      },
      () => {
        runKeys.current.delete(commandId);
      }
    );
  }
  return (
    <section className="story-panel" aria-label="이야기 상태와 문맥">
      {!hideHeading && <h3>상태와 문맥</h3>}
      <p className="muted">
        장면 상태와 다음 요청에 사용할 요약·메모를 관리해요. 문맥을 정리해도 원문은 보존해요.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {!draft ? (
        <button type="button" className="secondary" onClick={() => void load()}>
          설정 불러오기
        </button>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void act(
              `${base}/story/config`,
              {
                expectedRevision: draft.revision,
                branchId,
                module: draft.module,
                stateModel: draft.stateModel,
              },
              () => {
                dirty.current = false;
              },
              'PUT'
            );
          }}
        >
          <fieldset className="story-config-fields" disabled={busy}>
            <legend>다음 원고에 적용할 설정</legend>
            <section className="story-config-section" aria-label="상태 설정">
              <div className="story-config-heading">
                <div>
                  <h4>상태 정의</h4>
                  <p className="muted">
                    {draft.module
                      ? draft.module.name
                      : '사용 안 함 · JSON 파일을 불러오면 상태 확인을 사용할 수 있어요.'}
                  </p>
                </div>
                <div className="form-actions">
                  <label className="story-file secondary">
                    <UploadIcon size={18} aria-hidden="true" />
                    <span>JSON 불러오기</span>
                    <input
                      type="file"
                      accept=".json,application/json"
                      aria-label="상태 정의 JSON 파일"
                      onChange={(event) => {
                        void importModule(event.target.files?.[0]);
                        event.target.value = '';
                      }}
                    />
                  </label>
                  {draft.module && (
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => change({ ...draft, module: null })}
                    >
                      <PowerIcon size={18} aria-hidden="true" />
                      상태 사용 안 함
                    </button>
                  )}
                </div>
              </div>
              <details>
                <summary>합성 예제 살펴보기</summary>
                <p>
                  항구의 동전 10개에서 표를 사면 3개를 빼는 시험용 예제예요. 아래 버튼은 초안에만
                  넣어요.
                </p>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => change({ ...draft, module: structuredClone(sampleModule) })}
                >
                  합성 항구 예제를 초안에 넣기
                </button>
              </details>
              {draft.module && (
                <div className="story-module-preview">
                  <h4>저장 전 미리보기</h4>
                  <p>
                    {draft.module.name} ·{' '}
                    {
                      {
                        annotation: '표시용',
                        continuity: '연속성 참고',
                        authoritative: '규칙에 따른 상태 관리',
                      }[draft.module.mode]
                    }
                  </p>
                  <p>
                    필드 {Object.keys(draft.module.fields).length}개 · 변화 규칙{' '}
                    {Object.keys(draft.module.rules).length}개
                  </p>
                  <pre>{JSON.stringify(draft.module, null, 2)}</pre>
                </div>
              )}
              <ModelChoice
                label="상태 확인 모델"
                value={draft.stateModel}
                original={detail?.config.stateModel ?? null}
                models={models}
                connections={connections}
                canSelect={canSelect}
                onChange={(stateModel) => change({ ...draft, stateModel })}
              />
            </section>
            <div className="form-actions story-config-actions">
              <button className="secondary" disabled={!dirty.current}>
                <CheckIcon size={18} aria-hidden="true" />
                상태 설정 저장{' '}
              </button>
              {dirty.current && detail && draft.revision !== detail.config.revision && (
                <div>
                  <p role="alert">
                    저장된 설정이 바뀌었어요. 입력한 내용은 유지했어요. 현재 설정을 확인한 뒤 다시
                    저장해 주세요.
                  </p>
                  <details>
                    <summary>현재 저장된 설정 확인</summary>
                    <p>상태: {detail.config.module?.name ?? '사용 안 함'}</p>
                    <pre className="story-text-preview">
                      {JSON.stringify(detail.config, null, 2)}
                    </pre>
                  </details>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => {
                      change({ ...draft, revision: detail.config.revision });
                      setMessage('최신 설정을 기준으로 현재 초안을 다시 저장할 수 있어요.');
                    }}
                  >
                    현재 설정을 확인했어요 · 내 초안 유지
                  </button>
                </div>
              )}
            </div>
          </fieldset>
        </form>
      )}
      <ContextPanel
        chatId={chatId}
        branchId={branchId}
        headRevision={headRevision}
        notes={detail?.notes}
        notesRevision={detail?.notesRevision}
        active={active}
        refreshKey={refreshKey}
        onRefreshStory={load}
        onChanged={onChanged}
        onError={onError}
        onDirtyChange={setContextDirty}
      />
      {detail && (
        <>
          <section>
            <h4>현재 분기 상태 · {readiness[detail.stateStatus] ?? detail.stateStatus}</h4>
            <StateValues state={detail.state} />
            {detail.config.module && (
              <div className="story-reset-state">
                {confirmReset !== detail.config.revision ? (
                  <>
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy || dirty.current}
                      onClick={() => setConfirmReset(detail.config.revision)}
                    >
                      현재 장면에서 초기값으로 새 기준 적용
                    </button>
                    {dirty.current && (
                      <small>작성 중인 설정을 먼저 저장하면 새 기준을 적용할 수 있어요.</small>
                    )}
                  </>
                ) : (
                  <div role="group" aria-label="상태 새 기준 적용 확인">
                    <p>
                      현재 분기의 이 장면에서 <strong>{detail.config.module.name}</strong>의
                      초기값으로 다시 시작해요. 이전 원문과 과거 상태는 보존해요.
                    </p>
                    <p>
                      이 이야기의 설정이 바뀌고, 상태 확인을 기다리던 요청은 취소돼요. 아래 초기값을
                      확인한 뒤 적용해 주세요.
                    </p>
                    <dl className="story-state-values">
                      {Object.entries(detail.config.module.fields).map(([name, field]) => (
                        <div key={name}>
                          <dt>{name}</dt>
                          <dd>{String(field.initial)}</dd>
                        </div>
                      ))}
                    </dl>
                    <div className="form-actions">
                      <button
                        type="button"
                        className="secondary"
                        disabled={busy || dirty.current}
                        onClick={() =>
                          void act(
                            `${base}/story/config`,
                            {
                              expectedRevision: detail.config.revision,
                              branchId,
                              module: detail.config.module,
                              stateModel: detail.config.stateModel,
                              resetState: true,
                            },
                            () => {
                              setConfirmReset(null);
                            },
                            'PUT'
                          )
                        }
                      >
                        확인했어요 · 초기값으로 새 기준 적용
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        disabled={busy}
                        onClick={() => setConfirmReset(null)}
                      >
                        적용 취소
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </section>
          <details
            open={detail.jobs.some((job) =>
              ['failed', 'stale', 'interrupted'].includes(job.status)
            )}
          >
            <summary>상태 작업 {detail.jobs.length}개</summary>
            <StoryJobList
              jobs={detail.jobs}
              busy={busy}
              act={(path) => void act(path)}
              rebuild={(sourceId, kind) =>
                void act(`/sources/${id(sourceId)}/story/rebuild`, { kind })
              }
            />
            {!detail.jobs.length && <p className="muted">아직 실행한 작업이 없어요.</p>}
          </details>
          <details>
            <summary>장면 예약 {detail.commands.length}개</summary>
            <p>
              이 분기에서 실행할 장면을 예약해요. 원고가 성공적으로 완성되면 사용 완료로 표시해요.
            </p>
            <ul className="story-records">
              {detail.commands.map((command) => (
                <li key={command.id}>
                  <strong>{command.label}</strong> ·{' '}
                  {
                    {
                      pending: '예약됨',
                      consumed: '사용 완료',
                      failed: '실패 · 재시도 가능',
                      cancelled: '취소됨',
                    }[command.status]
                  }
                  <p>{command.request}</p>
                  {['pending', 'failed'].includes(command.status) && (
                    <div className="form-actions">
                      <button
                        type="button"
                        className="secondary"
                        disabled={busy || Boolean(command.runId && command.status === 'pending')}
                        onClick={() => runCommand(command.id)}
                      >
                        {command.runId && command.status === 'pending'
                          ? '실행 요청됨'
                          : '이 장면 쓰기'}
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        disabled={busy}
                        onClick={() => void act(`/scene-commands/${id(command.id)}/cancel`)}
                      >
                        예약 취소
                      </button>
                    </div>
                  )}
                  <DeleteButton
                    path={`/scene-commands/${id(command.id)}`}
                    title={command.label}
                    label="예약 삭제"
                    disabled={busy}
                    description="아직 실행하지 않은 장면 예약을 영구 삭제해요. 실행 기록에 연결된 예약은 해당 분기·채팅과 함께 삭제해야 해요."
                    onError={onError}
                    onDeleted={async () => {
                      await load();
                      onChanged();
                    }}
                  />
                </li>
              ))}
            </ul>
            <form
              className="editor-grid"
              onSubmit={(event) => {
                event.preventDefault();
                void act(
                  `${base}/scene-commands`,
                  {
                    label: commandLabel,
                    request: commandText,
                    branchId,
                    idempotencyKey: commandKey.current,
                  },
                  () => {
                    setCommandLabel('');
                    setCommandText('');
                    commandKey.current = crypto.randomUUID();
                  }
                );
              }}
            >
              <label>
                예약 이름
                <input
                  required
                  maxLength={160}
                  value={commandLabel}
                  onChange={(event) => {
                    setCommandLabel(event.target.value);
                    commandKey.current = crypto.randomUUID();
                  }}
                  disabled={busy}
                />
              </label>
              <label className="full">
                장면 요청
                <textarea
                  required
                  maxLength={10000}
                  value={commandText}
                  onChange={(event) => {
                    setCommandText(event.target.value);
                    commandKey.current = crypto.randomUUID();
                  }}
                  disabled={busy}
                />
              </label>
              <button
                className="secondary"
                disabled={busy || !commandLabel.trim() || !commandText.trim()}
              >
                장면 예약 추가
              </button>
            </form>
          </details>
        </>
      )}
    </section>
  );
}

export function StorySourceState({
  sourceId,
  refreshKey,
}: {
  sourceId: string;
  refreshKey?: unknown;
}) {
  return <SourceState key={sourceId} sourceId={sourceId} refreshKey={refreshKey} />;
}
function SourceState({ sourceId, refreshKey }: { sourceId: string; refreshKey?: unknown }) {
  const refresh = useRef({ value: refreshKey, generation: 0 });
  if (!Object.is(refresh.current.value, refreshKey)) {
    refresh.current.value = refreshKey;
    refresh.current.generation++;
  }
  const capture = useScope(`${sourceId}/${refresh.current.generation}`);
  const generation = useRef(0);
  const [detail, setDetail] = useState<{
    state: StoryState | null;
    status: string;
    jobs: StoryJob[];
  } | null>(null);
  const [error, setError] = useState('');
  async function load() {
    const valid = capture(),
      current = ++generation.current;
    try {
      const next = await api<NonNullable<typeof detail>>(`/sources/${id(sourceId)}/story`);
      if (valid() && generation.current === current) {
        setDetail(next);
        setError('');
      }
    } catch (caught) {
      if (valid() && generation.current === current) setError((caught as Error).message);
    }
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: Source changes and host refreshes reload state; render-local load must not retrigger its own results.
  useEffect(() => {
    void load();
  }, [sourceId, refreshKey]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Pending snapshots and source changes restart polling; local edits keep the existing timer.
  useEffect(() => {
    if (!detail || !pending(detail.jobs)) return;
    const timer = setInterval(() => {
      void load();
    }, 1500);
    return () => clearInterval(timer);
  }, [detail, sourceId]);
  return (
    <div className="story-source-state">
      {error && (
        <p role="alert" className="error">
          {error}
          <button type="button" className="secondary" onClick={() => void load()}>
            다시 확인
          </button>
        </p>
      )}
      {detail && detail.status !== 'disabled' && (
        <details>
          <summary>이 원고의 상태 · {readiness[detail.status] ?? detail.status}</summary>
          <StateValues state={detail.state} />
          <StoryJobList jobs={detail.jobs} busy={false} />
        </details>
      )}
    </div>
  );
}
