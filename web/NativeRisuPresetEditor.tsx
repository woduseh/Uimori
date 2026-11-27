import { useI18n } from './i18n.js';
import { UiError, uiMessage, type UiMessage } from './ui-message.js';
import type { ResourceModel } from '../core/resource-editing.js';
import { NoticeBanner } from './NoticeBanner.js';
import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import {
  useAnchorArrival,
  type ResourceAnchor,
  type ResourceAnchorRequest,
} from './resource-anchor.js';
import {
  createNativeRisuPresetProgram,
  nativeRisuPresetSource,
  nativeRisuToggleItems,
} from '../core/risu-native-preset.js';
import { validateRisuPrompt, type RisuPrompt, type PromptValue } from '../core/risu-prompt.js';
import { toUiMessage } from './api-errors.js';
import { PromptControlFields } from './PromptControlFields.js';
import { NativeRisuRegexEditor } from './NativeRisuRegexEditor.js';
import { StudioPanel, useStudioItem } from './EditorStudio.js';
import { EditorHelperItemAction } from './EditorHelperAction.js';
import { NativeRisuToggleEditor } from './NativeRisuToggleEditor.js';
import {
  useBufferedEditorState,
  useUnappliedEditorField,
  useEditorSavePreparation,
} from './resource-editor.js';
import {
  presetSection,
  presetSectionLabelKey,
  promptBlockTypeLabels,
  type PresetSection,
} from './studio-sections.js';
import { IconButton } from './IconButton.js';
import { CbsNamesContext, CodeField } from './CodeField.js';
import { cbsUseLocator } from './CbsReferenceList.js';
import { useCbsNames, usePresetReferences } from './cbs-reference-index.js';
import {
  codeFieldName,
  revealEditorTarget,
  type EditorJumpTarget,
  type EditorReveal,
} from './code-field-reveal.js';
import { useStableHandler } from './useStableHandler.js';
import { NativeDeleteDialog } from './NativeDeleteDialog.js';
import { AddIcon, UpIcon, DownIcon, DeleteIcon, DragHandleIcon } from './ui-icons.js';
import './native-editor.css';

const text = (value: unknown) => (typeof value === 'string' ? value : '');
const ROLE_TYPES = ['plain', 'cache', 'persona', 'description', 'authornote'];
const blockBody = (block: Record<string, unknown>) =>
  ['plain', 'chatML'].includes(text(block.type)) ? text(block.text) : text(block.innerFormat);
const roleField = (block: Record<string, unknown>) =>
  ['plain', 'cache'].includes(text(block.type)) ? 'role' : 'role2';
const blockRole = (block: Record<string, unknown>) => {
  const role = text(block[roleField(block)]) || (block.type === 'cache' ? 'all' : 'system');
  return role === 'bot' ? 'assistant' : role;
};

type Section = PresetSection;
let regexJumpEpoch = 0;
type BlockDropTarget = { index: number; position: 'before' | 'after' };

