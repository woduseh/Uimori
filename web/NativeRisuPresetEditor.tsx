import type { ResourceModel } from '../core/resource-editing.js';
import { useEffect, useId, useState, type DragEvent, type ReactNode } from 'react';
import {
  createNativeRisuPresetProgram,
  nativeRisuPresetSource,
  nativeRisuToggleItems,
} from '../core/risu-native-preset.js';
import { validateRisuPrompt, type RisuPrompt, type PromptValue } from '../core/risu-prompt.js';
import { PromptControlFields } from './PromptControlFields.js';
import { NativeRisuRegexEditor } from './NativeRisuRegexEditor.js';
import { NativeRisuToggleEditor } from './NativeRisuToggleEditor.js';
import {
  useBufferedEditorState,
  useUnappliedEditorField,
  useEditorSavePreparation,
} from './resource-editor.js';
import { SectionNavigation } from './SectionNavigation.js';
import { IconButton } from './IconButton.js';
import { AddIcon, UpIcon, DownIcon, DeleteIcon, DragHandleIcon } from './ui-icons.js';
import './native-editor.css';

const text = (value: unknown) => (typeof value === 'string' ? value : '');
const roleField = (block: Record<string, unknown>) =>
  ['plain', 'cache'].includes(text(block.type)) ? 'role' : 'role2';
const blockRole = (block: Record<string, unknown>) => {
  const role = text(block[roleField(block)]) || (block.type === 'cache' ? 'all' : 'system');
  return role === 'bot' ? 'assistant' : role;
};
const blockTypes: Record<string, string> = {
  plain: '일반 텍스트',
  description: '캐릭터 설명',
  persona: '페르소나',
  lorebook: '로어북',
  chat: '대화 기록',
  authornote: '작가 노트',
  postEverything: '마지막 지침',
  cache: '캐시',
  chatML: 'ChatML',
};
type Section = 'blocks' | 'options' | 'variables' | 'regex' | 'collaboration';
type BlockDropTarget = { index: number; position: 'before' | 'after' };

