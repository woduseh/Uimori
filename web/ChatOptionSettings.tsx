import { t, useI18n, translateMessage, messageRef, message as uiMessage } from './i18n.js';
import { LoadingState } from './LoadingState.js';
import { NoticeBanner } from './NoticeBanner.js';
import { TransientNotice } from './TransientNotice.js';
import {
  promptControls,
  reconcilePromptValues,
  type PromptControl,
  type RisuPrompt,
  type PromptValue,
} from '../core/risu-prompt.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatOptionState } from '../core/chat-options.js';
import { api, ApiError } from './api.js';
import { PromptControlFields } from './PromptControlFields.js';
import { PromptOptionGroup } from './PromptOptionGroup.js';
import { ToggleRow } from './ToggleRow.js';
import { SaveButton } from './SaveButton.js';
import {
  editOptionDraft,
  optionDraftValues,
  reviewOptionDraft,
  type OptionDraft,
  type OptionScope,
} from './chat-option-draft.js';
import { SaveConflictDialog } from './SaveConflictDialog.js';

type Values = Record<string, PromptValue>;
type Props = {
  chatId: string;
  active: boolean;
  disabled: boolean;
  workspaceRevision?: number;
  promptRevision?: string;
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void;
};
type Operation = {
  path: string;
  body: Record<string, unknown>;
  kind: 'fixed' | 'oneoff' | 'cancel';
};
const sameValues = (left: Values, right: Values) => {
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && left[key] === right[key])
  );
};
export function ChatOptionSettings(props: Props) {
  useI18n();
  const [base, setBase] = useState<ChatOptionState | null>(null);
  const [latest, setLatest] = useState<ChatOptionState | null>(null);
  const [draft, setDraft] = useState<OptionDraft>({});
  const [scope, setScope] = useState<OptionScope>('fixed');
  const { fixed, oneoff } = base ? optionDraftValues(base, draft) : { fixed: {}, oneoff: {} };
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [readError, setReadError] = useState('');
  const [message, setMessage] = useState('');
  const [completion, setCompletion] = useState('');
  const [conflict, setConflict] = useState(false);
  const [saveConflict, setSaveConflict] = useState(false);
  const [uncertain, setUncertain] = useState<Operation | null>(null);
  const lock = useRef(false),
    requestVersion = useRef(0),
    loadedPromptRevision = useRef(props.promptRevision);
  const fixedDirty = !!base && !sameValues(fixed, base.fixedValues);
  const scopedDirty = scope === 'fixed' ? fixedDirty : Object.keys(oneoff).length > 0;
  // An explicit one-off can equal the saved fixed value and still need preservation in fixed scope.
  const dirty = Object.keys(draft).length > 0 || !!uncertain;
  const current = useRef({ base, draft, dirty });
  current.current = { base, draft, dirty };
  const path = `/chats/${encodeURIComponent(props.chatId)}/options`;
  const refresh = useCallback(async () => {
    if (lock.current) return;
    const version = ++requestVersion.current;
    setLoading(true);
    try {
      const state = await api<ChatOptionState>(path);
      if (version !== requestVersion.current) return;
      const draft = current.current;
      setLatest(state);
      setReadError('');
      if (!draft.base || !draft.dirty) {
        setBase(state);
        setDraft({});
        setConflict(false);
      } else if (
        state.revision !== draft.base.revision ||
        state.workspaceRevision !== draft.base.workspaceRevision ||
        state.binding.owner !== draft.base.binding.owner ||
        state.binding.definitionHash !== draft.base.binding.definitionHash
      ) {
        setConflict(true);
      }
    } catch (caught) {
      if (version === requestVersion.current) setReadError((caught as Error).message);
    } finally {
      if (version === requestVersion.current) setLoading(false);
    }
  }, [path]);
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
      ((props.workspaceRevision !== undefined &&
        props.workspaceRevision !== current.current.base?.workspaceRevision) ||
        props.promptRevision !== loadedPromptRevision.current)
    ) {
      loadedPromptRevision.current = props.promptRevision;
      void refresh();
    }
  }, [props.active, props.disabled, props.workspaceRevision, props.promptRevision, refresh]);
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
    setCompletion('');
    try {
      const accepted = await api<ChatOptionState>(operation.path, operation.body);
      setBase(accepted);
      setLatest(accepted);
      if (operation.kind !== 'cancel') setDraft({});
      setConflict(false);
      setUncertain(null);
      setMessage('');
      setCompletion(
        {
          fixed: uiMessage('chatsettings.m106'),
          oneoff: uiMessage('chatsettings.m107'),
          cancel: uiMessage('chatsettings.m108'),
        }[operation.kind]
      );
      dispatchEvent(new Event('chat-options-changed'));
    } catch (caught) {
      const known = caught instanceof ApiError && caught.status < 500;
      setUncertain(known ? null : operation);
      if (caught instanceof ApiError && caught.status === 409) {
        setConflict(true);
        setSaveConflict(true);
      }
      setError(
        known
          ? uiMessage('chatsettings.draftError', { error: messageRef((caught as Error).message) })
          : uiMessage('chatsettings.m109')
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  function submit(kind: Operation['kind'], suffix: string, input: Record<string, unknown> = {}) {
    if (!base || uncertain || loading) return;
    if (conflict) {
      setSaveConflict(true);
      return;
    }
    void execute({
      kind,
      path: `${path}/${suffix}`,
      body: {
        expectedRevision: base.revision,
        operationId: crypto.randomUUID(),
        ...input,
      },
    });
  }
  if (!base)
    return (
      <div className="chat-options-body">
        <LoadingState
          presentation="placeholder"
          loading={loading}
          error={translateMessage(readError)}
          label={t('chatsettings.m110')}
          onRetry={() => void refresh()}
          retryLabel={t('chatsettings.m111')}
        />
      </div>
    );
  const disabled = busy || props.disabled || !!uncertain;
  const blocked = disabled || loading;
  const displayState = latest ?? base;
  const fieldLabel = (id: string) =>
    (base.controls ?? promptControls(base.program)).find((control) => control.id === id)?.label ??
    id;

  return (
    <>
      <SaveConflictDialog
        open={saveConflict}
        title={t('chatsettings.m112')}
        onClose={() => setSaveConflict(false)}
        readSaved={async () => {
          const input = current.current;
          const value = await api<ChatOptionState>(path);
          const controls = value.controls ?? promptControls(value.program);
          const review = reviewOptionDraft(input.base!, input.draft, value);
          const adopt = (keepInput: boolean) => {
            requestVersion.current++;
            setLoading(false);
            setBase(value);
            setLatest(value);
            setDraft(keepInput ? review.draft : {});
            setConflict(false);
            setError('');
            setReadError('');
            setSaveConflict(false);
            setMessage(keepInput ? uiMessage('chatsettings.m113') : '');
            setCompletion(keepInput ? '' : uiMessage('chatsettings.m114'));
          };
          return () => {
            const displayReview = reviewOptionDraft(input.base!, input.draft, value);
            return {
              content: (
                <>
                  {controls.map((control) => (
                    <div className="settings-row" key={control.id}>
                      <span className="settings-row-copy">{control.label}</span>
                      <span className="settings-row-control">
                        {optionText(
                          control,
                          value.fixedValues[control.id] ?? value.globalValues[control.id]
                        )}
                      </span>
                    </div>
                  ))}
                  {displayReview.discarded.length > 0 && (
                    <section aria-label={t('chatsettings.m115')}>
                      <h3>{t('chatsettings.m115')}</h3>
                      <p>{t('chatsettings.m116')}</p>
                      {displayReview.discarded.map((item) => {
                        const control = (
                          input.base!.controls ?? promptControls(input.base!.program)
                        ).find((entry) => entry.id === item.id);
                        return (
                          <div className="settings-row" key={item.scope + ':' + item.id}>
                            <span className="settings-row-copy">
                              {item.label}
                              <small>{translateMessage(item.reason)}</small>
                            </span>
                            <span className="settings-row-control">
                              {item.unset
                                ? t('chatsettings.m119')
                                : control
                                  ? optionText(control, item.value)
                                  : String(item.value ?? '') || t('chatsettings.m120')}
                            </span>
                          </div>
                        );
                      })}
                    </section>
                  )}
                  <p className="muted">{t('chatsettings.m121')}</p>
                </>
              ),
              actions: (
                <>
                  <button type="button" className="secondary" onClick={() => adopt(false)}>
                    {t('chatsettings.m122')}
                  </button>
                  <button type="button" className="primary" onClick={() => adopt(true)}>
                    {t('chatsettings.m123')}
                  </button>
                </>
              ),
            };
          };
        }}
      />
      <div className="chat-options-body chat-specific-options">
        <fieldset className="chat-options-fields" disabled={disabled}>
          <ToggleRow
            label={t('chatsettings.m127')}
            description={t(
              scope === 'oneoff' ? 'chatsettings.oneoffScopeHelp' : 'chatsettings.fixedScopeHelp'
            )}
            checked={scope === 'oneoff'}
            onChange={(checked) => setScope(checked ? 'oneoff' : 'fixed')}
          />
          <section aria-label={t('chatsettings.optionValues')}>
            <SelectiveValues
              program={base.program}
              definitions={base.controls}
              inherited={
                scope === 'oneoff'
                  ? { ...base.globalValues, ...base.fixedValues }
                  : base.globalValues
              }
              values={scope === 'oneoff' ? oneoff : fixed}
              fixedValues={base.fixedValues}
              onChange={(values) =>
                setDraft((previous) => editOptionDraft(base, previous, scope, values))
              }
              mode={scope}
            />
          </section>
          {scope === 'fixed' &&
            (Object.keys(base.fixedValues).length > 0 || displayState.conflicts.length > 0) && (
              <button
                type="button"
                className="secondary chat-options-reset"
                disabled={blocked}
                onClick={() => submit('fixed', 'fixed', { binding: base.binding, values: {} })}
              >
                {t('chatsettings.m126')}
              </button>
            )}
        </fieldset>
        {displayState.pending.length > 0 && (
          <section aria-label={t('chatsettings.m130')} className="chat-options-pending">
            <h3>{t('chatsettings.m130')}</h3>
            {displayState.pending.map((item) => (
              <div key={item.id} className="chat-option-record">
                <strong>{t('chatsettings.m118')}</strong>
                <OptionValues
                  values={item.values}
                  fieldLabel={fieldLabel}
                  controls={displayState.controls ?? promptControls(displayState.program)}
                />
                <button
                  type="button"
                  disabled={blocked}
                  onClick={() => submit('cancel', `pending/${encodeURIComponent(item.id)}/cancel`)}
                >
                  {t('chatsettings.m131')}
                </button>
              </div>
            ))}
          </section>
        )}
        {displayState.conflicts.map((item) => (
          <NoticeBanner tone="error" key={item}>
            {translateMessage(item)}
          </NoticeBanner>
        ))}
        {conflict && <NoticeBanner tone="error">{t('chatsettings.m132')}</NoticeBanner>}
        {readError && (
          <NoticeBanner tone="error">
            {translateMessage(readError)}
            <button
              type="button"
              disabled={busy || loading || !!uncertain}
              onClick={() => void refresh()}
            >
              {loading ? t('chatsettings.m133') : t('chatsettings.m134')}
            </button>
          </NoticeBanner>
        )}
        {error && <NoticeBanner tone="error">{translateMessage(error)}</NoticeBanner>}
        {message && <NoticeBanner>{translateMessage(message)}</NoticeBanner>}
        <TransientNotice message={completion} />
        {uncertain && (
          <button
            type="button"
            disabled={busy || props.disabled}
            onClick={() => void execute(uncertain)}
          >
            {t('chatsettings.m135')}
          </button>
        )}
      </div>
      <footer className="chat-options-footer">
        {dirty && <small>{t('chatsettings.m136')}</small>}
        <div>
          <SaveButton
            type="button"
            className="primary"
            label={t(scope === 'oneoff' ? 'chatsettings.m129' : 'chatsettings.m139')}
            text={t(scope === 'oneoff' ? 'chatsettings.reserve' : 'shared.save')}
            aria-busy={busy}
            disabled={!scopedDirty || blocked}
            onClick={() =>
              submit(scope, scope, {
                binding: base.binding,
                values: scope === 'oneoff' ? oneoff : fixed,
              })
            }
          />
        </div>
      </footer>
    </>
  );
}

/* Reading an inherited value must not look like a broken form, so a row that follows
   the wider setting shows the value as text and offers one explicit switch. */
function getScopeWords() {
  return {
    fixed: {
      set: t('chatsettings.m140'),
      unset: t('chatsettings.m141'),
      scoped: t('chatsettings.m143'),
    },
    oneoff: {
      set: t('chatsettings.m144'),
      unset: t('chatsettings.m145'),
      scoped: t('chatsettings.m147'),
    },
  } as const;
}

function optionText(control: PromptControl, value: PromptValue | undefined) {
  const effective = value ?? control.default ?? (control.type === 'text' ? '' : '0');
  if (typeof effective === 'boolean')
    return effective ? t('chatsettings.m148') : t('chatsettings.m149');
  const choice = control.options?.find((option) => option.value === effective);
  if (choice) return choice.label;
  return effective === '' ? t('chatsettings.m120') : String(effective);
}

function SelectiveValues({
  program,
  definitions = promptControls(program),
  inherited,
  values,
  fixedValues,
  onChange,
  mode,
}: {
  program: RisuPrompt;
  definitions?: PromptControl[];
  inherited: Values;
  values: Values;
  fixedValues: Values;
  onChange: (values: Values) => void;
  mode: 'fixed' | 'oneoff';
}) {
  useI18n();
  const effective = { ...inherited, ...values };
  let reconciledValues: Values;
  try {
    reconciledValues = reconcilePromptValues(definitions, effective).values;
  } catch {
    return <NoticeBanner tone="error">{t('chatsettings.m150')}</NoticeBanner>;
  }
  if (definitions.length === 0) return <p className="muted">{t('chatsettings.m151')}</p>;
  const words = getScopeWords()[mode];
  /* Same grouping rule as the prompt editor, so one option means the same thing in
     both places. Long option sets stay navigable instead of becoming one long list. */
  const groups = new Map<string, PromptControl[]>();
  for (const control of definitions) {
    // This Korean fallback is an existing persisted expansion identity, not displayed copy.
    const group = control.group?.trim() || '기본 설정';
    groups.set(group, [...(groups.get(group) ?? []), control]);
  }
  const row = (control: PromptControl) => {
    const selected = Object.hasOwn(values, control.id);
    const current = reconciledValues[control.id]!;
    /* A switch already says what it will do, so flipping it is the act of setting a
       value for this chat. Every other control keeps its value readable as text until
       the row is explicitly switched into editing. */
    const live = control.type === 'boolean' || selected;
    return (
      <div key={control.id} className="chat-option-choice" data-scoped={String(selected)}>
        {live ? (
          <div className="chat-option-value">
            <PromptControlFields
              program={program}
              definitions={definitions}
              controlIds={[control.id]}
              compact
              values={{ [control.id]: current }}
              onChange={(id, value) => onChange({ ...values, [id]: value })}
            />
          </div>
        ) : (
          <div className="chat-option-inherited">
            <span className="chat-option-name">{control.label}</span>
            <span className="chat-option-current">{optionText(control, current)}</span>
          </div>
        )}
        <div className="chat-option-scope" data-actionable={String(selected || !live)}>
          <span className="chat-option-origin">
            {selected
              ? words.scoped
              : mode === 'oneoff' && Object.hasOwn(fixedValues, control.id)
                ? t('chatsettings.m117')
                : t('chatsettings.m142')}
          </span>
          {(selected || !live) && (
            <button
              type="button"
              className="secondary"
              aria-label={t('chatsettings.scopeAction', {
                name: control.label,
                action: selected ? words.unset : words.set,
              })}
              onClick={() => {
                if (selected) {
                  const next = { ...values };
                  delete next[control.id];
                  onChange(next);
                } else onChange({ ...values, [control.id]: current });
              }}
            >
              {selected ? words.unset : words.set}
            </button>
          )}
        </div>
      </div>
    );
  };
  return (
    <div className="chat-selective-values">
      {[...groups].map(([group, items]) => {
        const scoped = items.filter((control) => Object.hasOwn(values, control.id)).length;
        return (
          <PromptOptionGroup
            key={group}
            identity={`chat:fixed:${group}`}
            className="chat-option-group"
            summary={
              <>
                <span className="chat-option-group-name">
                  {items[0]?.group?.trim() || t('chatsettings.m152')}
                </span>
                <span className="chat-option-group-count">
                  {scoped > 0
                    ? t('chatsettings.scopeCount', { count: scoped, total: items.length })
                    : t('chatsettings.optionCount', { count: items.length })}
                </span>
              </>
            }
          >
            <div className="chat-option-group-body">{items.map(row)}</div>
          </PromptOptionGroup>
        );
      })}
    </div>
  );
}

function OptionValues({
  values,
  fieldLabel,
  controls,
}: {
  values: Values;
  fieldLabel: (id: string) => string;
  controls: PromptControl[];
}) {
  useI18n();
  return (
    <dl className="chat-option-values">
      {Object.entries(values).map(([id, value]) => {
        const control = controls.find((item) => item.id === id);
        return (
          <div key={id}>
            <dt>{fieldLabel(id)}</dt>
            <dd>
              {control ? optionText(control, value) : String(value ?? '') || t('chatsettings.m120')}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