export function NativeRisuPresetEditor({
  program,
  onChange,
  onPendingDraftChange,
  values = {},
  onValuesChange,
  collaboration,
  metadata,
  anchor = null,
  onSelect,
  idPrefix: id,
  reveal = null,
}: {
  reveal?: EditorReveal | null;
  onSelect: (section: Section) => void;
  idPrefix: string;
  anchor?: ResourceAnchorRequest | null;
  program: RisuPrompt;
  onChange: (program: RisuPrompt) => void;
  onPendingDraftChange?: (pending: boolean) => void;
  values?: Record<string, PromptValue>;
  onValuesChange?: (values: Record<string, PromptValue>) => void;
  collaboration?: ReactNode;
  metadata?: ReactNode;
}) {
  const { t } = useI18n();
  const blockTypes = promptBlockTypeLabels();
  const source = program.nativeRisuPreset.preset;
  const [selected, setSelected] = useState(0);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<UiMessage | null>(null);
  const [dragged, setDragged] = useState<number | null>(null);
  const [dropTarget, setDropTarget] = useState<BlockDropTarget | null>(null);
  const [regexPending, setRegexPending] = useState(false);
  const [togglePending, setTogglePending] = useState(false);
  const [removing, setRemoving] = useState<number | null>(null);
  const [regexFocus, setRegexFocus] = useState<{ index: number; epoch: number } | null>(null);
  const arrival = useRef<AbortController | null>(null);
  useEffect(() => () => arrival.current?.abort(), []);
  const references = usePresetReferences(source);
  const names = useCbsNames(references);
  const sections: readonly Section[] = ['blocks', 'regex', 'variables'];
  const locate = cbsUseLocator(t, (target) =>
    sections.includes(target as Section) ? t(presetSectionLabelKey(target as Section)) : target
  );
  function jumpTo(use: EditorJumpTarget) {
    const target = use.section as Section;
    if (!sections.includes(target) && target !== 'options' && target !== 'collaboration') return;
    onSelect(target);
    if (target === 'blocks' && use.item !== null) {
      setSelected(use.item);
      setQuery('');
    }
    if (target === 'regex' && use.item !== null)
      setRegexFocus({ index: use.item, epoch: ++regexJumpEpoch });
    arrival.current?.abort();
    arrival.current = new AbortController();
    revealEditorTarget(
      () => document.getElementById(`${id}-${target}-panel`),
      use,
      '.native-item-detail',
      arrival.current.signal
    );
  }
  const revealed = useRef(0);
  const revealTarget = useStableHandler(jumpTo);
  useEffect(() => {
    if (!reveal || revealed.current === reveal.epoch) return;
    revealed.current = reveal.epoch;
    revealTarget(reveal);
  }, [reveal, revealTarget]);
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
      throw new UiError(uiMessage('native.text_f70715474c'));
    return model;
  });
  const prepareProgram = (model: ResourceModel, patch: Record<string, unknown>): ResourceModel => {
    if (!('program' in model)) throw new UiError(uiMessage('native.text_a52034ad77'));
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
  useStudioItem(entry ? index : null, entry ? blockTitle(entry) : '', 'blocks');
  const anchorSection = (target: ResourceAnchor): Section =>
    target.section === 'prompt' ? 'blocks' : (presetSection(target.path ?? '') ?? 'options');
  useAnchorArrival(
    anchor,
    (target) => {
      const panel = document.getElementById(`${id}-${anchorSection(target)}-panel`);
      return target.index !== null && anchorSection(target) === 'blocks'
        ? (panel?.querySelector('.native-item-detail') ?? null)
        : panel;
    },
    (target) => {
      const next = anchorSection(target);
      onSelect(next);
      if (next === 'blocks' && target.index !== null) {
        setSelected(target.index);
        setQuery('');
      }
    }
  );
  function mark(part: string, active: boolean) {
    setPendingParts((current) =>
      active ? [...new Set([...current, part])] : current.filter((key) => key !== part)
    );
  }
  function update(patch: Record<string, unknown>, part?: string) {
    try {
      if (Object.hasOwn(patch, 'customPromptTemplateToggle'))
        nativeRisuToggleItems(text(patch.customPromptTemplateToggle));
      onChange({
        ...program,
        nativeRisuPreset: { ...program.nativeRisuPreset, preset: { ...source, ...patch } },
      });
      setError(null);
      if (part) mark(part, false);
    } catch (caught) {
      setError(toUiMessage(caught));
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
  function blockTitle(block: Record<string, unknown>) {
    return text(block.name) || blockTypes[text(block.type)] || text(block.type);
  }
  function remove(target: number) {
    setRemoving(null);
    update({ promptTemplate: items.filter((_, i) => i !== target) });
    setSelected(Math.max(0, target - 1));
  }
  function add() {
    update({
      promptTemplate: [
        ...items,
        { type: 'plain', role: 'system', text: '', name: t('prompts.uiNewPrompt') },
      ],
    });
    setSelected(items.length);
    setQuery('');
  }
  return (
    <CbsNamesContext.Provider value={names}>
      <section
        aria-label={t('native.text_f1ab612224')}
        className="native-editor native-risu-preset-editor"
      >
        {error && (
          <NoticeBanner className="native-editor-notice" tone="error">
            {error}
          </NoticeBanner>
        )}
        {pending && (
          <NoticeBanner className="native-editor-notice">
            {t('native.text_9cceef2250')}
          </NoticeBanner>
        )}
        <StudioPanel section="blocks" className="native-editor-split native-panes">
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
                  data-studio-item={i}
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
                    {i + 1}. {blockTitle(block)}
                  </strong>
                  <small className="ui-meta-row">
                    <span className="native-block-chip">
                      {ROLE_TYPES.includes(text(block.type))
                        ? blockRole(block)
                        : (blockTypes[text(block.type)] ?? text(block.type))}
                    </span>
                    {text(block.name) && ROLE_TYPES.includes(text(block.type)) && (
                      <span>{blockTypes[text(block.type)] ?? text(block.type)}</span>
                    )}
                    {!!blockBody(block).length && (
                      <span>{t('native.characterCount', { count: blockBody(block).length })}</span>
                    )}
                  </small>
                  <span className="native-row-drag-handle" aria-hidden="true">
                    <DragHandleIcon size={16} />
                  </span>
                </button>
              ))}
          </aside>
          <div className="native-item-detail">
            {!!items.length && (
              <div className="native-mobile-picker">
                <select
                  aria-label={t('native.text_429c4628a8')}
                  value={index}
                  onChange={(e) => setSelected(Number(e.target.value))}
                >
                  {items.map((block, i) => (
                    <option key={i} value={i}>
                      {i + 1}. {blockTitle(block)}
                    </option>
                  ))}
                </select>
                <IconButton label={t('native.text_454e043199')} icon={AddIcon} onClick={add} />
              </div>
            )}
            {entry ? (
              <>
                <div className="native-detail-heading">
                  <h3>{blockTitle(entry)}</h3>
                  <EditorHelperItemAction
                    index={index}
                    label={blockTitle(entry)}
                    section="blocks"
                  />
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
                    onClick={() =>
                      entry.type === 'plain' && !text(entry.text).trim()
                        ? remove(index)
                        : setRemoving(index)
                    }
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
                  {ROLE_TYPES.includes(text(entry.type)) && (
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
                    <CodeField
                      className="native-main-text"
                      name={codeFieldName('blocks', index, 'text')}
                      aria-label={t('native.blockText', { number: index + 1 })}
                      value={text(entry.text)}
                      onChange={(next) => item({ text: next })}
                    />
                  </label>
                ) : (
                  ['persona', 'description', 'authornote'].includes(text(entry.type)) && (
                    <label>
                      {t('native.wrapperLabel', { slot: '{{slot}}' })}
                      <CodeField
                        name={codeFieldName('blocks', index, 'innerFormat')}
                        aria-label={t('native.blockWrapper', { number: index + 1 })}
                        rows={8}
                        value={text(entry.innerFormat)}
                        onChange={(next) => item({ innerFormat: next })}
                      />
                    </label>
                  )
                )}
                {entry.type === 'authornote' && (
                  <label>
                    {t('native.text_d955c69f94')}
                    <CodeField
                      name={codeFieldName('blocks', index, 'defaultText')}
                      aria-label={t('native.text_d955c69f94')}
                      rows={6}
                      value={text(entry.defaultText)}
                      onChange={(next) => item({ defaultText: next })}
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
                        {text(entry.type2) &&
                          !['main', 'globalNote'].includes(text(entry.type2)) && (
                            <option value={text(entry.type2)}>{text(entry.type2)}</option>
                          )}
                      </select>
                    </label>
                  )}
                </details>
              </>
            ) : (
              <div className="native-empty">
                <strong>{t('native.noBlocks')}</strong>
                <button type="button" onClick={add}>
                  <AddIcon size={18} aria-hidden="true" />
                  {t('native.text_454e043199')}
                </button>
              </div>
            )}
          </div>
        </StudioPanel>
        <StudioPanel section="options" className="native-section-body">
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
            <div className="native-form-stack">
              <p className="muted">{t('native.noToggles')}</p>
              <button type="button" className="secondary" onClick={() => onSelect('variables')}>
                {t('native.openVariablesAndToggles')}
              </button>
            </div>
          )}
        </StudioPanel>
        <StudioPanel section="variables" className="native-section-body native-toggle-panel">
          <NativeRisuToggleEditor
            value={text(source.customPromptTemplateToggle)}
            variables={text(source.templateDefaultVariables)}
            program={program}
            references={references}
            locate={locate}
            onJump={jumpTo}
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
        </StudioPanel>
        <StudioPanel section="regex" className="native-panes native-regex-panel">
          <NativeRisuRegexEditor
            focus={regexFocus}
            value={(source.regex ?? source.presetRegex ?? []) as unknown[]}
            draftPath="prompt.native.regex"
            onPendingChange={setRegexPending}
            prepareSave={(model, regex) =>
              prepareProgram(model, {
                [source.regex != null || source.presetRegex == null ? 'regex' : 'presetRegex']:
                  regex,
              })
            }
            onChange={(regex) =>
              update({
                [source.regex != null || source.presetRegex == null ? 'regex' : 'presetRegex']:
                  regex,
              })
            }
          />
        </StudioPanel>
        {collaboration && (
          <StudioPanel section="collaboration" className="native-section-body">
            {collaboration}
          </StudioPanel>
        )}
        <NativeDeleteDialog
          target={removing === null ? null : blockTitle(items[removing] ?? {})}
          action={t('native.blockDelete')}
          onCancel={() => setRemoving(null)}
          onConfirm={() => {
            if (removing !== null) remove(removing);
          }}
        />
      </section>
    </CbsNamesContext.Provider>
  );
}