export function NativeRisuPresetEditor({
  program,
  onChange,
  onPendingDraftChange,
  values = {},
  onValuesChange,
  collaboration,
  metadata,
}: {
  program: RisuPrompt;
  onChange: (program: RisuPrompt) => void;
  onPendingDraftChange?: (pending: boolean) => void;
  values?: Record<string, PromptValue>;
  onValuesChange?: (values: Record<string, PromptValue>) => void;
  collaboration?: ReactNode;
  metadata?: ReactNode;
}) {
  const source = nativeRisuPresetSource(program.nativeRisuPreset.preset).preset;
  const id = useId();
  const [section, setSection] = useState<Section>('blocks');
  const [selected, setSelected] = useState(0);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [dragged, setDragged] = useState<number | null>(null);
  const [dropTarget, setDropTarget] = useState<BlockDropTarget | null>(null);
  const [regexPending, setRegexPending] = useState(false);
  const [togglePending, setTogglePending] = useState(false);
  const [pendingParts, setPendingParts] = useBufferedEditorState<string[]>(
    'prompt.native.pendingParts',
    []
  );
  const pending =
    pendingParts.some((part) => part !== 'regex' && part !== 'toggles') ||
    regexPending ||
    togglePending;
  useUnappliedEditorField('prompt.native.source', pending);
  useEditorSavePreparation('prompt.native.source', (model) => {
    if (pendingParts.some((part) => part !== 'regex' && part !== 'toggles'))
      throw new Error('프롬프트의 잘못된 입력을 확인해 주세요.');
    return model;
  });
  const prepareProgram = (model: ResourceModel, patch: Record<string, unknown>): ResourceModel => {
    if (!('program' in model)) throw new Error('프리셋 편집기에서 저장해 주세요.');
    const input = { ...model.program.nativeRisuPreset.preset, ...patch };
    return {
      ...model,
      program: validateRisuPrompt({
        ...model.program,
        ...createNativeRisuPresetProgram(nativeRisuPresetSource(input)),
      }),
    };
  };
  useEffect(() => {
    onPendingDraftChange?.(pending);
  }, [pending, onPendingDraftChange]);
  useEffect(() => () => onPendingDraftChange?.(false), [onPendingDraftChange]);
  const items = source.promptTemplate as Record<string, unknown>[];
  const index = Math.min(selected, Math.max(0, items.length - 1));
  const entry = items[index];
  const sections: { id: Section; title: string }[] = [
    { id: 'blocks', title: '구성' },
    { id: 'options', title: '기본 옵션' },
    { id: 'variables', title: '변수·토글' },
    { id: 'regex', title: '정규식' },
    ...(collaboration ? [{ id: 'collaboration' as const, title: '협업' }] : []),
  ];
  const panel = (key: Section) => ({
    id: id + '-' + key + '-panel',
    role: 'tabpanel' as const,
    'aria-labelledby': id + '-' + key + '-tab',
    hidden: section !== key,
  });
  function mark(part: string, active: boolean) {
    setPendingParts((current) =>
      active ? [...new Set([...current, part])] : current.filter((key) => key !== part)
    );
  }
  function update(patch: Record<string, unknown>, part?: string) {
    try {
      const native = nativeRisuPresetSource({ ...source, ...patch });
      onChange(validateRisuPrompt({ ...program, ...createNativeRisuPresetProgram(native) }));
      setError('');
      if (part) mark(part, false);
    } catch (caught) {
      setError((caught as Error).message);
      if (part) mark(part, true);
    }
  }
  function item(patch: Record<string, unknown>) {
    update({
      promptTemplate: items.map((value, i) => (i === index ? { ...value, ...patch } : value)),
    });
  }
  function move(delta: number) {
    const next = [...items];
    [next[index], next[index + delta]] = [next[index + delta]!, next[index]!];
    update({ promptTemplate: next });
    setSelected(index + delta);
  }
  function clearDrag() {
    setDragged(null);
    setDropTarget(null);
  }
  function blockDropTarget(event: DragEvent<HTMLButtonElement>, targetIndex: number) {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      index: targetIndex,
      position: event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after',
    } satisfies BlockDropTarget;
  }
  function dragOver(event: DragEvent<HTMLButtonElement>, targetIndex: number) {
    if (dragged == null) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDropTarget(blockDropTarget(event, targetIndex));
    const list = event.currentTarget.closest('.native-item-list');
    if (list) {
      const listBounds = list.getBoundingClientRect();
      if (event.clientY < listBounds.top + 36) list.scrollTop -= 12;
      if (event.clientY > listBounds.bottom - 36) list.scrollTop += 12;
    }
  }
  function drop(event: DragEvent<HTMLButtonElement>, target: BlockDropTarget) {
    event.preventDefault();
    const from = dragged;
    clearDrag();
    if (from == null) return;
    const next = [...items];
    const [moved] = next.splice(from, 1);
    if (!moved) return;
    let insertion = target.index + (target.position === 'after' ? 1 : 0);
    if (from < insertion) insertion -= 1;
    next.splice(insertion, 0, moved);
    if (insertion === from) return;
    update({ promptTemplate: next });
    setSelected(insertion);
  }
  function add() {
    update({
      promptTemplate: [...items, { type: 'plain', role: 'system', text: '', name: '새 프롬프트' }],
    });
    setSelected(items.length);
    setQuery('');
  }
  return (
    <section
      aria-label="Risu 프롬프트 원본 편집"
      className="native-editor native-risu-preset-editor"
    >
      <SectionNavigation
        label="프리셋 편집 영역"
        items={sections}
        value={section}
        onSelect={setSection}
        compact={false}
        orientation="horizontal"
        idPrefix={id}
      />
      {error && (
        <p className="error native-editor-notice" role="alert">
          {error} · 입력은 유지했어요.
        </p>
      )}
      {pending && (
        <p className="native-editor-notice" role="status">
          직접 편집 중인 원문이 있어요. 저장할 때 함께 반영해요.
        </p>
      )}
      <div {...panel('blocks')} className="native-editor-split">
        <aside className="native-item-list" aria-label="프롬프트 블록 목록">
          <input
            type="search"
            aria-label="프롬프트 블록 찾기"
            placeholder="블록 찾기"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="native-list-heading">
            <strong>프롬프트 블록</strong>
            <IconButton label="프롬프트 블록 추가" icon={AddIcon} onClick={add} />
          </div>
          {items
            .map((block, i) => ({ block, i }))
            .filter(({ block }) =>
              (text(block.name) + ' ' + (blockTypes[text(block.type)] ?? text(block.type)))
                .toLocaleLowerCase()
                .includes(query.toLocaleLowerCase())
            )
            .map(({ block, i }) => (
              <button
                type="button"
                key={i}
                aria-current={index === i ? 'true' : undefined}
                data-dragging={dragged === i ? 'true' : undefined}
                data-drop-position={dropTarget?.index === i ? dropTarget.position : undefined}
                draggable
                title="끌어서 순서 변경"
                onClick={() => setSelected(i)}
                onDragStart={(event) => {
                  setSelected(i);
                  setDragged(i);
                  event.dataTransfer.effectAllowed = 'move';
                  event.dataTransfer.setData('text/plain', String(i));
                }}
                onDragEnd={clearDrag}
                onDragOver={(event) => dragOver(event, i)}
                onDrop={(event) => drop(event, blockDropTarget(event, i))}
              >
                <strong>
                  {i + 1}. {text(block.name) || blockTypes[text(block.type)] || text(block.type)}
                </strong>
                <small>
                  {blockRole(block)} · {blockTypes[text(block.type)] ?? text(block.type)}
                </small>
                <span className="native-row-drag-handle" aria-hidden="true">
                  <DragHandleIcon size={16} />
                </span>
              </button>
            ))}
          {!items.length && <p className="muted">첫 프롬프트 블록을 추가해 주세요.</p>}
        </aside>
        <div className="native-item-detail">
          <div className="native-mobile-picker">
            <button type="button" disabled={index === 0} onClick={() => setSelected(index - 1)}>
              이전
            </button>
            <select
              aria-label="현재 프롬프트 블록"
              value={index}
              onChange={(e) => setSelected(Number(e.target.value))}
            >
              {items.map((block, i) => (
                <option key={i} value={i}>
                  {i + 1}. {text(block.name) || blockTypes[text(block.type)] || text(block.type)}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={index >= items.length - 1}
              onClick={() => setSelected(index + 1)}
            >
              다음
            </button>
            <IconButton label="프롬프트 블록 추가" icon={AddIcon} onClick={add} />
          </div>
          {entry ? (
            <>
              <div className="native-detail-heading">
                <h3>{text(entry.name) || blockTypes[text(entry.type)] || text(entry.type)}</h3>
                <IconButton
                  label="블록 위로"
                  icon={UpIcon}
                  disabled={index === 0}
                  onClick={() => move(-1)}
                />
                <IconButton
                  label="블록 아래로"
                  icon={DownIcon}
                  disabled={index === items.length - 1}
                  onClick={() => move(1)}
                />
                <IconButton
                  label="선택한 블록 삭제"
                  icon={DeleteIcon}
                  onClick={() => {
                    update({ promptTemplate: items.filter((_, i) => i !== index) });
                    setSelected(Math.max(0, index - 1));
                  }}
                />
              </div>
              <div className="native-field-row">
                <label>
                  블록 이름
                  <input
                    aria-label={index + 1 + '번 블록 이름'}
                    value={text(entry.name)}
                    onChange={(e) => item({ name: e.target.value })}
                  />
                </label>
                {['plain', 'cache', 'persona', 'description', 'authornote'].includes(
                  text(entry.type)
                ) && (
                  <label>
                    메시지 역할
                    <select
                      aria-label={index + 1 + '번 블록 역할'}
                      value={blockRole(entry)}
                      onChange={(e) =>
                        item({
                          [roleField(entry)]:
                            e.target.value === 'assistant' && entry.type !== 'cache'
                              ? 'bot'
                              : e.target.value,
                        })
                      }
                    >
                      {entry.type === 'cache' && <option value="all">전체 역할</option>}
                      <option value="system">system</option>
                      <option value="user">user</option>
                      <option value="assistant">assistant</option>
                    </select>
                  </label>
                )}
              </div>
              {['plain', 'chatML'].includes(text(entry.type)) ? (
                <label>
                  본문 · Risu CBS
                  <textarea
                    className="native-main-text"
                    aria-label={index + 1 + '번 프롬프트 본문'}
                    rows={16}
                    value={text(entry.text)}
                    onChange={(e) => item({ text: e.target.value })}
                  />
                </label>
              ) : (
                ['persona', 'description', 'authornote'].includes(text(entry.type)) && (
                  <label>
                    감싸는 문구 · {'{{slot}}'}
                    <textarea
                      aria-label={index + 1 + '번 감싸는 문구'}
                      rows={8}
                      value={text(entry.innerFormat)}
                      onChange={(e) => item({ innerFormat: e.target.value })}
                    />
                  </label>
                )
              )}
              {entry.type === 'authornote' && (
                <label>
                  작가 노트 기본값
                  <textarea
                    rows={6}
                    value={text(entry.defaultText)}
                    onChange={(e) => item({ defaultText: e.target.value })}
                  />
                </label>
              )}
              {entry.type === 'cache' && (
                <label>
                  캐시 대상 메시지 수
                  <input
                    type="number"
                    min={1}
                    max={4}
                    value={Number(entry.depth) || 1}
                    onChange={(e) => item({ depth: Number(e.target.value) })}
                  />
                </label>
              )}
              {entry.type === 'chat' && (
                <>
                  <div className="native-field-row">
                    <label>
                      시작 위치
                      <input
                        type="number"
                        value={Number(entry.rangeStart ?? 0)}
                        onChange={(e) => item({ rangeStart: Number(e.target.value) })}
                      />
                    </label>
                    <label>
                      끝 위치
                      <select
                        aria-label="대화 끝 위치 유형"
                        value={typeof entry.rangeEnd === 'number' ? 'index' : 'end'}
                        onChange={(e) =>
                          item({
                            rangeEnd: e.target.value === 'end' ? 'end' : 0,
                          })
                        }
                      >
                        <option value="end">마지막까지</option>
                        <option value="index">직접 지정</option>
                      </select>
                    </label>
                    {typeof entry.rangeEnd === 'number' && (
                      <label>
                        지정 위치
                        <input
                          type="number"
                          aria-label="대화 끝 위치"
                          value={entry.rangeEnd}
                          onChange={(e) => item({ rangeEnd: Number(e.target.value) })}
                        />
                      </label>
                    )}
                  </div>
                </>
              )}
              {entry.type === 'memory' && (
                <p className="muted">
                  이 블록은 실행하지 않아요. 기억은 채팅의 기억·로어 설정에서 관리해요.
                </p>
              )}
              <details className="native-advanced">
                <summary>블록 종류 · {blockTypes[text(entry.type)] ?? text(entry.type)}</summary>
                <label>
                  종류
                  <select
                    aria-label={index + 1 + '번 블록 종류'}
                    value={text(entry.type)}
                    onChange={(e) => item({ type: e.target.value })}
                  >
                    {!Object.hasOwn(blockTypes, text(entry.type)) && (
                      <option value={text(entry.type)}>{text(entry.type)} · 실행 미지원</option>
                    )}
                    {Object.entries(blockTypes).map(([key, label]) => (
                      <option key={key} value={key}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                {entry.type === 'plain' && (
                  <label>
                    지침 위치
                    <select
                      value={text(entry.type2)}
                      onChange={(e) => item({ type2: e.target.value })}
                    >
                      <option value="">일반</option>
                      <option value="main">메인 지침</option>
                      <option value="globalNote">글로벌노트</option>
                      {text(entry.type2) && !['main', 'globalNote'].includes(text(entry.type2)) && (
                        <option value={text(entry.type2)}>{text(entry.type2)}</option>
                      )}
                    </select>
                  </label>
                )}
              </details>
            </>
          ) : (
            <p className="muted">목록에서 블록을 추가해 구성을 시작하세요.</p>
          )}
        </div>
      </div>
      <div {...panel('options')} className="native-section-body">
        {metadata}
        <h3>프리셋 기본 옵션</h3>
        {!!nativeRisuToggleItems(text(source.customPromptTemplateToggle)).length &&
        onValuesChange ? (
          <PromptControlFields
            program={program}
            values={values}
            onChange={(key, value) => onValuesChange({ ...values, [key]: value })}
          />
        ) : (
          <p className="muted">정의된 토글이 없어요. 변수·토글에서 추가할 수 있어요.</p>
        )}
      </div>
      <div {...panel('variables')} className="native-section-body native-toggle-panel">
        <NativeRisuToggleEditor
          value={text(source.customPromptTemplateToggle)}
          variables={text(source.templateDefaultVariables)}
          program={program}
          draftPath="prompt.native.toggles"
          onPendingChange={setTogglePending}
          prepareSave={(model, values) =>
            prepareProgram(model, {
              customPromptTemplateToggle: values.toggles,
              templateDefaultVariables: values.variables,
            })
          }
          onChange={({ toggles, variables }) =>
            update(
              { customPromptTemplateToggle: toggles, templateDefaultVariables: variables },
              'toggles'
            )
          }
        />
      </div>
      <div {...panel('regex')} className="native-section-body native-regex-panel">
        <NativeRisuRegexEditor
          value={(source.regex ?? source.presetRegex ?? []) as unknown[]}
          draftPath="prompt.native.regex"
          onPendingChange={setRegexPending}
          prepareSave={(model, regex) =>
            prepareProgram(model, {
              [source.regex != null || source.presetRegex == null ? 'regex' : 'presetRegex']: regex,
            })
          }
          onChange={(regex) =>
            update({
              [source.regex != null || source.presetRegex == null ? 'regex' : 'presetRegex']: regex,
            })
          }
        />
      </div>
      {collaboration && (
        <div {...panel('collaboration')} className="native-section-body">
          {collaboration}
        </div>
      )}
    </section>
  );
}
