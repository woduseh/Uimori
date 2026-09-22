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

const names: Record<NativeToggleType, string> = {
  toggle: '켜기 / 끄기',
  select: '선택형',
  text: '한 줄 입력',
  textarea: '여러 줄 입력',
  divider: '구분선',
  caption: '설명문',
  group: '그룹',
  groupEnd: '그룹 끝',
};
const controlTypes: NativeToggleType[] = ['toggle', 'select', 'text', 'textarea'];
type Snapshot = { toggles: string; variables: string };
type Confirmation = { title: string; description: string; action: () => void };

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
    if (!prepareSave) throw new Error('변수·토글 원문을 폼에 반영해 주세요.');
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
            원문에서 편집
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
            {control ? '표시 이름' : '문구'}
            {field(`${item.index}.label`, '표시 이름', definition.label, (label) =>
              edit({ label })
            )}
          </label>
          {control && (
            <label>
              변수 키{field(`${item.index}.key`, '변수 키', definition.key, (key) => edit({ key }))}
            </label>
          )}
        </div>
        {control && (
          <>
            <label className="nt-type-field">
              입력 형식
              <select
                aria-label="입력 형식"
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
              <small>채팅에 표시할 컨트롤</small>
            </label>
            {definition.type === 'select' && (
              <div className="nt-options">
                <div className="nt-options-heading">
                  <span>선택지</span>
                  <small>숫자는 실제 저장값이에요</small>
                </div>
                {options.map((option, index) => (
                  <div className="nt-option" key={index}>
                    <span>{index}</span>
                    {field(`${item.index}.option.${index}`, `선택지 ${index}`, option, (next) => {
                      if (next.includes(','))
                        throw new Error('선택지 하나에는 쉼표를 넣을 수 없어요.');
                      return setOptions(options.map((entry, i) => (i === index ? next : entry)));
                    })}
                    <div className="nt-option-actions">
                      {([-1, 1] as const).map((delta) => (
                        <IconButton
                          key={delta}
                          label={`선택지 ${index} ${delta < 0 ? '위로' : '아래로'} 이동`}
                          icon={delta < 0 ? UpIcon : DownIcon}
                          disabled={locked || index + delta < 0 || index + delta >= options.length}
                          onClick={() =>
                            setConfirmation({
                              title: '선택지 순서 변경',
                              description:
                                '기존 채팅은 선택지 번호를 저장해요. 순서를 바꾸면 같은 번호가 다른 선택지를 가리킬 수 있어요.',
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
                        label={`선택지 ${index} 삭제`}
                        icon={DeleteIcon}
                        disabled={locked || options.length === 1}
                        onClick={() =>
                          setConfirmation({
                            title: '선택지 삭제',
                            description:
                              '삭제한 선택지 뒤의 저장 번호가 바뀌어요. 기존 채팅의 선택값을 확인해 주세요.',
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
                  선택지 추가
                </button>
              </div>
            )}
            <label>
              설명
              {field(
                `${item.index}.caption`,
                '설명',
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
            소속 그룹
            <select
              aria-label="소속 그룹"
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
                  {group.name}
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
            접기
          </button>
        </div>
        <details className="nt-link-info">
          <summary>연결 정보</summary>
          <pre>{item.raw}</pre>
          {control && <code>{`{{getglobalvar::toggle_${definition.key}}}`}</code>}
        </details>
      </div>
    );
  }
  function itemRow(item: (typeof current.items)[number], parentId: number) {
    const definition = item.definition;
    const title = definition?.label || definition?.key || '원문 항목';
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
            aria-label={`${title} 편집`}
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
                      definition?.options.split(',').join(' · ') ||
                      definition?.key ||
                      item.raw}
                </small>
              )}
            </span>
            {type !== 'divider' && <span className="nt-kind">{type ? names[type] : '원문'}</span>}
            <DropdownIcon size={16} className="nt-chevron" aria-hidden="true" />
          </button>
          <ActionMenu label={`${title} 메뉴`} viewport>
            <button
              type="button"
              disabled={locked}
              onClick={() => structural(() => moveToggleItem(value, item.index, -1))}
            >
              <UpIcon />
              위로 이동
            </button>
            <button
              type="button"
              disabled={locked}
              onClick={() => structural(() => moveToggleItem(value, item.index, 1))}
            >
              <DownIcon />
              아래로 이동
            </button>
            <button
              type="button"
              disabled={locked}
              onClick={() => structural(() => duplicateToggleItem(value, item.index))}
            >
              <CopyIcon />
              복제
            </button>
            <button
              type="button"
              disabled={locked}
              onClick={() =>
                setConfirmation({
                  title: '항목 삭제',
                  description: `‘${title}’ 항목과 연결된 설명문을 삭제해요.`,
                  action: () => structural(() => deleteToggleItem(value, item.index)),
                })
              }
            >
              <DeleteIcon />
              항목 삭제
            </button>
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
          {section === 'toggles' ? '토글 정의 원문' : '채팅 변수 기본값'}
          <textarea
            aria-label={section === 'toggles' ? '토글 정의 원문' : 'Risu 기본 변수'}
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
          <small>{sourcePending ? '적용하지 않은 원문이 있어요.' : '한 줄에 한 항목'}</small>
          <button
            type="button"
            disabled={
              disabled ||
              invalidPending ||
              (section === 'toggles' ? raw === value : rawVariables === variables)
            }
            onClick={() => write(() => (section === 'toggles' ? raw : rawVariables), section)}
          >
            원문 적용
          </button>
        </div>
      </div>
    );
  else if (section === 'variables')
    content = (
      <div className="nt-variables">
        <div className="nt-heading">
          <div>
            <h3>기본 변수</h3>
            <p>새 채팅에서 사용할 변수의 기본값이에요.</p>
          </div>
          <button
            type="button"
            disabled={locked}
            onClick={() => write(() => addDefaultVariable(variables), 'variables')}
          >
            <AddIcon size={16} aria-hidden="true" />
            변수 추가
          </button>
        </div>
        <div className="nt-variable-heading">
          <span>변수 키</span>
          <span>문자열 값</span>
          <span />
        </div>
        {parseDefaultVariableLines(variables)
          .filter((line) => line.raw.trim())
          .map((line, index) =>
            line.key !== null ? (
              <div className="nt-variable-row" key={line.index}>
                {field(
                  `variable.${line.index}.key`,
                  `변수 ${index + 1} 키`,
                  line.key,
                  (key) => editDefaultVariable(variables, line.index, { key }),
                  'variables'
                )}
                {field(
                  `variable.${line.index}.value`,
                  `${line.key} 기본값`,
                  line.value ?? '',
                  (next) => editDefaultVariable(variables, line.index, { value: next }),
                  'variables'
                )}
                <IconButton
                  label={`${line.key} 변수 삭제`}
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
                <small>원문 보존</small>
              </div>
            )
          )}
        {!variables && <p className="muted">변수를 추가하거나 원문을 붙여 넣으세요.</p>}
      </div>
    );
  else
    content = (
      <>
        <div className="nt-mobile-groups">
          <label>
            그룹
            <select
              aria-label="토글 그룹 선택"
              value={current.id}
              disabled={invalidPending}
              onChange={(event) => selectGroup(Number(event.target.value))}
            >
              {groups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </select>
          </label>
          {mode === 'edit' && (
            <IconButton
              label="그룹 추가"
              icon={AddIcon}
              disabled={locked}
              onClick={openGroupDialog}
            />
          )}
        </div>
        <div className="nt-body">
          <nav className="nt-groups" aria-label="토글 그룹">
            <div className="nt-nav-heading">
              <span>그룹</span>
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
                <span>{group.name}</span>
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
                그룹 추가
              </button>
            )}
          </nav>
          <div className="nt-main">
            <div className="nt-heading">
              <div>
                <h3>{query && mode === 'edit' ? '검색 결과' : current.name}</h3>
                <p>
                  {query && mode === 'edit'
                    ? '전체 그룹에서 찾아요.'
                    : `${count(current)}개 설정 · ${current.items.filter((item) => item.definition?.type === 'divider').length}개 구분선`}
                </p>
              </div>
              {!query && mode === 'edit' && (
                <div className="nt-heading-actions">
                  <ActionMenu label="항목 추가" icon={AddIcon} className="nt-add-item" viewport>
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
                    <ActionMenu label="그룹 메뉴" viewport>
                      <button
                        type="button"
                        disabled={locked}
                        onClick={() => {
                          setGroupName(current.name);
                          setGroupDialog('rename');
                        }}
                      >
                        이름 변경
                      </button>
                      <button
                        type="button"
                        disabled={locked}
                        onClick={() => structural(() => moveToggleGroup(value, current.id, -1))}
                      >
                        그룹 위로 이동
                      </button>
                      <button
                        type="button"
                        disabled={locked}
                        onClick={() => structural(() => moveToggleGroup(value, current.id, 1))}
                      >
                        그룹 아래로 이동
                      </button>
                      <button
                        type="button"
                        disabled={locked}
                        onClick={() => structural(() => ungroupToggleGroup(value, current.id), -1)}
                      >
                        그룹 해제
                      </button>
                      <button
                        type="button"
                        disabled={locked}
                        onClick={() =>
                          setConfirmation({
                            title: '그룹 삭제',
                            description: `‘${current.name}’ 그룹과 안의 모든 항목을 삭제해요. 항목을 남기려면 그룹 해제를 사용하세요.`,
                            action: () =>
                              structural(() => deleteToggleGroup(value, current.id), -1),
                          })
                        }
                      >
                        그룹 삭제
                      </button>
                    </ActionMenu>
                  )}
                </div>
              )}
            </div>
            {mode === 'preview' ? (
              <div className="nt-preview">
                <div className="nt-preview-notice">
                  <span>미리보기에서 바꾼 값은 저장되지 않아요.</span>
                  <button type="button" className="ghost" onClick={() => setPreview({})}>
                    초기화
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
                  {query && <h4>{group.name}</h4>}
                  {group.items
                    .filter(
                      (item) =>
                        item.raw.trim() &&
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
                            .includes(query.trim().toLocaleLowerCase()))
                    )
                    .map((item) => itemRow(item, group.id))}
                </div>
              ))
            )}
            {!current.items.length && !query && mode === 'edit' && (
              <p className="muted nt-empty">항목을 추가해 토글을 구성하세요.</p>
            )}
          </div>
        </div>
      </>
    );
  return (
    <section className="native-toggle-editor" aria-label="토글 정의 편집기">
      <div className="nt-toolbar">
        <div className="nt-sections" aria-label="편집 문서">
          <button
            type="button"
            aria-pressed={section === 'toggles'}
            disabled={invalidPending}
            onClick={() => setSection('toggles')}
          >
            토글 구성
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
            기본 변수
          </button>
        </div>
        {mode === 'edit' && section === 'toggles' && (
          <label className="nt-search">
            <SearchIcon size={16} aria-hidden="true" />
            <input
              aria-label="이름, 키, 설명 검색"
              placeholder="이름, 키, 설명 검색"
              value={query}
              disabled={invalidPending}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
        )}
        <div className="nt-modes" aria-label="편집 보기">
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
                  {item === 'edit' ? '편집' : item === 'preview' ? '미리보기' : '원문'}
                </button>
              );
            })}
        </div>
      </div>
      {(error || invalidPending) && (
        <div className="nt-error">
          <p role="alert">{error || '아직 적용하지 못한 입력이 있어요. 내용을 확인해 주세요.'}</p>
          {invalidPending && (
            <button
              type="button"
              onClick={() => {
                setInvalid({});
                setError('');
              }}
            >
              잘못된 입력 되돌리기
            </button>
          )}
        </div>
      )}
      {sourcePending && mode !== 'raw' && (
        <p className="nt-notice">적용하지 않은 원문이 있어요. 원문 보기에서 적용해 주세요.</p>
      )}
      {content}
      <footer className="nt-footer">
        <span>
          {groups.length - 1}개 그룹 · {groups.reduce((total, group) => total + count(group), 0)}개
          설정{unknown > 0 ? ` · 원문 항목 ${unknown}개 보존` : ''}
        </span>
        <div>
          <IconButton
            label="편집 되돌리기"
            icon={UndoIcon}
            disabled={locked || !history.length}
            onClick={() => restore(false)}
          />
          <IconButton
            label="편집 다시 적용"
            icon={ForwardIcon}
            disabled={locked || !future.length}
            onClick={() => restore(true)}
          />
        </div>
      </footer>
      {doc.warnings.map((warning) => (
        <p key={warning} className="nt-notice">
          {warning}
        </p>
      ))}
      <Dialog
        open={confirmation !== null}
        title={confirmation?.title ?? '변경 확인'}
        onClose={() => setConfirmation(null)}
      >
        <p>{confirmation?.description}</p>
        <div className="actions">
          <button type="button" onClick={() => setConfirmation(null)}>
            취소
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => {
              confirmation?.action();
              setConfirmation(null);
            }}
          >
            계속
          </button>
        </div>
      </Dialog>
      <Dialog
        open={groupDialog !== null}
        title={groupDialog === 'add' ? '그룹 추가' : '그룹 이름 변경'}
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
            그룹 이름
            <input
              aria-label="그룹 이름"
              value={groupName}
              onChange={(event) => setGroupName(event.target.value)}
            />
          </label>
          <div className="actions">
            <button type="button" onClick={() => setGroupDialog(null)}>
              취소
            </button>
            <button type="submit" disabled={!groupName.trim() || /[=\r\n]/.test(groupName)}>
              적용
            </button>
          </div>
        </form>
      </Dialog>
    </section>
  );
}
