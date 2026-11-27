import { IllustrationAppearanceEditor } from './IllustrationAppearanceEditor.js';
import {
  readIllustrationAppearanceProfiles,
  withIllustrationAppearanceProfiles,
} from '../core/illustration-profiles.js';
import { useI18n } from './i18n.js';
import { UiError, formatUiMessage, uiMessage, type UiMessage } from './ui-message.js';
import { TranslationGuideEditor } from './TranslationGuideEditor.js';
import { readTranslationGuide, withTranslationGuide } from '../core/translation-guide.js';
import { editNativeSource, resourceWithNativeSource } from './native-source-edit.js';
import { toUiMessage } from './api-errors.js';
import type { ResourceModel } from '../core/resource-editing.js';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  useAnchorArrival,
  type ResourceAnchor,
  type ResourceAnchorRequest,
} from './resource-anchor.js';
import type { RisuContent } from '../core/risu-content.js';
import { detectRisuImageHandoff } from '../core/risu-image-handoff.js';
import {
  nativeRisuBackground,
  nativeRisuModuleBackground,
  nativeRisuExtension,
  nativeRisuLore,
  nativeRisuRegex,
  nativeRisuTriggers,
  normalizeRisuContentSource,
  type RisuContentSource,
} from '../core/risu-native.js';
import {
  useBufferedEditorState,
  useUnappliedEditorField,
  useEditorSavePreparation,
} from './resource-editor.js';
import { PackagePortraitEditor } from './PackagePortraitEditor.js';
import { PackageFeaturesEditor } from './PackageFeaturesEditor.js';
import { RisuImageHandoffFields } from './RisuImageHandoffFields.js';
import { NativeCollectionEditor } from './NativeCollectionEditor.js';
import { NativeRisuLoreEditor } from './NativeRisuLoreEditor.js';
import { NativeRisuAssetsEditor } from './NativeRisuAssetsEditor.js';
import { NativeRisuRegexEditor } from './NativeRisuRegexEditor.js';
import { StudioPanel } from './EditorStudio.js';
import { NativeRisuTriggerEditor } from './NativeRisuTriggerEditor.js';
import { IconButton } from './IconButton.js';
import { CbsNamesContext, CodeField } from './CodeField.js';
import { CbsReferenceList, cbsUseLocator } from './CbsReferenceList.js';
import { useCbsNames, useContentReferences } from './cbs-reference-index.js';
import {
  codeFieldName,
  revealEditorTarget,
  type EditorJumpTarget,
  type EditorReveal,
} from './code-field-reveal.js';
import { useStableHandler } from './useStableHandler.js';
import { CodeIcon, DisplayIcon } from './ui-icons.js';
import {
  FirstMessageWorkspace,
  RisuDraftStartPreview,
  useDraftPreviewShown,
} from './RisuDraftStartPreview.js';
import { useCompactLayout } from './useCompactLayout.js';
import { readPresentationChoice, writePresentationSetting } from './presentation-settings.js';
import { markupPreview } from './markup-preview.js';
import {
  availableSections,
  contentSection,
  contentSectionLabelKey,
  contentSectionRegistry,
  isAuthoringPath,
  isStandaloneModule,
  type ContentSection,
} from './studio-sections.js';
import { storageKeys } from './storage-keys.js';
import './native-editor.css';

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const string = (value: unknown) => (typeof value === 'string' ? value : '');
const GREETING_FONT_KEY = storageKeys.firstMessageFont;
const GREETING_FONTS = ['body', 'mono'] as const;
type SourcePart = 'greetings' | 'lore' | 'regex' | 'triggers' | 'card' | 'module';
type Section = ContentSection;
type Jump = { section: Section; index: number; epoch: number };
const itemSections: readonly Section[] = ['greetings', 'lore', 'regex', 'triggers'];
let jumpEpoch = 0;

function anchorSection(anchor: ResourceAnchor): Section {
  if (anchor.section === 'lore') return 'lore';
  return contentSection(anchor.path ?? '') ?? 'basic';
}

