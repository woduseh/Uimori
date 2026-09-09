import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatOptionState } from '../core/chat-options.js';
import {
  reconcilePromptValues,
  visiblePromptControls,
  type PromptProgram,
  type PromptValue,
} from '../core/prompt-program.js';
import { api, ApiError } from './api.js';
import { SelectionCheckbox } from './BooleanControls.js';
import { PromptControlFields } from './PromptControlFields.js';

type Values = Record<string, PromptValue>;
type Props = {
  chatId: string;
  branchId: string;
  active: boolean;
  disabled: boolean;
  workspaceRevision?: number;
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void;
};
type Operation = {
  path: string;
  body: Record<string, unknown>;
  kind: 'fixed' | 'oneoff' | 'delegation' | 'cancel' | 'revoke';
};
const sameValues = (left: Values, right: Values) => {
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && left[key] === right[key])
  );
};
function reviewedValues(program: PromptProgram, values: Values): Values {
  const reconciled = reconcilePromptValues(program, values);
  return Object.fromEntries(
    program.controls
      .filter(
        (control) => Object.hasOwn(values, control.id) && !reconciled.resetKeys.includes(control.id)
      )
      .map((control) => [control.id, values[control.id]!])
  );
}

export function ChatOptionSettings(props: Props) {
  const [base, setBase] = useState<ChatOptionState | null>(null);
  const [latest, setLatest] = useState<ChatOptionState | null>(null);
  const [fixed, setFixed] = useState<Values>({});
  const [oneoff, setOneoff] = useState<Values>({});
  const [fields, setFields] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [conflict, setConflict] = useState(false);
  const [uncertain, setUncertain] = useState<Operation | null>(null);
  const lock = useRef(false),
    requestVersion = useRef(0);
  const fixedDirty = !!base && !sameValues(fixed, base.fixedValues);
  const dirty = fixedDirty || Object.keys(oneoff).length > 0 || fields.length > 0 || !!uncertain;
  const current = useRef({ base, fixed, oneoff, fields, dirty, fixedDirty });
  current.current = { base, fixed, oneoff, fields, dirty, fixedDirty };
  const path = `/chats/${encodeURIComponent(props.chatId)}/options`;
  const refresh = useCallback(
    async (review = false) => {
      if (lock.current) return;
      const version = ++requestVersion.current;
      setLoading(true);
      try {
        const state = await api<ChatOptionState>(
          `${path}?branchId=${encodeURIComponent(props.branchId)}`
        );
        if (version !== requestVersion.current) return;
        const draft = current.current;
        setLatest(state);
        if (review || !draft.base || !draft.dirty) {
          setBase(state);
          if (review && draft.dirty) {
            const nextFixed = draft.fixedDirty
              ? reviewedValues(state.program, draft.fixed)
              : state.fixedValues;
            const nextOneoff = reviewedValues(state.program, draft.oneoff);
            setFixed(nextFixed);
            setOneoff(nextOneoff);
            setFields(
              draft.fields.filter((id) =>
                state.program.controls.some((control) => control.id === id)
              )
            );
            setMessage(
              '최신 옵션 정의에서 사용할 수 있는 초안을 유지했어요. 값을 확인한 뒤 적용해 주세요.'
            );
          } else setFixed(state.fixedValues);
          setConflict(false);
          setError('');
        } else if (
          state.revision !== draft.base.revision ||
          state.workspaceRevision !== draft.base.workspaceRevision ||
          state.headRevision !== draft.base.headRevision
        ) {
          setConflict(true);
        }
      } catch (caught) {
        if (version === requestVersion.current) setError((caught as Error).message);
      } finally {
        if (version === requestVersion.current) setLoading(false);
      }
    },
    [path, props.branchId]
  );
  useEffect(() => {
    if (!props.active || props.disabled) return;
    void refresh();
    const update = () => void refresh();
    addEventListener('focus', update);
    addEventListener('uimori-helper-updated', update);
    addEventListener('chat-options-changed', update);
    return () => {
      removeEventListener('focus', update);
      removeEventListener('uimori-helper-updated', update);
      removeEventListener('chat-options-changed', update);
    };
  }, [props.active, props.disabled, refresh]);
  useEffect(() => {
    if (
      props.active &&
      !props.disabled &&
      props.workspaceRevision !== undefined &&
      props.workspaceRevision !== current.current.base?.workspaceRevision
    )
      void refresh();
  }, [props.active, props.disabled, props.workspaceRevision, refresh]);
  useEffect(() => {
    props.onDirtyChange(dirty);
    return () => props.onDirtyChange(false);
  }, [dirty, props.onDirtyChange]);
  useEffect(() => {
    props.onBusyChange(busy);
    return () => props.onBusyChange(false);
  }, [busy, props.onBusyChange]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    addEventListener('beforeunload', warn);
    return () => removeEventListener('beforeunload', warn);
  }, [dirty]);
  useEffect(
    () => () => {
      requestVersion.current++;
    },
    []
  );
  async function execute(operation: Operation) {
    if (lock.current || props.disabled) return;
    lock.current = true;
    requestVersion.current++;
    setBusy(true);
    setLoading(false);
    setError('');
    try {
      const accepted = await api<ChatOptionState>(operation.path, operation.body);
      setBase(accepted);
      setLatest(accepted);
      if (operation.kind === 'fixed') setFixed(accepted.fixedValues);
      if (operation.kind === 'oneoff') setOneoff({});
      if (operation.kind === 'delegation') setFields([]);
      setConflict(false);
      setUncertain(null);
      setMessage(
        {
          fixed: '이 채팅의 고정 옵션을 저장했어요.',
          oneoff: '다음 생성에 한 번 사용할 옵션을 예약했어요.',
          delegation: '선택한 옵션의 지속 위임을 시작했어요.',
          cancel: '다음 생성의 옵션 예약을 취소했어요.',
          revoke: '지속 위임을 해제했어요.',
        }[operation.kind]
      );
      dispatchEvent(new Event('chat-options-changed'));
    } catch (caught) {
      const known = caught instanceof ApiError && caught.status < 500;
      setUncertain(known ? null : operation);
      if (caught instanceof ApiError && caught.status === 409) setConflict(true);
      setError(
        known
          ? `${(caught as Error).message} 입력한 초안은 유지했어요.`
          : '반영 여부를 확인하지 못했어요. 같은 요청을 다시 확인하면 중복 적용하지 않아요.'
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  function submit(kind: Operation['kind'], suffix: string, input: Record<string, unknown> = {}) {
    if (!base || conflict || uncertain || loading) return;
    void execute({
      kind,
      path: `${path}/${suffix}`,
      body: {
        branchId: props.branchId,
        expectedRevision: base.revision,
        operationId: crypto.randomUUID(),
        ...input,
      },
    });
  }
  if (!base)
    return (
      <div className="chat-options-body">
        {error ? (
          <>
            <p role="alert">{error}</p>
            <button type="button" disabled={loading} onClick={() => void refresh()}>
              채팅 옵션 다시 불러오기
            </button>
          </>
        ) : (
          <p role="status">채팅 옵션을 불러오는 중이에요…</p>
        )}
      </div>
    );
  const disabled = busy || props.disabled || !!uncertain;
  const blocked = disabled || conflict || loading;
  const displayState = latest ?? base;
  const activeDelegations = displayState.delegations.filter((item) => !item.revokedAt);
  const revokedDelegations = displayState.delegations.filter((item) => item.revokedAt);
  const fieldLabel = (id: string) =>
    base.program.controls.find((control) => control.id === id)?.label ?? id;
  return (
    <>
      <div className="chat-options-body chat-specific-options">
        <section aria-label="이 채팅 고정 옵션">
          <h3>고정 옵션</h3>
          <p className="muted">
            체크한 옵션은 이 채팅에 적용해요. 나머지는 모든 채팅 설정을 따라요.
          </p>
          <fieldset className="chat-options-fields" disabled={disabled}>
            <SelectiveValues
              program={base.program}
              inherited={base.globalValues}
              values={fixed}
              onChange={setFixed}
              mode="fixed"
            />
            {(Object.keys(base.fixedValues).length > 0 || displayState.conflicts.length > 0) && (
              <button
                type="button"
                className="secondary"
                disabled={blocked}
                onClick={() => submit('fixed', 'fixed', { binding: base.binding, values: {} })}
              >
                고정 옵션 모두 해제
              </button>
            )}
          </fieldset>
        </section>
        <details className="chat-options-extra">
          <summary>다음 생성에만 적용</summary>
          <p className="muted">현재 분기의 다음 생성에 한 번 사용하고 해제해요.</p>
          <fieldset className="chat-options-fields" disabled={disabled}>
            <SelectiveValues
              program={base.program}
              inherited={{ ...base.globalValues, ...base.fixedValues }}
              values={oneoff}
              onChange={setOneoff}
              mode="oneoff"
            />
            <button
              type="button"
              disabled={blocked || Object.keys(oneoff).length === 0}
              onClick={() =>
                submit('oneoff', 'oneoff', {
                  binding: base.binding,
                  values: oneoff,
                  expectedHeadRevision: base.headRevision,
                })
              }
            >
              1회 옵션 예약
            </button>
          </fieldset>
        </details>
        {displayState.pending.filter((item) => item.status === 'pending').length > 0 && (
          <section aria-label="다음 생성 옵션 예약" className="chat-options-pending">
            <h3>다음 생성 옵션 예약</h3>
            {displayState.pending
              .filter((item) => item.status === 'pending')
              .map((item) => (
                <div key={item.id} className="chat-option-record">
                  <strong>{item.kind === 'delegated' ? '도우미가 조정한 옵션' : '1회 옵션'}</strong>
                  <OptionValues values={item.values} fieldLabel={fieldLabel} />
                  <button
                    type="button"
                    disabled={blocked}
                    onClick={() =>
                      submit('cancel', `pending/${encodeURIComponent(item.id)}/cancel`)
                    }
                  >
                    예약 취소
                  </button>
                </div>
              ))}
          </section>
        )}
        <details className="chat-options-extra">
          <summary>도우미에게 옵션 조정 위임</summary>
          <p className="muted">
            이 채팅의 현재 분기에서 선택한 옵션만 계속 조정하도록 허용해요. 위임은 직접 해제할
            때까지 유지돼요.
          </p>
          {activeDelegations.map((item) => (
            <div key={item.id} className="chat-option-record">
              <strong>지속 위임 중</strong>
              <p>{item.fields.map(fieldLabel).join(', ')}</p>
              <small>{new Date(item.startedAt).toLocaleString()} 시작</small>
              <button
                type="button"
                disabled={blocked}
                onClick={() =>
                  submit('revoke', `delegations/${encodeURIComponent(item.id)}/revoke`)
                }
              >
                지속 위임 해제
              </button>
            </div>
          ))}
          <fieldset className="chat-options-fields chat-delegation-fields" disabled={disabled}>
            <legend>조정을 허용할 옵션</legend>
            {base.program.controls.map((control) => (
              <label key={control.id} className="chat-option-selection">
                <SelectionCheckbox
                  checked={fields.includes(control.id)}
                  onChange={(event) =>
                    setFields((currentFields) =>
                      event.target.checked
                        ? [...currentFields, control.id]
                        : currentFields.filter((id) => id !== control.id)
                    )
                  }
                />
                <span>{control.label}</span>
              </label>
            ))}
            <button
              type="button"
              disabled={blocked || fields.length === 0}
              onClick={() =>
                submit('delegation', 'delegations', {
                  binding: base.binding,
                  fields: base.program.controls
                    .filter((control) => fields.includes(control.id))
                    .map((control) => control.id),
                })
              }
            >
              선택한 옵션 지속 위임
            </button>
          </fieldset>
          {revokedDelegations.length > 0 && (
            <details className="chat-options-revocations">
              <summary>해제한 위임 {revokedDelegations.length}개</summary>
              {revokedDelegations.map((item) => (
                <div key={item.id} className="chat-option-record">
                  <p>{item.fields.map(fieldLabel).join(', ')}</p>
                  <small>{new Date(item.revokedAt!).toLocaleString()} 해제</small>
                </div>
              ))}
            </details>
          )}
        </details>
        {displayState.conflicts.map((item) => (
          <p role="alert" key={item}>
            {item}
          </p>
        ))}
        {conflict && (
          <p role="alert">
            채팅이나 전체 옵션이 바뀌었어요. 초안을 유지했어요. 최신 내용을 확인한 뒤 다시 적용해
            주세요.
          </p>
        )}
        {error && <p role="alert">{error}</p>}
        {message && <p role="status">{message}</p>}
        {uncertain && (
          <button
            type="button"
            disabled={busy || props.disabled}
            onClick={() => void execute(uncertain)}
          >
            같은 요청 다시 확인
          </button>
        )}
        {!uncertain && (error || conflict) && (
          <button type="button" disabled={busy || loading} onClick={() => void refresh(true)}>
            최신 정의에 초안 유지
          </button>
        )}
      </div>
      <footer className="chat-options-footer">
        <small>
          {dirty ? '저장하지 않은 옵션 초안이 있어요.' : '고정 옵션은 이 채팅에 적용해요.'}
        </small>
        <div>
          <button
            type="button"
            disabled={busy || loading || !!uncertain}
            onClick={() => void refresh()}
          >
            최신 상태 확인
          </button>
          <button
            type="button"
            disabled={!fixedDirty || blocked}
            onClick={() => submit('fixed', 'fixed', { binding: base.binding, values: fixed })}
          >
            {busy ? '적용 중…' : '채팅 고정 옵션 저장'}
          </button>
        </div>
      </footer>
    </>
  );
}

function SelectiveValues({
  program,
  inherited,
  values,
  onChange,
  mode,
}: {
  program: PromptProgram;
  inherited: Values;
  values: Values;
  onChange: (values: Values) => void;
  mode: 'fixed' | 'oneoff';
}) {
  const effective = { ...inherited, ...values };
  let controls: PromptProgram['controls'];
  let visibilityValues: Values;
  try {
    visibilityValues = reconcilePromptValues(program, effective).values;
    controls = visiblePromptControls(program.controls, visibilityValues);
  } catch {
    return <p role="alert">옵션 표시 조건을 확인하지 못했어요. 프롬프트 정의를 확인해 주세요.</p>;
  }
  if (program.controls.length === 0)
    return <p className="muted">현재 프롬프트에 조정할 옵션이 없어요.</p>;
  return (
    <div className="chat-selective-values">
      {controls.map((control) => {
        const selected = Object.hasOwn(values, control.id);
        return (
          <div key={control.id} className="chat-option-choice">
            <label className="chat-option-selection">
              <SelectionCheckbox
                aria-label={`${control.label} ${mode === 'fixed' ? '이 채팅에 고정' : '다음 생성에만 적용'}`}
                checked={selected}
                onChange={(event) => {
                  if (event.target.checked)
                    onChange({
                      ...values,
                      [control.id]: Object.hasOwn(effective, control.id)
                        ? effective[control.id]!
                        : control.default,
                    });
                  else {
                    const next = { ...values };
                    delete next[control.id];
                    onChange(next);
                  }
                }}
              />
              <span>{mode === 'fixed' ? '이 채팅에 고정' : '다음 생성에만 적용'}</span>
            </label>
            <fieldset className="chat-option-value" disabled={!selected}>
              <PromptControlFields
                program={{ ...program, controls: [{ ...control, visibleWhen: undefined }] }}
                values={{
                  [control.id]: Object.hasOwn(effective, control.id)
                    ? effective[control.id]!
                    : control.default,
                }}
                visibilityValues={{ [control.id]: visibilityValues[control.id]! }}
                onChange={(id, value) => onChange({ ...values, [id]: value })}
              />
            </fieldset>
          </div>
        );
      })}
    </div>
  );
}

function OptionValues({
  values,
  fieldLabel,
}: {
  values: Values;
  fieldLabel: (id: string) => string;
}) {
  return (
    <dl className="chat-option-values">
      {Object.entries(values).map(([id, value]) => (
        <div key={id}>
          <dt>{fieldLabel(id)}</dt>
          <dd>
            {value === null
              ? '미설정'
              : typeof value === 'boolean'
                ? value
                  ? '켬'
                  : '끔'
                : String(value)}
          </dd>
        </div>
      ))}
    </dl>
  );
}
