import { useI18n, translateMessage } from './i18n.js';
import type { ResourceModel } from '../core/resource-editing.js';
import { useEffect, useRef, useState, type ReactNode, type ChangeEvent } from 'react';
import type { PromptValue, RisuPrompt } from '../core/risu-prompt.js';
import { ActionMenu } from './ActionMenu.js';
import { Dialog } from './Dialog.js';
import { IconButton } from './IconButton.js';
import { PromptControlFields } from './PromptControlFields.js';
import {
  useBufferedEditorState,
  useUnappliedEditorField,
  useEditorSavePreparation,
} from './resource-editor.js';
import {
  addToggleGroup,
  renameToggleGroup,
  moveToggleGroup,
  ungroupToggleGroup,
  deleteToggleGroup,
  addToggleItem,
  duplicateToggleItem,
  moveToggleItem,
  deleteToggleItem,
  editToggleItem,
  moveToggleItemToGroup,
  parseToggleDocument,
  parseDefaultVariableLines,
  addDefaultVariable,
  editDefaultVariable,
  deleteDefaultVariable,
} from './native-toggle-document.js';
import type { NativeToggleDefinition, NativeToggleType } from './native-risu-toggle-editor.js';
import {
  AddIcon,
  CodeIcon,
  CopyIcon,
  DeleteIcon,
  DisplayIcon,
  DownIcon,
  DropdownIcon,
  EditIcon,
  FolderIcon,
  OptionsIcon,
  SearchIcon,
  UndoIcon,
  UpIcon,
  ForwardIcon,
} from './ui-icons.js';
import './native-risu-toggle-editor.css';

const controlTypes: NativeToggleType[] = ['toggle', 'select', 'text', 'textarea'];
type Snapshot = { toggles: string; variables: string };
type Confirmation = {
  title: () => string;
  description: () => string;
  destructive?: boolean;
  action: () => void;
};

