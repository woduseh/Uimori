import { useI18n, translateMessage } from './i18n.js';
import type { ResourceModel } from '../core/resource-editing.js';
import { NoticeBanner } from './NoticeBanner.js';
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
  const { t } = useI18n();
  const blockTypes: Record<string, string> = {
    plain: t('native.text_87c554df93'),
    description: t('native.text_4c515a8bac'),
    persona: t('native.text_789c237f0d'),
    lorebook: t('native.text_5ce4911d95'),
    chat: t('native.text_c0a10149c3'),
    authornote: t('native.text_ec0f0b70df'),
    postEverything: t('native.text_bc212cb334'),
    cache: t('native.text_33ff59f35d'),
    chatML: 'ChatML',
  };
  const source = program.nativeRisuPreset.preset;
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
    { id: 'blocks', title: t('native.text_a0a7b7b4e4') },
    { id: 'options', title: t('native.text_a1c1f8f5fe') },
    { id: 'variables', title: t('native.text_0a13d19d88') },
    { id: 'regex', title: t('native.text_fc7e4f6228') },
    ...(collaboration
      ? [{ id: 'collaboration' as const, title: t('native.text_780d3f6ed3') }]
      : []),
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
      // Controls are read during render, so a malformed declaration stays in its field buffer.
      if (Object.hasOwn(patch, 'customPromptTemplateToggle'))
        nativeRisuToggleItems(text(patch.customPromptTemplateToggle));
      // The form owns these fields. Whole-program validation stays at JSON apply/save.
      onChange({
        ...program,
        nativeRisuPreset: { ...program.nativeRisuPreset, preset: { ...source, ...patch } },
      });
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
      aria-label={t('native.text_f1ab612224')}
      className="native-editor native-risu-preset-editor"
    >
      <SectionNavigation
        label={t('native.text_a8a8b42c1a')}
        items={sections}
        value={section}
        onSelect={setSection}
        compact={false}
        orientation="horizontal"
        idPrefix={id}
      />
      {error && (
        <NoticeBanner className="native-editor-notice" tone="error">
          {t('native.inputPreserved', { error: translateMessage(error) })}
        </NoticeBanner>
      )}
      {pending && (
        <NoticeBanner className="native-editor-notice">{t('native.text_9cceef2250')}</NoticeBanner>
      )}
      <div {...panel('blocks')} className="native-editor-split">
        <aside className="native-item-list" aria-label={t('native.text_944b1569af')}>
          <input
            type="search"
            aria-label={t('native.text_19429a1bab')}
            placeholder={t('native.text_4fa535d186')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="native-list-heading">
            <strong>{t('native.text_02eb4cbf48')}</strong>
            <IconButton label={t('native.text_454e043199')} icon={AddIcon} onClick={add} />
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
                title={t('native.text_52df394c6c')}
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
          {!items.length && <p className="muted">{t('native.text_df1793f88e')}</p>}
        </aside>
        <div className="native-item-detail">
          <div className="native-mobile-picker">
            <button type="button" disabled={index === 0} onClick={() => setSelected(index - 1)}>
              {t('native.text_dc03452ea5')}
            </button>
            <select
              aria-label={t('native.text_429c4628a8')}
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
              {t('native.text_854c76f3bc')}
            </button>
            <IconButton label={t('native.text_454e043199')} icon={AddIcon} onClick={add} />
          </div>
          {entry ? (
            <>
              <div className="native-detail-heading">
                <h3>{text(entry.name) || blockTypes[text(entry.type)] || text(entry.type)}</h3>
                <IconButton
                  label={t('native.text_baea99787c')}
                  icon={UpIcon}
                  disabled={index === 0}
                  onClick={() => move(-1)}
                />
                <IconButton
                  label={t('native.text_8e2c1e509f')}
                  icon={DownIcon}
                  disabled={index === items.length - 1}
                  onClick={() => move(1)}
                />
                <IconButton
                  label={t('native.text_47a1c510fc')}
                  icon={DeleteIcon}
                  onClick={() => {
                    update({ promptTemplate: items.filter((_, i) => i !== index) });
                    setSelected(Math.max(0, index - 1));
                  }}
                />
              </div>
              <div className="native-field-row">
                <label>
                  {t('native.text_d07c6c9a24')}
                  <input
                    aria-label={t('native.blockName', { number: index + 1 })}
                    value={text(entry.name)}
                    onChange={(e) => item({ name: e.target.value })}
                  />
                </label>
                {['plain', 'cache', 'persona', 'description', 'authornote'].includes(
                  text(entry.type)
                ) && (
                  <label>
                    {t('native.text_32ae236cf2')}
                    <select
                      aria-label={t('native.blockRole', { number: index + 1 })}
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
                      {entry.type === 'cache' && (
                        <option value="all">{t('native.text_8ef0fce074')}</option>
                      )}
                      <option value="system">system</option>
                      <option value="user">user</option>
                      <option value="assistant">assistant</option>
                    </select>
                  </label>
                )}
              </div>
              {['plain', 'chatML'].includes(text(entry.type)) ? (
                <label>
                  {t('native.text_d7e4bc7b33')}
                  <textarea
                    className="native-main-text"
                    aria-label={t('native.blockText', { number: index + 1 })}
                    rows={16}
                    value={text(entry.text)}
                    onChange={(e) => item({ text: e.target.value })}
                  />
                </label>
              ) : (
                ['persona', 'description', 'authornote'].includes(text(entry.type)) && (
                  <label>
                    {t('native.wrapperLabel', { slot: '{{slot}}' })}
                    <textarea
                      aria-label={t('native.blockWrapper', { number: index + 1 })}
                      rows={8}
                      value={text(entry.innerFormat)}
                      onChange={(e) => item({ innerFormat: e.target.value })}
                    />
                  </label>
                )
              )}
              {entry.type === 'authornote' && (
                <label>
                  {t('native.text_d955c69f94')}
                  <textarea
                    rows={6}
                    value={text(entry.defaultText)}
                    onChange={(e) => item({ defaultText: e.target.value })}
                  />
                </label>
              )}
              {entry.type === 'cache' && (
                <label>
                  {t('native.text_eb0f40ca8a')}
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
                      {t('native.text_e6f61d0992')}
                      <input
                        type="number"
                        value={Number(entry.rangeStart ?? 0)}
                        onChange={(e) => item({ rangeStart: Number(e.target.value) })}
                      />
                    </label>
                    <label>
                      {t('native.text_ceaf10f53c')}
                      <select
                        aria-label={t('native.text_9db9f7b66d')}
                        value={typeof entry.rangeEnd === 'number' ? 'index' : 'end'}
                        onChange={(e) =>
                          item({
                            rangeEnd: e.target.value === 'end' ? 'end' : 0,
                          })
                        }
                      >
                        <option value="end">{t('native.text_5c49b4ed94')}</option>
                        <option value="index">{t('native.text_9b941bf823')}</option>
                      </select>
                    </label>
                    {typeof entry.rangeEnd === 'number' && (
                      <label>
                        {t('native.text_32ed1c6997')}
                        <input
                          type="number"
                          aria-label={t('native.text_54282a64fa')}
                          value={entry.rangeEnd}
                          onChange={(e) => item({ rangeEnd: Number(e.target.value) })}
                        />
                      </label>
                    )}
                  </div>
                </>
              )}
              {entry.type === 'memory' && <p className="muted">{t('native.text_ed60b1eb22')}</p>}
              <details className="native-advanced">
                <summary>
                  {t('native.blockTypeLabel', {
                    type: blockTypes[text(entry.type)] ?? text(entry.type),
                  })}
                </summary>
                <label>
                  {t('native.text_29efb69b57')}
                  <select
                    aria-label={t('native.blockType', { number: index + 1 })}
                    value={text(entry.type)}
                    onChange={(e) => item({ type: e.target.value })}
                  >
                    {!Object.hasOwn(blockTypes, text(entry.type)) && (
                      <option value={text(entry.type)}>
                        {t('native.unsupportedType', { type: text(entry.type) })}
                      </option>
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
                    {t('native.text_b3a5837124')}
                    <select
                      value={text(entry.type2)}
                      onChange={(e) => item({ type2: e.target.value })}
                    >
                      <option value="">{t('native.text_aef1a1e70e')}</option>
                      <option value="main">{t('native.text_1a1614b09b')}</option>
                      <option value="globalNote">{t('native.text_2d2a2c8204')}</option>
                      {text(entry.type2) && !['main', 'globalNote'].includes(text(entry.type2)) && (
                        <option value={text(entry.type2)}>{text(entry.type2)}</option>
                      )}
                    </select>
                  </label>
                )}
              </details>
            </>
          ) : (
            <p className="muted">{t('native.text_f470124b0d')}</p>
          )}
        </div>
      </div>
      <div {...panel('options')} className="native-section-body">
        {metadata}
        <h3>{t('native.text_90e595ef29')}</h3>
        {!!nativeRisuToggleItems(text(source.customPromptTemplateToggle)).length &&
        onValuesChange ? (
          <PromptControlFields
            program={program}
            values={values}
            onChange={(key, value) => onValuesChange({ ...values, [key]: value })}
          />
        ) : (
          <p className="muted">{t('native.text_b5607fffbc')}</p>
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
