import { IllustrationAppearanceEditor } from './IllustrationAppearanceEditor.js';
import {
  readIllustrationAppearanceProfiles,
  withIllustrationAppearanceProfiles,
} from '../core/illustration-profiles.js';
import { useI18n, translateMessage } from './i18n.js';
import { TranslationGuideEditor } from './TranslationGuideEditor.js';
import { readTranslationGuide, withTranslationGuide } from '../core/translation-guide.js';
import { editNativeSource, resourceWithNativeSource } from './native-source-edit.js';
import type { ResourceModel } from '../core/resource-editing.js';
import { useEffect, useState } from 'react';
import {
  useAnchorArrival,
  type ResourceAnchor,
  type ResourceAnchorRequest,
} from './resource-anchor.js';
import type { RisuContent } from '../core/risu-content.js';
import { detectRisuImageHandoff } from '../core/risu-image-handoff.js';
import {
  nativeRisuBackground,
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
import { CodeIcon } from './ui-icons.js';
import { readPresentationChoice, writePresentationSetting } from './presentation-settings.js';
import { markupPreview } from './markup-preview.js';
import {
  availableSections,
  contentSection,
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
}: {
  value: RisuContent;
  onChange: (value: RisuContent) => void;
  onDraftChange?: (dirty: boolean) => void;
  onPortraitBusy: (busy: boolean) => void;
  anchor?: ResourceAnchorRequest | null;
  section: Section;
  onSelect: (section: Section) => void;
  idPrefix: string;
}) {
  const { t } = useI18n();

  const native = value.nativeRisu;
  const standalone = isStandaloneModule(value);
  const available = availableSections(contentSectionRegistry, value);
  const [greetingFont, setGreetingFont] = useState(() =>
    readPresentationChoice(GREETING_FONT_KEY, GREETING_FONTS, 'body')
  );
  const [authoringOpen, setAuthoringOpen] = useState(false);
  const requested = anchor?.anchor ?? null;
  const loreFocus =
    requested && anchorSection(requested) === 'lore' && requested.index !== null
      ? { index: requested.index, epoch: requested.epoch }
      : null;
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
      if (anchoredAuthoring(target)) setAuthoringOpen(true);
    }
  );
  const [part, setPart] = useState<SourcePart>('lore');
  const [draft, setDraft] = useBufferedEditorState<{ part: SourcePart; text: string } | null>(
    'package.native.source',
    null
  );
  const [error, setError] = useState('');
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
    if (!('package' in model)) throw new Error('콘텐츠 원문을 확인해 주세요.');
    return resourceWithNativeSource(
      model,
      editNativeSource(model.package.nativeRisu!, draft.part, draft.text)
    );
  });
  const prepareEntries = (model: ResourceModel, part: 'regex' | 'triggers', entries: unknown[]) => {
    if (!('package' in model)) throw new Error('콘텐츠 원문을 확인해 주세요.');
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
      setError('');
    } catch (caught) {
      setError((caught as Error).message);
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
            setError('');
          }}
        >
          {t('native.text_d688879ebd')}
        </button>
      </div>
    </div>
  );
  return (
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
          {translateMessage(error)}
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
          <PackagePortraitEditor value={value} onChange={onChange} onDirtyChange={setPortraitBusy}>
            <label>
              {t('native.text_9aa18e5071')}
              <input
                aria-label={t('native.text_d63d79b1e2')}
                value={string(standalone ? native.module?.name : native.card.name)}
                maxLength={200}
                onChange={(e) => field('name', e.target.value)}
              />
            </label>
            {!standalone && (creator || version) && (
              <p className="native-identity-meta ui-meta-row">
                {creator && <span>{t('native.creatorSummary', { creator })}</span>}
                {version && <span>{t('native.versionSummary', { version })}</span>}
              </p>
            )}
          </PackagePortraitEditor>
          <div className="native-description-field">
            <label>
              {standalone ? t('native.text_9e7348ca61') : t('native.text_08117feaa5')}
              <textarea
                className="native-description"
                aria-label={standalone ? t('native.text_9e7348ca61') : t('native.text_08117feaa5')}
                aria-describedby={`${id}-description-count`}
                rows={12}
                value={description}
                onChange={(e) => field('description', e.target.value)}
              />
            </label>
            <small id={`${id}-description-count`} className="native-field-count">
              {t('native.characterCount', { count: description.length })}
            </small>
          </div>
          {!standalone && (
            <details
              className="native-advanced native-authoring"
              open={authoringOpen}
              onToggle={(event) => setAuthoringOpen(event.currentTarget.open)}
            >
              <summary>{t('native.text_78def74816')}</summary>
              <div className="native-form-stack">
                <label>
                  {t('native.text_d9f63fc805')}
                  <textarea
                    aria-label={t('native.text_d9f63fc805')}
                    rows={4}
                    value={string(native.card.creator_notes)}
                    onChange={(e) => field('creator_notes', e.target.value)}
                  />
                </label>
                <div className="native-field-row">
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
                </div>
              </div>
            </details>
          )}
        </StudioPanel>
        {!standalone && (
          <StudioPanel section="greetings" className="native-panes">
            <NativeCollectionEditor
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
                writeGreetings(greetings.length === 1 ? [''] : greetings.filter((_, n) => n !== i))
              }
              isEmpty={(i) => !greetings[i]?.trim()}
              actions={
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
              }
            >
              {(i) => (
                <textarea
                  className="native-main-text"
                  data-font={greetingFont}
                  aria-label={i === 0 ? t('native.text_3a91359cae') : t('native.text_1c7e81d795')}
                  rows={18}
                  value={greetings[i]}
                  onChange={(e) =>
                    writeGreetings(
                      greetings.map((message, n) => (n === i ? e.target.value : message))
                    )
                  }
                />
              )}
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
          <NativeRisuAssetsEditor value={value} onChange={onChange} onBusyChange={setAssetsBusy} />
        </StudioPanel>
        {!standalone && (
          <StudioPanel section="instructions" className="native-section-body">
            <div className="native-form-stack">
              <label>
                {t('native.text_2d2a2c8204')}
                <textarea
                  rows={8}
                  value={string(native.card.post_history_instructions)}
                  onChange={(e) => field('post_history_instructions', e.target.value)}
                />
              </label>
              <label>
                {t('native.text_07b2960ad0')}
                <textarea
                  aria-label={t('native.text_07b2960ad0')}
                  rows={8}
                  value={string(native.card.mes_example)}
                  onChange={(e) => field('mes_example', e.target.value)}
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
          </div>
        </StudioPanel>
        {available.includes('display') && (
          <StudioPanel section="display" className="native-section-body">
            <div className="native-form-stack">
              {!standalone && (
                <label>
                  {t('native.text_50262c6215')}
                  <textarea
                    rows={12}
                    className="native-main-text"
                    spellCheck={false}
                    value={nativeRisuBackground(native)}
                    onChange={(e) => extension('backgroundHTML', e.target.value)}
                  />
                </label>
              )}
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
        )}
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
          value={Array.isArray(triggers) ? triggers : []}
          draftPath="package.native.triggers"
          onChange={writeTriggers}
          prepareSave={(model, entries) => prepareEntries(model, 'triggers', entries)}
          onPendingChange={setTriggersDirty}
          disabled={!!draft}
        />
      </StudioPanel>
      <StudioPanel section="regex" className="native-section-body native-regex-panel">
        <NativeRisuRegexEditor
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
  );
}