export function NativeRisuToggleEditor({
  value,
  variables,
  program,
  onChange,
  draftPath = 'prompt.native.toggles',
  onPendingChange,
  prepareSave,
  disabled = false,
}: {
  value: string;
  variables: string;
  program: RisuPrompt;
  onChange: (document: Snapshot) => void;
  draftPath?: string;
  onPendingChange?: (pending: boolean) => void;
  disabled?: boolean;
  prepareSave?: (model: ResourceModel, values: Snapshot) => ResourceModel;
}) {
  const { t } = useI18n();
  const warningMessage = (warning: string) => {
    const nested = /^(\d+)행: Risu 그룹은 중첩할 수 없어요\.$/.exec(warning);
    if (nested) return t('native.nestedGroup', { line: Number(nested[1]) });
    const unmatched = /^(\d+)행: 대응하는 그룹 시작이 없어요\.$/.exec(warning);
    if (unmatched) return t('native.unmatchedGroup', { line: Number(unmatched[1]) });
    return translateMessage(warning);
  };
  const names: Record<NativeToggleType, string> = {
    toggle: t('native.text_7019383fa3'),
    select: t('native.text_a73b2abf4a'),
    text: t('native.text_c2d407e7e3'),
    textarea: t('native.text_10b4e6b251'),
    divider: t('native.text_21aca00635'),
    caption: t('native.text_d9547c9605'),
    group: t('native.text_3228056915'),
    groupEnd: t('native.text_28a0453c5b'),
  };
  const [raw, setRaw] = useBufferedEditorState(draftPath, value, { syncPristineInitial: true });
  const [rawVariables, setRawVariables] = useBufferedEditorState(
    'prompt.native.defaults',
    variables,
    { syncPristineInitial: true }
  );
  const [invalid, setInvalid] = useBufferedEditorState<Record<string, string>>(
    `${draftPath}.invalid`,
    {}
  );
  const [section, setSection] = useState<'toggles' | 'variables'>('toggles');
  const [mode, setMode] = useState<'edit' | 'preview' | 'raw'>('edit');
  const [groupId, setGroupId] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [groupDialog, setGroupDialog] = useState<'add' | 'rename' | null>(null);
  const [groupName, setGroupName] = useState('');
  const [preview, setPreview] = useState<Record<string, PromptValue>>({});
  const [history, setHistory] = useState<Snapshot[]>([]);
  const [future, setFuture] = useState<Snapshot[]>([]);
  const transaction = useRef('');
  const owned = useRef<Snapshot>({ toggles: value, variables });
  const invalidPending = Object.keys(invalid).length > 0;
  const sourcePending = raw !== value || rawVariables !== variables;
  const pending = sourcePending || invalidPending;
  useUnappliedEditorField(draftPath, pending);
  useEditorSavePreparation(draftPath, (model) => {
    if (invalidPending) throw new Error('잘못 입력된 토글 또는 변수 값을 확인해 주세요.');
    if (!sourcePending) return model;
    if (!prepareSave) throw new Error('변수와 토글 원문을 폼에 반영해 주세요.');
    return prepareSave(model, { toggles: raw, variables: rawVariables });
  });
  useEffect(() => {
    onPendingChange?.(pending);
  }, [pending, onPendingChange]);
  useEffect(() => () => onPendingChange?.(false), [onPendingChange]);
  useEffect(() => {
    if (owned.current.toggles !== value || owned.current.variables !== variables) {
      setHistory([]);
      setFuture([]);
      setExpanded(null);
      transaction.current = '';
      owned.current = { toggles: value, variables };
    }
  }, [value, variables]);
  const doc = parseToggleDocument(value);
  const groups = [
    ...doc.groups.filter((group) => group.id !== -1),
    ...doc.groups.filter((group) => group.id === -1),
  ];
  const current = groups.find((group) => group.id === groupId) ?? groups[0]!;
  const matchesSearch = (item: (typeof current.items)[number]) =>
    !!item.raw.trim() &&
    (!query.trim() ||
      [
        item.definition?.label,
        item.definition?.key,
        item.definition?.options,
        item.caption,
        item.raw,
      ]
        .join(' ')
        .toLocaleLowerCase()
        .includes(query.trim().toLocaleLowerCase()));
  const firstInvalid = Object.keys(invalid)[0];
  useEffect(() => {
    if (!firstInvalid) return;
    setMode('edit');
    if (firstInvalid.startsWith('variable.')) setSection('variables');
    else {
      const index = Number(firstInvalid.split('.')[0]);
      setSection('toggles');
      setExpanded(index);
      setGroupId(
        parseToggleDocument(value).groups.find((group) =>
          group.items.some((item) => item.index === index)
        )?.id ?? null
      );
    }
  }, [firstInvalid, value]);
  const locked = disabled || pending;
  const snapshot = (): Snapshot => ({ toggles: value, variables });
  function publish(next: Snapshot, target?: 'toggles' | 'variables') {
    owned.current = next;
    onChange(next);
    // Applying one source document must leave the other document's pending input intact.
    if (!target || target === 'toggles' || raw === value) setRaw(next.toggles);
    if (!target || target === 'variables' || rawVariables === variables)
      setRawVariables(next.variables);
  }
  function write(action: () => string, target: 'toggles' | 'variables' = 'toggles', key = '') {
    try {
      const next = { ...snapshot(), [target]: action() };
      if (next.toggles !== value || next.variables !== variables) {
        if (!key || key !== transaction.current)
          setHistory((old) => [...old.slice(-59), snapshot()]);
        setFuture([]);
        transaction.current = key;
        publish(next, target);
      }
      setError('');
      return true;
    } catch (caught) {
      setError((caught as Error).message);
      return false;
    }
  }
  function structural(action: () => string, destinationId = current.id) {
    const destination = groups.find((group) => group.id === destinationId) ?? current;
    const ordinal = groups
      .filter((group) => group.name === destination.name)
      .findIndex((group) => group.id === destination.id);
    let next = value;
    if (
      write(() => {
        next = action();
        return next;
      })
    ) {
      setExpanded(null);
      setQuery('');
      setGroupId(
        destinationId === -1
          ? -1
          : (parseToggleDocument(next).groups.filter((group) => group.name === destination.name)[
              ordinal
            ]?.id ?? null)
      );
    }
  }
  function restore(redo: boolean) {
    const stack = redo ? future : history;
    const next = stack.at(-1);
    if (!next) return;
    if (redo) {
      setFuture(stack.slice(0, -1));
      setHistory((old) => [...old, snapshot()]);
    } else {
      setHistory(stack.slice(0, -1));
      setFuture((old) => [...old, snapshot()]);
    }
    transaction.current = '';
    publish(next);
    setExpanded(null);
    setError('');
  }
  function field(
    id: string,
    label: string,
    text: string,
    apply: (next: string) => string,
    target: 'toggles' | 'variables' = 'toggles',
    multiline = false
  ) {
    const props = {
      'aria-label': label,
      'aria-invalid': Object.hasOwn(invalid, id),
      value: invalid[id] ?? text,
      disabled: disabled || sourcePending || (invalidPending && !Object.hasOwn(invalid, id)),
      onBlur: () => {
        transaction.current = '';
      },
      onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        const next = event.target.value;
        const ok = write(() => apply(next), target, id);
        setInvalid((old) => {
          const copy = { ...old };
          if (ok) delete copy[id];
          else copy[id] = next;
          return copy;
        });
      },
    };
    return multiline ? <textarea {...props} rows={3} /> : <input {...props} />;
  }
  const count = (group: (typeof groups)[number]) =>
    group.items.filter((item) => item.definition && controlTypes.includes(item.definition.type))
      .length;
  const unknown = doc.lines.filter((line) => !line.definition && line.raw.trim()).length;
  function selectGroup(id: number) {
    setGroupId(id);
    setExpanded(null);
    setQuery('');
  }
  function openGroupDialog() {
    setGroupName('');
    setGroupDialog('add');
  }
  function itemForm(item: (typeof current.items)[number], parentId: number) {
    const definition = item.definition;
    if (!definition)
      return (
        <div className="nt-form">
          <pre>{item.raw}</pre>
          <button type="button" onClick={() => setMode('raw')}>
            {t('native.text_0286f638be')}
          </button>
        </div>
      );
    const control = controlTypes.includes(definition.type);
    const edit = (patch: Partial<NativeToggleDefinition>) =>
      editToggleItem(value, item.index, patch);
    const options = definition.options.split(',');
    const setOptions = (next: string[]) => edit({ options: next.join(',') });
    return (
      <div className="nt-form">
        <div className="nt-fields">
          <label>
            {control ? t('native.text_7be99394f7') : t('native.text_2ecaf7f57c')}
            {field(`${item.index}.label`, t('native.text_7be99394f7'), definition.label, (label) =>
              edit({ label })
            )}
          </label>
          {control && (
            <label>
              {t('native.text_abf2a98954')}
              {field(`${item.index}.key`, t('native.text_abf2a98954'), definition.key, (key) =>
                edit({ key })
              )}
            </label>
          )}
        </div>
        {control && (
          <>
            <label className="nt-type-field">
              {t('native.text_b410f81d43')}
              <select
                aria-label={t('native.text_b410f81d43')}
                value={definition.type}
                disabled={locked}
                onChange={(event) =>
                  write(() => edit({ type: event.target.value as NativeToggleType }))
                }
              >
                {controlTypes.map((type) => (
                  <option key={type} value={type}>
                    {names[type]}
                  </option>
                ))}
              </select>
            </label>
            {definition.type === 'select' && (
              <div className="nt-options">
                <div className="nt-options-heading">
                  <span>{t('native.storedValueAndOption')}</span>
                </div>
                {options.map((option, index) => (
                  <div className="nt-option" key={index}>
                    <span>{index}</span>
                    {field(
                      `${item.index}.option.${index}`,
                      t('native.optionNumber', { number: index }),
                      option,
                      (next) => {
                        if (next.includes(','))
                          throw new Error('선택지 하나에는 쉼표를 넣을 수 없어요.');
                        return setOptions(options.map((entry, i) => (i === index ? next : entry)));
                      }
                    )}
                    <div className="nt-option-actions">
                      {([-1, 1] as const).map((delta) => (
                        <IconButton
                          key={delta}
                          label={t(delta < 0 ? 'native.optionUp' : 'native.optionDown', {
                            number: index,
                          })}
                          icon={delta < 0 ? UpIcon : DownIcon}
                          disabled={locked || index + delta < 0 || index + delta >= options.length}
                          onClick={() =>
                            setConfirmation({
                              title: () => t('native.text_ef58acc694'),
                              description: () => t('native.text_58d33aab03'),
                              action: () => {
                                write(() => {
                                  const next = [...options];
                                  [next[index], next[index + delta]] = [
                                    next[index + delta]!,
                                    next[index]!,
                                  ];
                                  return setOptions(next);
                                });
                              },
                            })
                          }
                        />
                      ))}
                      <IconButton
                        label={t('native.optionDelete', { number: index })}
                        icon={DeleteIcon}
                        disabled={locked || options.length === 1}
                        onClick={() =>
                          setConfirmation({
                            title: () => t('native.text_369d0b0943'),
                            description: () => t('native.text_d8d8fcbc87'),
                            action: () => {
                              write(() => setOptions(options.filter((_, i) => i !== index)));
                            },
                          })
                        }
                      />
                    </div>
                  </div>
                ))}
                <button
                  type="button"
                  className="ghost nt-inline-add"
                  disabled={locked}
                  onClick={() => write(() => setOptions([...options, '새 선택지']))}
                >
                  <AddIcon size={15} aria-hidden="true" />
                  {t('native.text_bd90c69a8b')}
                </button>
              </div>
            )}
            <label>
              {t('native.text_841964364c')}
              {field(
                `${item.index}.caption`,
                t('native.text_841964364c'),
                item.caption,
                (caption) => editToggleItem(value, item.index, {}, caption),
                'toggles',
                true
              )}
            </label>
          </>
        )}
        <div className="nt-form-bottom">
          <label>
            {t('native.text_8b1b6b1490')}
            <select
              aria-label={t('native.text_8b1b6b1490')}
              value={parentId}
              disabled={locked}
              onChange={(event) =>
                structural(
                  () => moveToggleItemToGroup(value, item.index, Number(event.target.value)),
                  Number(event.target.value)
                )
              }
            >
              {groups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.id === -1 ? t('native.ungrouped') : group.name}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="ghost"
            disabled={invalidPending}
            onClick={() => setExpanded(null)}
          >
            {t('native.text_0d2c2495e1')}
          </button>
        </div>
        <details className="nt-link-info">
          <summary>{t('native.text_d65947b4a0')}</summary>
          <pre>{item.raw}</pre>
          {control && <code>{`{{getglobalvar::toggle_${definition.key}}}`}</code>}
        </details>
      </div>
    );
  }
  function itemRow(item: (typeof current.items)[number], parentId: number) {
    const definition = item.definition;
    const title = definition?.label || definition?.key || t('native.text_7c6aebe728');
    const type = definition?.type;
    const open = expanded === item.index;
    const Icon =
      type === 'select'
        ? DropdownIcon
        : type === 'toggle'
          ? OptionsIcon
          : type === 'text' || type === 'textarea'
            ? EditIcon
            : CodeIcon;
    return (
      <article
        key={item.index}
        className={`nt-item ${open ? 'is-open' : ''} ${type === 'divider' ? 'is-divider' : ''}`}
      >
        <div className="nt-row">
          <button
            type="button"
            className="nt-row-main"
            aria-label={t('native.editItem', { title })}
            aria-expanded={open}
            disabled={invalidPending}
            onClick={() => setExpanded(open ? null : item.index)}
          >
            {type !== 'divider' && (
              <span className="nt-type-icon">
                <Icon size={16} aria-hidden="true" />
              </span>
            )}
            <span className="nt-item-copy">
              <strong>{title}</strong>
              {type !== 'divider' && (
                <small>
                  {open
                    ? definition?.key
                    : item.caption ||
                      definition?.options.split(',').join(', ') ||
                      definition?.key ||
                      item.raw}
                </small>
              )}
            </span>
            {type !== 'divider' && (
              <span className="nt-kind">{type ? names[type] : t('native.text_8ba13a8495')}</span>
            )}
            <DropdownIcon size={16} className="nt-chevron" aria-hidden="true" />
          </button>
          <ActionMenu label={t('native.itemMenu', { title })} viewport>
            <div className="action-menu-group">
              <button
                type="button"
                disabled={locked}
                onClick={() => structural(() => duplicateToggleItem(value, item.index))}
              >
                <CopyIcon />
                {t('native.text_ec3a6b612c')}
              </button>
            </div>
            <div className="action-menu-group">
              <button
                type="button"
                disabled={locked}
                onClick={() => structural(() => moveToggleItem(value, item.index, -1))}
              >
                <UpIcon />
                {t('native.text_0de1511afe')}
              </button>
              <button
                type="button"
                disabled={locked}
                onClick={() => structural(() => moveToggleItem(value, item.index, 1))}
              >
                <DownIcon />
                {t('native.text_763e79eea6')}
              </button>
            </div>
            <div className="action-menu-group">
              <button
                className="danger"
                type="button"
                disabled={locked}
                onClick={() =>
                  setConfirmation({
                    title: () => t('native.text_28e82332d9'),
                    description: () => t('native.deleteItemDescription', { title }),
                    action: () => structural(() => deleteToggleItem(value, item.index)),
                  })
                }
              >
                <DeleteIcon />
                {t('native.text_28e82332d9')}
              </button>
            </div>
          </ActionMenu>
        </div>
        {open && itemForm(item, parentId)}
      </article>
    );
  }
  let content: ReactNode;
  if (mode === 'raw')
    content = (
      <div className="nt-raw">
        <label>
          {section === 'toggles' ? t('native.text_85cd7d3b63') : t('native.text_fcaba2262e')}
          <textarea
            aria-label={
              section === 'toggles' ? t('native.text_85cd7d3b63') : t('native.text_a0b6c93511')
            }
            rows={20}
            spellCheck={false}
            disabled={disabled || invalidPending}
            value={section === 'toggles' ? raw : rawVariables}
            onChange={(event) =>
              section === 'toggles'
                ? setRaw(event.target.value)
                : setRawVariables(event.target.value)
            }
          />
        </label>
        <div className="nt-raw-actions">
          {sourcePending && <small>{t('native.text_bd9c1a150a')}</small>}
          <button
            type="button"
            disabled={
              disabled ||
              invalidPending ||
              (section === 'toggles' ? raw === value : rawVariables === variables)
            }
            onClick={() => write(() => (section === 'toggles' ? raw : rawVariables), section)}
          >
            {t('native.text_ba1543a09d')}
          </button>
        </div>
      </div>
    );
  else if (section === 'variables')
    content = (
      <div className="nt-variables">
        <div className="nt-heading">
          <div>
            <h3>{t('native.newChatDefaultVariables')}</h3>
          </div>
          <button
            type="button"
            disabled={locked}
            onClick={() => write(() => addDefaultVariable(variables), 'variables')}
          >
            <AddIcon size={16} aria-hidden="true" />
            {t('native.text_109713c45b')}
          </button>
        </div>
        <div className="nt-variable-heading">
          <span>{t('native.text_abf2a98954')}</span>
          <span>{t('native.text_254142030a')}</span>
          <span />
        </div>
        {parseDefaultVariableLines(variables)
          .filter((line) => line.raw.trim())
          .map((line, index) =>
            line.key !== null ? (
              <div className="nt-variable-row" key={line.index}>
                {field(
                  `variable.${line.index}.key`,
                  t('native.variableKey', { number: index + 1 }),
                  line.key,
                  (key) => editDefaultVariable(variables, line.index, { key }),
                  'variables'
                )}
                {field(
                  `variable.${line.index}.value`,
                  t('native.variableDefault', { key: line.key }),
                  line.value ?? '',
                  (next) => editDefaultVariable(variables, line.index, { value: next }),
                  'variables'
                )}
                <IconButton
                  label={t('native.variableDelete', { key: line.key })}
                  icon={DeleteIcon}
                  disabled={locked}
                  onClick={() =>
                    write(() => deleteDefaultVariable(variables, line.index), 'variables')
                  }
                />
              </div>
            ) : (
              <div className="nt-opaque-variable" key={line.index}>
                <code>{line.raw}</code>
                <small>{t('native.text_c8c2007be6')}</small>
              </div>
            )
          )}
        {!variables && <p className="muted">{t('native.text_f97e342c2b')}</p>}
      </div>
    );
  else
    content = (
      <>
        <div className="nt-mobile-groups">
          <label>
            {t('native.text_3228056915')}
            <select
              aria-label={t('native.text_0bf2a9eced')}
              value={current.id}
              disabled={invalidPending}
              onChange={(event) => selectGroup(Number(event.target.value))}
            >
              {groups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.id === -1 ? t('native.ungrouped') : group.name}
                </option>
              ))}
            </select>
          </label>
          {mode === 'edit' && (
            <IconButton
              label={t('native.text_bc71356fa2')}
              icon={AddIcon}
              disabled={locked}
              onClick={openGroupDialog}
            />
          )}
        </div>
        <div className="nt-body">
          <nav className="nt-groups" aria-label={t('native.text_7c0ed41220')}>
            <div className="nt-nav-heading">
              <span>{t('native.text_3228056915')}</span>
              <span>{groups.length - 1}</span>
            </div>
            {groups.map((group) => (
              <button
                type="button"
                key={group.id}
                aria-current={group.id === current.id && !query ? 'true' : undefined}
                disabled={invalidPending}
                onClick={() => selectGroup(group.id)}
              >
                <FolderIcon size={16} aria-hidden="true" />
                <span>{group.id === -1 ? t('native.ungrouped') : group.name}</span>
                <small>{count(group)}</small>
              </button>
            ))}
            {mode === 'edit' && (
              <button
                type="button"
                className="nt-add-group"
                disabled={locked}
                onClick={openGroupDialog}
              >
                <AddIcon size={16} aria-hidden="true" />
                {t('native.text_bc71356fa2')}
              </button>
            )}
          </nav>
          <div className="nt-main">
            <div className="nt-heading">
              <div>
                <h3>
                  {query && mode === 'edit'
                    ? t('native.text_953eefe9dd')
                    : current.id === -1
                      ? t('native.ungrouped')
                      : current.name}
                </h3>
                <p>
                  {query && mode === 'edit'
                    ? t('native.searchResultCount', {
                        count: groups.reduce(
                          (total, group) => total + group.items.filter(matchesSearch).length,
                          0
                        ),
                      })
                    : t('native.groupCounts', {
                        settings: count(current),
                        dividers: current.items.filter(
                          (item) => item.definition?.type === 'divider'
                        ).length,
                      })}
                </p>
              </div>
              {!query && mode === 'edit' && (
                <div className="nt-heading-actions">
                  <ActionMenu
                    label={t('native.text_6d5ba8d015')}
                    icon={AddIcon}
                    className="nt-add-item"
                    viewport
                  >
                    {[...controlTypes, 'divider', 'caption' as const].map((type) => (
                      <button
                        type="button"
                        key={type}
                        disabled={locked}
                        onClick={() =>
                          structural(() =>
                            addToggleItem(value, current.id, type as NativeToggleType)
                          )
                        }
                      >
                        {names[type as NativeToggleType]}
                      </button>
                    ))}
                  </ActionMenu>
                  {current.id !== -1 && (
                    <ActionMenu label={t('native.text_1b6a9feaef')} viewport>
                      <div className="action-menu-group">
                        <button
                          type="button"
                          disabled={locked}
                          onClick={() => {
                            setGroupName(current.name);
                            setGroupDialog('rename');
                          }}
                        >
                          {t('native.text_73e5a894f7')}
                        </button>
                        <button
                          type="button"
                          disabled={locked}
                          onClick={() =>
                            structural(() => ungroupToggleGroup(value, current.id), -1)
                          }
                        >
                          {t('native.text_71b4663593')}
                        </button>
                      </div>
                      <div className="action-menu-group">
                        <button
                          type="button"
                          disabled={locked}
                          onClick={() => structural(() => moveToggleGroup(value, current.id, -1))}
                        >
                          {t('native.text_7e814bb8d6')}
                        </button>
                        <button
                          type="button"
                          disabled={locked}
                          onClick={() => structural(() => moveToggleGroup(value, current.id, 1))}
                        >
                          {t('native.text_cec7cb8385')}
                        </button>
                      </div>
                      <div className="action-menu-group">
                        <button
                          className="danger"
                          type="button"
                          disabled={locked}
                          onClick={() =>
                            setConfirmation({
                              title: () => t('native.text_a3900e2c94'),
                              destructive: true,
                              description: () =>
                                t('native.deleteGroupDescription', {
                                  name: current.id === -1 ? t('native.ungrouped') : current.name,
                                }),
                              action: () =>
                                structural(() => deleteToggleGroup(value, current.id), -1),
                            })
                          }
                        >
                          {t('native.text_a3900e2c94')}
                        </button>
                      </div>
                    </ActionMenu>
                  )}
                </div>
              )}
            </div>
            {mode === 'preview' ? (
              <div className="nt-preview">
                <div className="nt-preview-notice">
                  <span>{t('native.text_6120078673')}</span>
                  <button type="button" className="ghost" onClick={() => setPreview({})}>
                    {t('native.text_ff75b4ff24')}
                  </button>
                </div>
                <PromptControlFields
                  program={{
                    ...program,
                    nativeRisuPreset: {
                      ...program.nativeRisuPreset,
                      preset: {
                        ...program.nativeRisuPreset.preset,
                        customPromptTemplateToggle: current.items
                          .flatMap((item) =>
                            doc.lines.slice(item.index, item.end).map((line) => line.raw)
                          )
                          .join('\n'),
                      },
                    },
                  }}
                  values={preview}
                  onChange={(key, next) => setPreview((old) => ({ ...old, [key]: next }))}
                  compact
                />
              </div>
            ) : (
              (query.trim() ? groups : [current]).map((group) => (
                <div key={group.id}>
                  {query && <h4>{group.id === -1 ? t('native.ungrouped') : group.name}</h4>}
                  {group.items.filter(matchesSearch).map((item) => itemRow(item, group.id))}
                </div>
              ))
            )}
            {!current.items.length && !query && mode === 'edit' && (
              <p className="muted nt-empty">{t('native.text_0e9ffc660e')}</p>
            )}
          </div>
        </div>
      </>
    );
  return (
    <section className="native-toggle-editor" aria-label={t('native.text_13b410eba6')}>
      <div className="nt-toolbar">
        <div className="nt-sections" aria-label={t('native.text_c94a66e243')}>
          <button
            type="button"
            aria-pressed={section === 'toggles'}
            disabled={invalidPending}
            onClick={() => setSection('toggles')}
          >
            {t('native.text_714249bbbd')}
          </button>
          <button
            type="button"
            aria-pressed={section === 'variables'}
            disabled={invalidPending}
            onClick={() => {
              setSection('variables');
              if (mode === 'preview') setMode('edit');
            }}
          >
            {t('native.text_0510e453e9')}
          </button>
        </div>
        {mode === 'edit' && section === 'toggles' && (
          <label className="nt-search">
            <SearchIcon size={16} aria-hidden="true" />
            <input
              aria-label={t('native.text_81ca995da3')}
              placeholder={t('native.text_81ca995da3')}
              value={query}
              disabled={invalidPending}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
        )}
        <div className="nt-modes" aria-label={t('native.text_3cae8d67d0')}>
          {(['edit', 'preview', 'raw'] as const)
            .filter((item) => item !== 'preview' || section === 'toggles')
            .map((item) => {
              const Icon = item === 'edit' ? EditIcon : item === 'preview' ? DisplayIcon : CodeIcon;
              return (
                <button
                  type="button"
                  key={item}
                  aria-pressed={mode === item}
                  disabled={invalidPending || (sourcePending && item !== 'raw')}
                  onClick={() => {
                    transaction.current = '';
                    setMode(item);
                    if (item === 'preview') setQuery('');
                  }}
                >
                  <Icon size={15} aria-hidden="true" />
                  {item === 'edit'
                    ? t('native.text_d482e14b40')
                    : item === 'preview'
                      ? t('native.text_2f1c9d7bd8')
                      : t('native.text_8ba13a8495')}
                </button>
              );
            })}
        </div>
      </div>
      {(error || invalidPending) && (
        <div className="nt-error">
          <p role="alert">
            {(error ? translateMessage(error) : '') || t('native.text_c701c87db3')}
          </p>
          {invalidPending && (
            <button
              type="button"
              onClick={() => {
                setInvalid({});
                setError('');
              }}
            >
              {t('native.text_a69988177e')}
            </button>
          )}
        </div>
      )}
      {sourcePending && mode !== 'raw' && (
        <p className="nt-notice">{t('native.text_3a377aba0a')}</p>
      )}
      {content}
      <footer className="nt-footer">
        <span>
          {t('native.toggleCounts', {
            groups: groups.length - 1,
            settings: groups.reduce((total, group) => total + count(group), 0),
            unknown,
          })}
        </span>
        <div>
          <IconButton
            label={t('native.text_d91f83a968')}
            icon={UndoIcon}
            disabled={locked || !history.length}
            onClick={() => restore(false)}
          />
          <IconButton
            label={t('native.text_e027b3d047')}
            icon={ForwardIcon}
            disabled={locked || !future.length}
            onClick={() => restore(true)}
          />
        </div>
      </footer>
      {doc.warnings.map((warning) => (
        <p key={warning} className="nt-notice">
          {warningMessage(warning)}
        </p>
      ))}
      <Dialog
        open={confirmation !== null}
        title={confirmation?.title() ?? t('native.text_8e2a0c41c2')}
        variant="confirmation"
        role="alertdialog"
        onClose={() => setConfirmation(null)}
      >
        <p>{confirmation?.description()}</p>
        <div className="form-actions">
          <button type="button" onClick={() => setConfirmation(null)}>
            {t('native.text_19b2d19bc1')}
          </button>
          <button
            type="button"
            className={confirmation?.destructive ? 'delete-button' : 'primary'}
            onClick={() => {
              confirmation?.action();
              setConfirmation(null);
            }}
          >
            {confirmation?.title() ?? t('native.text_3085b34679')}
          </button>
        </div>
      </Dialog>
      <Dialog
        open={groupDialog !== null}
        title={groupDialog === 'add' ? t('native.text_bc71356fa2') : t('native.text_0ea7d6e97e')}
        onClose={() => setGroupDialog(null)}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            let next = value;
            if (
              write(() => {
                next =
                  groupDialog === 'add'
                    ? addToggleGroup(value, groupName)
                    : renameToggleGroup(value, current.id, groupName);
                return next;
              })
            ) {
              if (groupDialog === 'add') {
                setGroupId(
                  parseToggleDocument(next)
                    .groups.filter((group) => group.id !== -1)
                    .at(-1)?.id ?? -1
                );
                setExpanded(null);
                setQuery('');
              }
              setGroupDialog(null);
            }
          }}
        >
          <label>
            {t('native.text_ec5476de84')}
            <input
              aria-label={t('native.text_ec5476de84')}
              value={groupName}
              onChange={(event) => setGroupName(event.target.value)}
            />
          </label>
          <div className="form-actions">
            <button type="button" onClick={() => setGroupDialog(null)}>
              {t('native.text_19b2d19bc1')}
            </button>
            <button
              type="submit"
              className="primary"
              disabled={!groupName.trim() || /[=\r\n]/.test(groupName)}
            >
              {t('native.text_e01dd02f52')}
            </button>
          </div>
        </form>
      </Dialog>
    </section>
  );
}
