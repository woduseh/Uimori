import { Switch } from './BooleanControls.js';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  behaviorActionTriggers,
  validateBehaviorValue,
  type BehaviorAction,
  type BehaviorActionTrigger,
  type BehaviorSchema,
  type PackageBehavior,
} from '../core/package-behavior.js';
import type { RuntimeValue } from '../core/prompt-program.js';
import type { PackageRequest } from '../core/package-request.js';
import { api, ApiError } from './api.js';
import { Dialog } from './Dialog.js';
import { CloseIcon, ResetIcon } from './ui-icons.js';
import './package.css';

type Instance = {
  instanceId: string;
  packageId: string;
  packageRevision: number;
  role: string;
  title: string;
  behavior: PackageBehavior;
  stateRevision: number;
  state: unknown;
  status: 'ready' | 'pending' | 'stale';
  error?: string;
  lastAction?: {
    actionId: string;
    result: RuntimeValue;
    stateRevision: number;
    trigger: BehaviorActionTrigger;
  };
};
type Snapshot = {
  sourceHash: string | null;
  pendingRequest?: PackageRequest | null;
  instances: Instance[];
};
type Props = {
  chatId: string;
  branchId?: string;
  refreshKey?: unknown;
  onChange?: () => void;
  onRunRequest?: (text: string, requestId: string) => void;
};
const display = (value: unknown) =>
  value === null || value === undefined
    ? '미확인'
    : typeof value === 'boolean'
      ? value
        ? '켜짐'
        : '꺼짐'
      : String(value);
const named = (value: object, fallback: string) => (value as { label?: string }).label || fallback;
const methodLabels = {
  user: '사용자 버튼',
  'before-turn': '생성 전 자동',
  model: '모델 요청',
} as const;
function ActionMethods({ action }: { action: BehaviorAction }) {
  const triggers = behaviorActionTriggers(action);
  return (
    <div className="behavior-method-badges" aria-label="호출 방법">
      {triggers.length ? (
        triggers.map((trigger) => <span key={trigger}>{methodLabels[trigger]}</span>)
      ) : (
        <span>실행 안 함</span>
      )}
    </div>
  );
}