export function RisuNativeFields({
  value,
  onChange,
  onDraftChange,
  onPortraitBusy,
  anchor = null,
  section,
  onSelect,
  idPrefix: id,
  overview,
  saved = null,
  reveal = null,
}: {
  saved?: { id: string; revision: number } | null;
  reveal?: EditorReveal | null;
  value: RisuContent;
  onChange: (value: RisuContent) => void;
  onDraftChange?: (dirty: boolean) => void;
  onPortraitBusy: (busy: boolean) => void;
  anchor?: ResourceAnchorRequest | null;
  section: Section;
  onSelect: (section: Section) => void;
  idPrefix: string;
  overview?: ReactNode;
}) {
  const { t } = useI18n();

  const native = value.nativeRisu;
  const standalone = isStandaloneModule(value);
  const available = availableSections(contentSectionRegistry, value);
  const [greetingFont, setGreetingFont] = useState(() =>
    readPresentationChoice(GREETING_FONT_KEY, GREETING_FONTS, 'body')
  );
  const requested = anchor?.anchor ?? null;
  const anchoredLore =
    requested && anchorSection(requested) === 'lore' && requested.index !== null
      ? { index: requested.index, epoch: requested.epoch }
      : null;
  const [jump, setJump] = useState<Jump | null>(null);
  const [previewShown, togglePreview] = useDraftPreviewShown();
  const compact = useCompactLayout();
  const arrival = useRef<AbortController | null>(null);
  const defaultsField = useRef<HTMLTextAreaElement>(null);
  useEffect(() => () => arrival.current?.abort(), []);
  const anchoredEpoch = anchoredLore?.epoch;
  useEffect(() => {
    if (anchoredEpoch !== undefined) setJump(null);
  }, [anchoredEpoch]);
  const focusFor = (target: Section) =>
    jump?.section === target ? { index: jump.index, epoch: jump.epoch } : null;
  const loreFocus = focusFor('lore') ?? anchoredLore;
  const references = useContentReferences(native);
  const names = useCbsNames(references);
  const locate = cbsUseLocator(t, (target) =>
    available.includes(target as Section) ? t(contentSectionLabelKey(target as Section)) : target
  );
  function jumpTo(use: EditorJumpTarget) {
    const target = use.section as Section;
    if (!available.includes(target)) return;
    onSelect(target);
    if (use.item !== null && itemSections.includes(target))
      setJump({ section: target, index: use.item, epoch: --jumpEpoch });
    arrival.current?.abort();
    arrival.current = new AbortController();
    revealEditorTarget(
      () => document.getElementById(`${id}-${target}-panel`),
      use,
      '.native-item-detail, .nl-detail, .native-trigger-editor',
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
  function addDefault(name: string) {
    const current = string(
      standalone ? native.module?.defaultVariables : nativeRisuExtension(native).defaultVariables
    );
    const separator = current && !current.endsWith('\n') ? '\n' : '';
    const next = `${current}${separator}${name}=`;
    if (standalone) field('defaultVariables', next);
    else extension('defaultVariables', next);
    requestAnimationFrame(() => {
      const element = defaultsField.current;
      if (!element) return;
      element.focus();
      element.setSelectionRange(next.length, next.length);
    });
  }
  const anchoredSection = (target: ResourceAnchor) => {
    const wanted = anchorSection(target);
    return available.includes(wanted) ? wanted : 'basic';
  };
  const anchoredAuthoring = (target: ResourceAnchor) =>
    target.section !== 'lore' && isAuthoringPath(target.path ?? '');
  useAnchorArrival(
    anchor,
    (target) => {
      const section = anchoredSection(target);
      const panel = document.getElementById(`${id}-${section}-panel`);
      if (section === 'basic' && anchoredAuthoring(target))
        return panel?.querySelector('.native-authoring') ?? null;
      return section === 'lore' && target.index !== null
        ? (panel?.querySelector('.nl-detail') ?? null)
        : panel;
    },
    (target) => {
      onSelect(anchoredSection(target));
    }
  );
  const [part, setPart] = useState<SourcePart>('lore');
  const [draft, setDraft] = useBufferedEditorState<{
    part: SourcePart;
    text: string;
  } | null>('package.native.source', null);
  const [error, setError] = useState<UiMessage | null>(null);
  const [modulesDirty, setModulesDirty] = useState(false);
  const [regexDirty, setRegexDirty] = useState(false);
  const [triggersDirty, setTriggersDirty] = useState(false);
  const [portraitBusy, setPortraitBusy] = useState(false);
  const [assetsBusy, setAssetsBusy] = useState(false);
  useEffect(() => {
    onPortraitBusy(portraitBusy || assetsBusy);
  }, [portraitBusy, assetsBusy, onPortraitBusy]);
  useEffect(() => () => onPortraitBusy(false), [onPortraitBusy]);
  useUnappliedEditorField('package.native.source', !!draft);
  useEffect(() => {
    onDraftChange?.(!!draft || modulesDirty || regexDirty || triggersDirty);
  }, [draft, modulesDirty, regexDirty, triggersDirty, onDraftChange]);
  useEffect(() => () => onDraftChange?.(false), [onDraftChange]);
  const update = (input: RisuContentSource) => {
    onChange({
      ...value,
      title: string(standalone ? input.module?.name : input.card.name),
      nativeRisu: input,
      imageHandoff: detectRisuImageHandoff(input, value.imageHandoff),
    });
  };
  const field = (key: string, next: string) =>
    update({
      ...native,
      ...(standalone
        ? { module: { ...native.module, [key]: next } }
        : { card: { ...native.card, [key]: next } }),
    });
  const extension = (key: string, next: string) =>
    update({
      ...native,
      card: {
        ...native.card,
        extensions: {
          ...object(native.card.extensions),
          risuai: { ...nativeRisuExtension(native), [key]: next },
        },
      },
    });
  const lore = nativeRisuLore(native);
  const regex =
    (native.module ? native.module.regex : nativeRisuExtension(native).customScripts) ?? [];
  const writeRegex = (entries: unknown[]) =>
    update({
      ...native,
      ...(native.module
        ? { module: { ...native.module, regex: entries } }
        : {
            card: {
              ...native.card,
              extensions: {
                ...object(native.card.extensions),
                risuai: { ...nativeRisuExtension(native), customScripts: entries },
              },
            },
          }),
    });
  const moduleLore = native.module?.lorebook != null || standalone;
  const triggers = native.module
    ? native.module.trigger
    : nativeRisuExtension(native).triggerscript;
  const writeTriggers = (entries: unknown[]) =>
    update({
      ...native,
      ...(native.module
        ? { module: { ...native.module, trigger: entries } }
        : {
            card: {
              ...native.card,
              extensions: {
                ...object(native.card.extensions),
                risuai: { ...nativeRisuExtension(native), triggerscript: entries },
              },
            },
          }),
    });
  const writeLore = (entries: Record<string, unknown>[]) =>
    update({
      ...native,
      ...(moduleLore
        ? { module: { ...native.module, lorebook: entries } }
        : {
            card: {
              ...native.card,
              character_book: { ...object(native.card.character_book), entries },
            },
          }),
    });
  const greetings = [
    string(native.card.first_mes),
    ...(Array.isArray(native.card.alternate_greetings)
      ? native.card.alternate_greetings.map(string)
      : []),
  ];
  const writeGreetings = (entries: string[]) =>
    update({
      ...native,
      card: { ...native.card, first_mes: entries[0] ?? '', alternate_greetings: entries.slice(1) },
    });
  const selectedPart = draft?.part ?? part;
  const source = {
    greetings: native.card.alternate_greetings ?? [],
    lore,
    regex: native.module
      ? (native.module.regex ?? [])
      : (nativeRisuExtension(native).customScripts ?? []),
    triggers: native.module
      ? (native.module.trigger ?? [])
      : (nativeRisuExtension(native).triggerscript ?? []),
    card: native.card,
    module: native.module ?? {},
  }[selectedPart];
  useEditorSavePreparation('package.native.source', (model) => {
    if (!draft) return model;
    if (!('package' in model)) throw new UiError(uiMessage('native.text_139e9c1c9b'));
    return resourceWithNativeSource(
      model,
      editNativeSource(model.package.nativeRisu!, draft.part, draft.text)
    );
  });
  const prepareEntries = (model: ResourceModel, part: 'regex' | 'triggers', entries: unknown[]) => {
    if (!('package' in model)) throw new UiError(uiMessage('native.text_139e9c1c9b'));
    return resourceWithNativeSource(
      model,
      editNativeSource(model.package.nativeRisu!, part, JSON.stringify(entries))
    );
  };
  function applyJson() {
    if (!draft) return;
    try {
      update(normalizeRisuContentSource(editNativeSource(native, draft.part, draft.text)));
      setDraft(null);
      setError(null);
    } catch (caught) {
      setError(toUiMessage(caught));
    }
  }
  const description = string(standalone ? native.module?.description : native.card.description);
  const creator = string(native.card.creator);
  const version = string(native.card.character_version);
  const rawEditor = section === 'source' && (
    <div className="native-source-editor">
      <p className="muted">
        {t('native.resourceCounts', {
          lore: lore.length,
          regex: nativeRisuRegex(native).length,
          triggers: nativeRisuTriggers(native).length,
        })}
      </p>
      <label>
        {t('native.text_7e041cadf6')}
        <select
          aria-label={t('native.text_405989e7a8')}
          value={selectedPart}
          disabled={!!draft}
          onChange={(e) => setPart(e.target.value as SourcePart)}
        >
          {!standalone && <option value="greetings">{t('native.text_1c7e81d795')}</option>}
          <option value="lore">{t('native.text_4abddc7d5e')}</option>
          <option value="regex">{t('native.text_fc7e4f6228')}</option>
          <option value="triggers">{t('native.text_5aa9d342d6')}</option>
          {!standalone && <option value="card">{t('native.text_c169575a0a')}</option>}
          {native.module && <option value="module">{t('native.text_1601efd40a')}</option>}
        </select>
      </label>
      <label>
        {t('native.text_2ccb4d60c2')}
        <textarea
          className="native-main-text"
          aria-label={t('native.text_086d9f609b')}
          rows={18}
          spellCheck={false}
          value={draft?.text ?? JSON.stringify(source, null, 2)}
          onChange={(e) => setDraft({ part: selectedPart, text: e.target.value })}
        />
      </label>
      <div className="form-actions">
        <button type="button" disabled={!draft} onClick={applyJson}>
          {t('native.text_5c02cb8d1c')}
        </button>
        <button
          type="button"
          className="ghost"
          disabled={!draft}
          onClick={() => {
            setDraft(null);
            setError(null);
          }}
        >
          {t('native.text_d688879ebd')}
        </button>
      </div>
    </div>
  );
  return (
    <CbsNamesContext.Provider value={names}>
      <div className="native-editor native-content-editor full">
        {draft && (
          <p className="native-editor-notice" role="status">
            {t('native.text_0b4d698c5c')}{' '}
            <button type="button" className="ghost" onClick={() => onSelect('source')}>
              {t('native.text_609d8be788')}
            </button>
          </p>
        )}
        {error && (
          <p className="error" role="alert">
            {formatUiMessage(error)}
          </p>
        )}
        <fieldset disabled={!!draft} className="native-panel-fields">
          <StudioPanel section="translation" className="native-section-body">
            <TranslationGuideEditor
              value={readTranslationGuide(standalone ? native.module! : native.card)}
              onChange={(guide) =>
                update({
                  ...native,
                  ...(standalone
                    ? { module: withTranslationGuide(native.module!, guide) }
                    : { card: withTranslationGuide(native.card, guide) }),
                })
              }
            />
          </StudioPanel>
          <StudioPanel section="appearances" className="native-section-body">
            <IllustrationAppearanceEditor
              key={value.id}
              images={value.images ?? []}
              value={readIllustrationAppearanceProfiles(standalone ? native.module! : native.card)}
              onChange={(profiles) =>
                update({
                  ...native,
                  ...(standalone
                    ? { module: withIllustrationAppearanceProfiles(native.module!, profiles) }
                    : { card: withIllustrationAppearanceProfiles(native.card, profiles) }),
                })
              }
            />
          </StudioPanel>
          <StudioPanel section="basic" className="native-section-body native-basic-body">
            <div className="native-overview">
              <div className="native-overview-main native-description-field">
                <label>
                  {standalone ? t('native.text_9e7348ca61') : t('native.text_08117feaa5')}
                  <CodeField
                    className="native-description"
                    name={codeFieldName('basic', null, 'description')}
                    aria-label={
                      standalone ? t('native.text_9e7348ca61') : t('native.text_08117feaa5')
                    }
                    aria-describedby={`${id}-description-count`}
                    value={description}
                    onChange={(next) => field('description', next)}
                  />
                </label>
                <small id={`${id}-description-count`} className="native-field-count">
                  {t('native.characterCount', { count: description.length })}
                </small>
              </div>
              <div className="native-overview-meta">
                <PackagePortraitEditor
                  value={value}
                  onChange={onChange}
                  onDirtyChange={setPortraitBusy}
                >
                  {overview}
                </PackagePortraitEditor>
                {!standalone && (
                  <section className="native-authoring" aria-labelledby={`${id}-authoring-heading`}>
                    <h3 id={`${id}-authoring-heading`}>{t('native.text_78def74816')}</h3>
                    <label>
                      {t('native.text_d9f63fc805')}
                      <textarea
                        aria-label={t('native.text_d9f63fc805')}
                        rows={4}
                        value={string(native.card.creator_notes)}
                        onChange={(e) => field('creator_notes', e.target.value)}
                      />
                    </label>
                    <label>
                      {t('native.text_59a4b7210d')}
                      <input value={creator} onChange={(e) => field('creator', e.target.value)} />
                    </label>
                    <label>
                      {t('native.text_f0da897630')}
                      <input
                        value={version}
                        onChange={(e) => field('character_version', e.target.value)}
                      />
                    </label>
                  </section>
                )}
              </div>
            </div>
          </StudioPanel>
          {!standalone && (
            <StudioPanel section="greetings" className="native-panes">
              <NativeCollectionEditor
                focus={focusFor('greetings')}
                label={t('native.text_be7723bd53')}
                items={greetings.map((message, i) => ({
                  title:
                    i === 0
                      ? t('native.text_104a1f537a')
                      : t('native.alternateMessage', { number: i }),
                  subtitle: message
                    ? markupPreview(message, 55) || t('native.markupOnlyPreview')
                    : undefined,
                }))}
                onAdd={() => writeGreetings([...greetings, ''])}
                onMove={(i, delta) => {
                  const next = [...greetings];
                  [next[i], next[i + delta]] = [next[i + delta], next[i]];
                  writeGreetings(next);
                }}
                onReorder={(from, to) => {
                  const next = [...greetings];
                  const [moved] = next.splice(from, 1);
                  next.splice(to, 0, moved);
                  writeGreetings(next);
                }}
                onRemove={(i) =>
                  writeGreetings(
                    greetings.length === 1 ? [''] : greetings.filter((_, n) => n !== i)
                  )
                }
                isEmpty={(i) => !greetings[i]?.trim()}
                actions={
                  <>
                    {saved && !compact && (
                      <IconButton
                        label={t('draftPreview.show')}
                        icon={DisplayIcon}
                        aria-pressed={previewShown}
                        onClick={togglePreview}
                      />
                    )}
                    <IconButton
                      label={t('native.monospaceText')}
                      icon={CodeIcon}
                      aria-pressed={greetingFont === 'mono'}
                      onClick={() => {
                        const next = greetingFont === 'mono' ? 'body' : 'mono';
                        setGreetingFont(next);
                        writePresentationSetting(GREETING_FONT_KEY, next);
                      }}
                    />
                  </>
                }
              >
                {(i) => {
                  const editor = (
                    <CodeField
                      className="native-main-text"
                      name={codeFieldName(
                        'greetings',
                        i,
                        i === 0 ? 'first_mes' : 'alternate_greetings'
                      )}
                      font={greetingFont}
                      aria-label={
                        i === 0 ? t('native.text_3a91359cae') : t('native.text_1c7e81d795')
                      }
                      value={greetings[i] ?? ''}
                      onChange={(next) =>
                        writeGreetings(greetings.map((message, n) => (n === i ? next : message)))
                      }
                    />
                  );
                  if (!saved || section !== 'greetings') return editor;
                  return (
                    <FirstMessageWorkspace
                      shown={previewShown}
                      field={editor}
                      preview={
                        <RisuDraftStartPreview
                          contentId={saved.id}
                          revision={saved.revision}
                          native={native}
                          text={greetings[i] ?? ''}
                          surfaceKey={`${saved.id}:greeting:${i}`}
                        />
                      }
                    />
                  );
                }}
              </NativeCollectionEditor>
            </StudioPanel>
          )}
          <StudioPanel section="lore" className="native-panes">
            <NativeRisuLoreEditor
              focus={loreFocus}
              entries={lore}
              moduleLore={moduleLore}
              onChange={writeLore}
              selectionControl={
                <label>
                  {t('native.text_1345bfd1e0')}
                  <select
                    value={value.loreActivation?.mode ?? 'model'}
                    onChange={(e) =>
                      onChange({
                        ...value,
                        loreActivation: {
                          ...value.loreActivation,
                          mode: e.target.value as 'model' | 'discoverable',
                        },
                      })
                    }
                  >
                    <option value="model">{t('native.text_d8aac6a860')}</option>
                    <option value="discoverable">{t('native.text_f314bfcb7c')}</option>
                  </select>
                </label>
              }
            />
          </StudioPanel>
          <StudioPanel section="assets" className="native-section-body">
            <NativeRisuAssetsEditor
              value={value}
              onChange={onChange}
              onBusyChange={setAssetsBusy}
            />
          </StudioPanel>
          {!standalone && (
            <StudioPanel section="instructions" className="native-section-body">
              <div className="native-form-stack">
                <label>
                  {t('native.text_2d2a2c8204')}
                  <CodeField
                    name={codeFieldName('instructions', null, 'post_history_instructions')}
                    aria-label={t('native.text_2d2a2c8204')}
                    rows={8}
                    value={string(native.card.post_history_instructions)}
                    onChange={(next) => field('post_history_instructions', next)}
                  />
                </label>
                <label>
                  {t('native.text_07b2960ad0')}
                  <CodeField
                    name={codeFieldName('instructions', null, 'mes_example')}
                    aria-label={t('native.text_07b2960ad0')}
                    rows={8}
                    value={string(native.card.mes_example)}
                    onChange={(next) => field('mes_example', next)}
                  />
                </label>
              </div>
            </StudioPanel>
          )}
          <StudioPanel section="variables" className="native-section-body">
            <div className="native-form-stack">
              <label>
                {t('native.text_0510e453e9')}
                <textarea
                  ref={defaultsField}
                  rows={8}
                  value={string(
                    standalone
                      ? native.module?.defaultVariables
                      : nativeRisuExtension(native).defaultVariables
                  )}
                  onChange={(e) =>
                    standalone
                      ? field('defaultVariables', e.target.value)
                      : extension('defaultVariables', e.target.value)
                  }
                />
              </label>
              <label>
                {t('native.text_4c6723bcdd')}
                <textarea
                  rows={8}
                  value={string(
                    standalone
                      ? native.module?.customModuleToggle
                      : nativeRisuExtension(native).toggles
                  )}
                  onChange={(e) =>
                    standalone
                      ? field('customModuleToggle', e.target.value)
                      : extension('toggles', e.target.value)
                  }
                />
              </label>
              <CbsReferenceList
                index={references}
                locate={locate}
                onJump={jumpTo}
                onAddDefault={addDefault}
              />
            </div>
          </StudioPanel>
          <StudioPanel section="display" className="native-section-body">
            <div className="native-form-stack">
              <label>
                {t('native.text_50262c6215')}
                <CodeField
                  language="html"
                  className="native-main-text"
                  name={codeFieldName(
                    'display',
                    null,
                    standalone ? 'backgroundEmbedding' : 'backgroundHTML'
                  )}
                  aria-label={t('native.text_50262c6215')}
                  spellCheck={false}
                  font="mono"
                  value={
                    standalone ? nativeRisuModuleBackground(native) : nativeRisuBackground(native)
                  }
                  onChange={(next) =>
                    standalone
                      ? field('backgroundEmbedding', next)
                      : extension('backgroundHTML', next)
                  }
                />
              </label>
              {value.imageHandoff && (
                <RisuImageHandoffFields
                  policy={value.imageHandoff}
                  selected={value.imageHandoff.ranges
                    .filter((range) => range.enabled)
                    .map((range) => range.id)}
                  onChange={(ids) =>
                    onChange({
                      ...value,
                      imageHandoff: {
                        ...value.imageHandoff!,
                        ranges: value.imageHandoff!.ranges.map((range) => ({
                          ...range,
                          enabled: ids.includes(range.id),
                        })),
                      },
                    })
                  }
                />
              )}
            </div>
          </StudioPanel>
          <StudioPanel section="modules" className="native-section-body">
            <PackageFeaturesEditor
              value={value}
              onChange={onChange}
              onDirtyChange={setModulesDirty}
            />
          </StudioPanel>
        </fieldset>
        <StudioPanel section="triggers" className="native-section-body">
          <NativeRisuTriggerEditor
            focus={focusFor('triggers')}
            value={Array.isArray(triggers) ? triggers : []}
            draftPath="package.native.triggers"
            onChange={writeTriggers}
            prepareSave={(model, entries) => prepareEntries(model, 'triggers', entries)}
            onPendingChange={setTriggersDirty}
            disabled={!!draft}
          />
        </StudioPanel>
        <StudioPanel section="regex" className="native-panes native-regex-panel">
          <NativeRisuRegexEditor
            focus={focusFor('regex')}
            value={Array.isArray(regex) ? regex : []}
            draftPath="package.native.regex"
            onChange={writeRegex}
            prepareSave={(model, entries) => prepareEntries(model, 'regex', entries)}
            onPendingChange={setRegexDirty}
            disabled={!!draft}
          />
        </StudioPanel>
        <StudioPanel section="source" className="native-section-body">
          <fieldset className="native-panel-fields" disabled={regexDirty || triggersDirty}>
            {rawEditor}
          </fieldset>
        </StudioPanel>
      </div>
    </CbsNamesContext.Provider>
  );
}