function StateValue({ value, schema }: { value: unknown; schema?: BehaviorSchema }) {
  if (Array.isArray(value))
    return value.length ? (
      <ol className="behavior-list">
        {value.map((item, i) => (
          <li key={i}>
            <StateValue value={item} schema={schema?.type === 'list' ? schema.items : undefined} />
          </li>
        ))}
      </ol>
    ) : (
      <span className="muted">비어 있어요</span>
    );
  if (value && typeof value === 'object')
    return (
      <dl className="behavior-values">
        {Object.entries(value).map(([key, item]) => {
          const child = schema?.type === 'record' ? schema.properties[key] : undefined;
          return (
            <div key={key}>
              <dt>{child ? named(child, key) : key}</dt>
              <dd>
                <StateValue value={item} schema={child} />
              </dd>
            </div>
          );
        })}
      </dl>
    );
  return <span>{display(value)}</span>;
}
function initialInput(schema: BehaviorSchema): unknown {
  switch (schema.type) {
    case 'boolean':
      return false;
    case 'number':
      return Math.max(schema.min, Math.min(schema.max, 0));
    case 'string':
      return '';
    case 'enum':
      return schema.values[0];
    case 'list':
      return [];
    case 'record':
      return Object.fromEntries(
        Object.entries(schema.properties).map(([key, child]) => [key, initialInput(child)])
      );
  }
}
// Complex inputs keep their exact draft text until the explicit action submission.
function InputField({
  schema,
  value,
  onChange,
  label,
}: {
  schema: BehaviorSchema;
  value: unknown;
  onChange: (value: unknown) => void;
  label: string;
}) {
  const helpId = useId();
  if (schema.type === 'boolean')
    return (
      <label className="check">
        <Switch
          aria-label={label}
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
        />
        {label}
      </label>
    );
  if (schema.type === 'enum')
    return (
      <label>
        {label}
        <select
          aria-label={label}
          value={String(schema.values.findIndex((item) => item === value))}
          onChange={(e) => onChange(schema.values[Number(e.target.value)])}
        >
          {schema.values.map((item, i) => (
            <option key={i} value={i}>
              {display(item)}
            </option>
          ))}
        </select>
      </label>
    );
  if (schema.type === 'number')
    return (
      <label>
        {label}
        <input
          type="number"
          aria-label={label}
          aria-describedby={helpId}
          min={schema.min}
          max={schema.max}
          step={schema.integer ? 1 : 'any'}
          required
          value={value === '' ? '' : Number(value)}
          onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
        />
        <small id={helpId}>
          {schema.min} ~ {schema.max}
        </small>
      </label>
    );
  if (schema.type === 'string')
    return (
      <label>
        {label}
        <input
          aria-label={label}
          maxLength={schema.maxLength}
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
        />
      </label>
    );
  return (
    <label>
      {label} · JSON
      <textarea
        aria-label={`${label} · JSON`}
        aria-describedby={helpId}
        rows={4}
        spellCheck={false}
        value={typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
        onChange={(e) => onChange(e.target.value)}
      />
      <small id={helpId}>목록과 중첩 값은 JSON으로 입력해요. 실행 전 형식을 검사해요.</small>
    </label>
  );
}
function ActionForm({
  action,
  disabled,
  run,
}: {
  action: BehaviorAction;
  disabled: boolean;
  run: (actionId: string, input: unknown) => Promise<void>;
}) {
  const [input, setInput] = useState<unknown>(() => initialInput(action.inputSchema));
  const [error, setError] = useState('');
  const schema = action.inputSchema;
  const fields = schema.type === 'record' ? Object.entries(schema.properties) : null;
  const title = named(action, action.id);
  async function submit() {
    setError('');
    try {
      const decode = (s: BehaviorSchema, v: unknown) =>
        (s.type === 'list' || s.type === 'record') && typeof v === 'string'
          ? (JSON.parse(v) as unknown)
          : v;
      const parsed = fields
        ? Object.fromEntries(
            fields.map(([key, child]) => [
              key,
              decode(child, (input as Record<string, unknown>)[key]),
            ])
          )
        : decode(schema, input);
      await run(action.id, validateBehaviorValue(schema, parsed));
    } catch {
      setError('입력값의 형식과 범위를 확인해 주세요. 입력한 내용은 유지돼요.');
    }
  }
  return (
    <form
      className="behavior-action"
      onSubmit={(e) => {
        e.preventDefault();
        if (!disabled) void submit();
      }}
    >
      <fieldset disabled={disabled}>
        <legend>{title}</legend>
        {(action as { description?: string }).description && (
          <p className="muted">{(action as { description?: string }).description}</p>
        )}
        <ActionMethods action={action} />
        {fields ? (
          fields.map(([key, child]) => (
            <InputField
              key={key}
              schema={child}
              label={named(child, key)}
              value={(input as Record<string, unknown>)[key]}
              onChange={(v) =>
                setInput((old: unknown) => ({ ...(old as Record<string, unknown>), [key]: v }))
              }
            />
          ))
        ) : (
          <InputField schema={schema} label="입력값" value={input} onChange={setInput} />
        )}
        <button type="submit" className="secondary">
          {title}
        </button>
      </fieldset>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </form>
  );
}

export function PackageBehaviorPanel(props: Props) {
  return <BehaviorPanel key={`${props.chatId}:${props.branchId ?? ''}`} {...props} />;
}
function BehaviorPanel({ chatId, branchId, refreshKey, onChange, onRunRequest }: Props) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [resetTarget, setResetTarget] = useState<string | null>(null);
  const epoch = useRef(0),
    mounted = useRef(true),
    actionLock = useRef(false);
  const endpoint = `/chats/${encodeURIComponent(chatId)}/package-behaviors`;
  const readEndpoint = endpoint + (branchId ? `?branchId=${encodeURIComponent(branchId)}` : '');
  const refresh = useCallback(async () => {
    const request = ++epoch.current;
    setLoading(true);
    try {
      const result = await api<Snapshot>(readEndpoint);
      if (mounted.current && request === epoch.current) setSnapshot(result);
    } catch (e) {
      if (mounted.current && request === epoch.current) setError((e as Error).message);
    } finally {
      if (mounted.current && request === epoch.current) setLoading(false);
    }
  }, [readEndpoint]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      epoch.current++;
    };
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Host refresh events reload state even when the branch endpoint is unchanged.
  useEffect(() => {
    void refresh();
  }, [refresh, refreshKey]);
  async function run(instance: Instance, actionId: string, input: unknown, reset = false) {
    if (
      actionLock.current ||
      loading ||
      !snapshot ||
      (reset ? instance.status === 'pending' : instance.status !== 'ready')
    )
      return;
    actionLock.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    const request = ++epoch.current;
    try {
      const result = await api<Snapshot>(
        `${endpoint}/${encodeURIComponent(instance.instanceId)}/${reset ? 'reset' : 'actions'}`,
        {
          branchId,
          ...(reset ? {} : { actionId, input }),
          expectedStateRevision: instance.stateRevision,
          expectedSourceHash: snapshot.sourceHash,
          idempotencyKey: crypto.randomUUID(),
        }
      );
      if (mounted.current) {
        if (request === epoch.current) setSnapshot(result);
        setResetTarget(null);
        setNotice(
          reset
            ? '현재 원문에 맞춰 초깃값으로 복구했어요.'
            : instance.behavior.actions.find((action) => action.id === actionId)?.effects.length ===
                0
              ? '행동 결과를 계산했어요.'
              : '상태에 반영했어요.'
        );
        onChange?.();
      }
    } catch (e) {
      if (mounted.current) {
        setError((e as Error).message);
        if (e instanceof ApiError && e.status === 409) await refresh();
      }
    } finally {
      actionLock.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function cancelRequest(id: string) {
    if (actionLock.current) return;
    actionLock.current = true;
    setBusy(true);
    setError('');
    try {
      await api(
        `/chats/${encodeURIComponent(chatId)}/package-requests/${encodeURIComponent(id)}`,
        { branchId },
        'DELETE'
      );
      if (mounted.current) {
        await refresh();
        setNotice('다음 요청 예약을 취소했어요.');
        onChange?.();
      }
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      actionLock.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const resetInstance = snapshot?.instances.find((instance) => instance.instanceId === resetTarget);
  if (!loading && !error && snapshot?.instances.length === 0) return null;
  return (
    <section
      className="package-behavior-panel"
      aria-label="패키지 상태와 행동"
      aria-busy={loading || busy}
    >
      <header>
        <h2>패키지 상태와 행동</h2>
        <button
          type="button"
          className="ghost"
          disabled={loading || busy}
          onClick={() => {
            setError('');
            void refresh();
          }}
        >
          새로고침
        </button>
      </header>
      <p className="muted">현재 채팅의 상태와 사용할 수 있는 행동이에요.</p>
      {snapshot?.instances.some((instance) =>
        instance.behavior.actions.some((action) =>
          behaviorActionTriggers(action).some((trigger) => trigger !== 'user')
        )
      ) && (
        <p className="muted">
          자동 실행과 모델 요청은 같은 장면에서 결과를 다시 뽑지 않아요. 원문 생성이 끝나면 상태에
          반영하고, 취소하면 반영하지 않아요.
        </p>
      )}
      {loading && <p role="status">상태를 읽고 있어요…</p>}
      {busy && <p role="status">행동을 반영하고 있어요…</p>}
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {snapshot?.pendingRequest && (
        <aside className="behavior-action-result" aria-label="예약된 다음 요청">
          <h3>예약: {snapshot.pendingRequest.label}</h3>
          <p>{snapshot.pendingRequest.request}</p>
          <p className="muted">
            현재 장면과 설정에 연결된 요청이에요. 원문을 생성할 때 한 번 사용해요.
          </p>
          <div className="form-actions">
            {onRunRequest && (
              <button
                type="button"
                disabled={busy || loading}
                onClick={() =>
                  onRunRequest(snapshot.pendingRequest!.request, snapshot.pendingRequest!.id)
                }
              >
                작성란에 넣기
              </button>
            )}
            <button
              type="button"
              className="secondary"
              disabled={busy || loading}
              onClick={() => void cancelRequest(snapshot.pendingRequest!.id)}
            >
              예약 취소
            </button>
          </div>
        </aside>
      )}
      {snapshot?.instances.map((instance) => (
        <article
          className="behavior-instance"
          key={instance.instanceId}
          aria-label={instance.title}
        >
          <h3>{instance.title}</h3>
          <small>
            {({ bot: '봇', persona: '페르소나', module: '모듈' } as Record<string, string>)[
              instance.role
            ] ?? instance.role}{' '}
            · 상태 {instance.stateRevision}
          </small>
          {instance.status !== 'ready' && (
            <p role="status">
              {instance.status === 'pending'
                ? '이전 작업을 기다리고 있어요. 완료되면 새로고침해 주세요.'
                : '원문이 변경됐어요. 현재 원문에 맞는 상태가 준비되면 행동할 수 있어요.'}
            </p>
          )}
          {instance.error && (
            <p role="alert" className="error">
              {instance.error === 'BEHAVIOR_MIGRATION_REQUIRED'
                ? '최신 자료의 상태 정의가 바뀌었어요. 기존 상태를 확인한 뒤 초깃값으로 복구해 주세요.'
                : instance.error}
            </p>
          )}
          <StateValue value={instance.state} schema={instance.behavior.stateSchema} />
          {instance.lastAction && (
            <section
              className="behavior-action-result"
              aria-label="최근 행동 결과"
              aria-live="polite"
            >
              <h4>
                {named(
                  instance.behavior.actions.find(
                    (action) => action.id === instance.lastAction!.actionId
                  ) ?? {},
                  instance.lastAction.actionId
                )}{' '}
                결과
              </h4>
              <small>
                {methodLabels[instance.lastAction.trigger]} · 상태{' '}
                {instance.lastAction.stateRevision}에서 기록
              </small>
              <StateValue value={instance.lastAction.result} />
            </section>
          )}
          {(instance.status === 'stale' || instance.error) && instance.status !== 'pending' && (
            <button
              type="button"
              className="secondary"
              disabled={busy || loading}
              onClick={() => setResetTarget(instance.instanceId)}
            >
              초깃값으로 복구
            </button>
          )}
          <div className="behavior-actions">
            {instance.behavior.actions.map((action) =>
              behaviorActionTriggers(action).includes('user') ? (
                <ActionForm
                  key={`${instance.instanceId}:${instance.behavior.revision}:${action.id}`}
                  action={action}
                  disabled={busy || loading || instance.status !== 'ready'}
                  run={(id, input) => run(instance, id, input)}
                />
              ) : (
                <div className="behavior-action-summary" key={action.id}>
                  <strong>{named(action, action.id)}</strong>
                  <ActionMethods action={action} />
                  {action.description && <p className="muted">{action.description}</p>}
                </div>
              )
            )}
          </div>
        </article>
      ))}
      <Dialog
        open={!!resetInstance}
        role="alertdialog"
        title="상태 초깃값 복구 확인"
        onClose={() => setResetTarget(null)}
      >
        {resetInstance && (
          <>
            <p>
              “{resetInstance.title}”의 현재 상태를 이 패키지의 초깃값으로 바꿔요. 이전 상태 이력과
              원문은 보존돼요.
            </p>
            {/* A failed reset leaves this open, and the panel's own error sits behind it. */}
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <div className="form-actions">
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => setResetTarget(null)}
              >
                <CloseIcon size={18} aria-hidden="true" />
                취소
              </button>
              <button
                type="button"
                className="danger"
                disabled={busy || loading}
                onClick={() => void run(resetInstance, '', null, true)}
              >
                <ResetIcon size={18} aria-hidden="true" />
                초깃값 복구 확인
              </button>
            </div>
          </>
        )}
      </Dialog>
    </section>
  );
}
