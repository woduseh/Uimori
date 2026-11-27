import { deletionEndpoints } from '#contracts';
import { t, useI18n } from './i18n.js';
import { UiError, uiMessage, type UiMessage } from './ui-message.js';
import { toUiMessage } from './api-errors.js';
import { TransientNotice } from './TransientNotice.js';
import { promptControls } from '../core/risu-prompt.js';
import { DismissibleError } from './DismissibleError.js';
import { DeleteButton } from './DeleteButton.js';
import { ActionMenu } from './ActionMenu.js';
import { EditorStudio, useStudioSection } from './EditorStudio.js';
import { presetChangeSection, presetChanges, presetSections } from './studio-sections.js';
import { EditorChanges, PreviousVersionAction, RestoredVersionNotice } from './EditorChanges.js';
import { changedValuePaths } from './editor-values.js';
import { useCodeFieldBases } from './change-review.js';
import { CodeFieldBaseContext } from './CodeField.js';
import type { EditorReveal } from './code-field-reveal.js';
import { CopyIcon } from './ui-icons.js';
import { SaveButton } from './SaveButton.js';
import { useShortcut } from './shortcuts.js';
import { useEffect, useId, useMemo, useRef, useState, type ReactNode, type Ref } from 'react';
import { NativeRisuPresetEditor, checkedPresetProgram } from './NativeRisuPresetEditor.js';
import { useResourceAnchor } from './resource-anchor.js';
import { RisuExportButton } from './RisuExportButton.js';
import type {
  ContentRef,
  Library,
  PromptPreset,
  PromptPresetSummary,
  PromptRole,
} from '../core/product.js';
import { DEFAULT_MAIN_PROMPT, DEFAULT_TRANSLATION_PROMPT } from '../core/prompts.js';
import { reconcilePromptValues } from '../core/risu-prompt.js';
import { AgentCollaborationEditor, agentCollaborationIssue } from './AgentCollaborationEditor.js';
import { createDefaultRisuPrompt } from '../core/prompt-defaults.js';
import {
  ResourceEditorProvider,
  ResourceEditorStatus,
  ResourceEditorActions,
  requestResourceConflictReview,
  useResourceEditor,
  useResourceEditorCommands,
  useEditorSaveCommand,
} from './resource-editor.js';
import { editableResource, type PromptEditModel } from '../core/resource-editing.js';
import { ResourceEditorSession } from './resource-editor-session.js';
import './prompt-editor.css';

const defaults: Record<PromptRole, string> = {
  main: DEFAULT_MAIN_PROMPT,
  translation: DEFAULT_TRANSLATION_PROMPT,
};
const roles = ['main', 'translation'] as const;
const keyOf = (value: ContentRef) => `${value.id}@${value.revision}`;
type Props = {
  heading?: ReactNode;
  headingRef?: Ref<HTMLHeadingElement>;
  headingTrailing?: ReactNode;
  initialRole?: PromptRole;
  initialPreset?: PromptPreset | null;
  onSaved?: (
    preset: PromptPreset,
    created: boolean,
    creationOrganizationRevision: number | null
  ) => Promise<boolean>;
  library: Library;
  reload?: () => Promise<void>;
  onError: (error: UiMessage | null) => void;
  onDirtyChange?: (dirty: boolean) => void;
};
function createSession(role: PromptRole, preset?: PromptPreset | PromptPresetSummary | null) {
  return new ResourceEditorSession({
    editorKey: preset
      ? `prompt-preset:${preset.id}`
      : `new:prompt-preset:${role}:${preset === null ? 'new' : 'builtin'}`,
    kind: 'prompt-preset',
    targetId: preset?.id ?? null,
    initialModel:
      preset && 'program' in preset
        ? editableResource('prompt-preset', preset)
        : {
            title: preset?.title ?? (preset === null ? '' : t('prompts.userPromptTitle', { role })),
            role,
            program: createDefaultRisuPrompt(defaults[role], role),
            values: {},
          },
  });
}

export function PromptEditor({
  heading,
  headingRef,
  headingTrailing,
  initialRole = 'main',
  initialPreset,
  onSaved,
  library,
  reload,
  onError,
  onDirtyChange,
}: Props) {
  const { t } = useI18n();
  const [role, setRole] = useState<PromptRole>(initialRole);
  const [localPresets, setLocalPresets] = useState<PromptPreset[]>([]);
  const [selectedSessions, setSelectedSessions] = useState<
    Record<PromptRole, ResourceEditorSession>
  >(
    () =>
      Object.fromEntries(
        roles.map((role) => [
          role,
          createSession(role, role === initialRole ? initialPreset : undefined),
        ])
      ) as Record<PromptRole, ResourceEditorSession>
  );
  const cache = useRef(
    new Map(Object.values(selectedSessions).map((session) => [session.editorKey, session]))
  );
  const session = selectedSessions[role];
  const shared = useResourceEditor<PromptEditModel>(session);
  const { model, state, setModel } = shared;
  const commands = useResourceEditorCommands(shared);
  const sectionId = useId();
  const sections = presetSections(model.program, role === 'main');
  const changedPaths = useMemo(
    () => (state.dirty ? changedValuePaths(state.document.baseModel, model) : []),
    [state.dirty, state.document.baseModel, model]
  );
  const changes = state.dirty
    ? presetChanges(sections, changedPaths, [
        ...Object.keys(state.local.rawFields),
        ...state.local.unappliedFields,
      ])
    : [];
  const [section, selectSection] = useStudioSection(
    'prompt',
    sections.map((item) => item.id),
    'blocks',
    !!initialPreset
  );
  const sectionOf = presetChangeSection(sections);
  const codeBases = useCodeFieldBases(state.document.baseModel, model, state.dirty, sectionOf);
  const [reveal, setReveal] = useState<EditorReveal | null>(null);
  const revealEpoch = useRef(0);
  const anchor = useResourceAnchor('prompt-preset', state.document.targetId);
  const base: PromptPreset | null = state.document.targetId
    ? {
        ...(state.document.baseModel as PromptEditModel),
        id: state.document.targetId,
        revision: state.document.baseRevision!,
      }
    : null;
  const draft = {
    ...model,
    base,
    source: base ? keyOf(base) : session.options.editorKey.split(':').at(-1)!,
    dirty: state.dirty,
  };
  const [placing, setPlacing] = useState(false);
  const busy = state.saving || placing;
  const pendingTemplate = state.local.unappliedFields.length > 0;
  const [collaborationExpanded, setCollaborationExpanded] = useState(true);
  const [error, setError] = useState<UiMessage | null>(null);
  const [exportError, setExportError] = useState<UiMessage | null>(null);
  const [status, setStatus] = useState<UiMessage | null>(null);
  const presets = [
    ...new Map(
      [...(library.promptPresets ?? []), ...localPresets]
        .sort((a, b) => a.revision - b.revision)
        .map((item) => [item.id, item])
    ).values(),
  ];
  const dirty = [...cache.current.values()].some((session) => {
    const state = session.snapshot();
    return state.dirty || state.creationPending;
  });
  useEffect(() => {
    onDirtyChange?.(dirty || busy);
  }, [dirty, busy, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  useEffect(() => {
    const document = session.snapshot().document;
    const latest = [...(library.promptPresets ?? []), ...localPresets].find(
      (item) => item.id === document.targetId && item.revision > (document.baseRevision ?? 0)
    );
    if (latest && document.baseRevision !== null)
      void session.refresh().catch((cause) => setError(toUiMessage(cause)));
  }, [session, library.promptPresets, localPresets]);
  const collaborationIssue =
    role === 'main'
      ? agentCollaborationIssue(model.program.collaboration, promptControls(model.program))
      : null;
  const edit = (
    action: Partial<PromptEditModel> | ((current: PromptEditModel) => PromptEditModel)
  ) => {
    setModel((current) =>
      typeof action === 'function' ? action(current) : { ...current, ...action }
    );
    setError(null);
    setStatus(null);
  };
  function choose(source: string) {
    if (pendingTemplate || busy) return;
    const preset = presets.find((item) => item.role === role && keyOf(item) === source);
    const key = preset ? `prompt-preset:${preset.id}` : `new:prompt-preset:${role}:${source}`;
    let next = cache.current.get(key);
    if (!next) {
      next = createSession(role, source === 'new' ? null : preset);
      cache.current.set(next.editorKey, next);
    }
    setSelectedSessions((current) => ({ ...current, [role]: next }));
    setError(null);
    setStatus(null);
  }
  async function save(update: boolean) {
    if (
      busy ||
      !state.ready ||
      (!state.creationPending && (collaborationIssue || !model.title.trim() || (update && !base)))
    )
      return false;
    setError(null);
    setStatus(null);
    try {
      const previousKey = session.editorKey;
      const result = state.creationPending
        ? await session.save()
        : await session.save(
            {
              ...model,
              title: model.title.trim(),
              program: checkedPresetProgram(model.program),
            } satisfies PromptEditModel,
            { copy: !update && !!base }
          );
      const accepted = result.saved as PromptPreset;
      cache.current.delete(previousKey);
      cache.current.set(session.editorKey, session);
      setLocalPresets((current) => [
        ...current.filter((item) => item.id !== accepted.id),
        accepted,
      ]);
      setStatus(uiMessage('prompts.uiPromptSaved'));
      setPlacing(true);
      const warnings: UiMessage[] = [];
      try {
        const placed = await onSaved?.(
          accepted,
          result.creationIntent,
          result.creationOrganizationRevision ?? null
        );
        if (placed === false) warnings.push(uiMessage('prompts.savedPlacement', { error: '' }));
      } catch (caught) {
        warnings.push(uiMessage('prompts.savedPlacement', { error: toUiMessage(caught) }));
      }
      try {
        await reload?.();
      } catch (caught) {
        warnings.push(uiMessage('prompts.savedReload', { error: toUiMessage(caught) }));
      }
      if (warnings.length) {
        const warning =
          warnings.length === 1
            ? warnings[0]
            : uiMessage('library.cloneWarnings', { first: warnings[0], second: warnings[1] });
        setError(warning);
        onError(warning);
      }
      return !session.snapshot().dirty;
    } catch (caught) {
      requestResourceConflictReview(session);
      setError(toUiMessage(caught));
      return false;
    } finally {
      setPlacing(false);
    }
  }
  const saveButton = useRef<HTMLButtonElement>(null);
  const titleField = useRef<HTMLInputElement>(null);
  const titleErrorId = useId();
  const [titleTouched, setTitleTouched] = useState(false);
  const titleMissing = !state.creationPending && !draft.title.trim();
  const titleError = titleMissing && titleTouched;
  const editorRoot = useRef<HTMLElement>(null);
  const requestTitle = () => {
    setTitleTouched(true);
    titleField.current?.focus();
  };
  useShortcut('editor.save', requestTitle, { scope: editorRoot, active: titleMissing });
  useEditorSaveCommand(session, () => {
    if (titleMissing) {
      requestTitle();
      return Promise.resolve(false);
    }
    if (
      [...cache.current.values()].some(
        (other) => other !== session && (other.snapshot().dirty || other.snapshot().creationPending)
      )
    )
      throw new UiError(uiMessage('prompts.uiOtherRolesOrPresetsHaveUnsavedDraftsContinueEditing'));
    return save(!!base);
  });
  if (!state.ready) return <ResourceEditorStatus value={shared} />;
  const saveActions = (
    <div className="prompt-save-actions">
      <div className="prompt-save-buttons">
        <SaveButton
          ref={saveButton}
          type="button"
          label={t(state.creationPending ? 'main.m130' : 'prompts.uiSavePreset')}
          text={state.creationPending ? t('main.m130') : undefined}
          aria-busy={busy}
          disabled={
            busy ||
            (!state.creationPending &&
              (!!collaborationIssue || !draft.title.trim() || (!!draft.base && !draft.dirty)))
          }
          className="primary native-editor-save"
          onClick={() => void save(!!draft.base)}
        />
        {draft.base && (
          <ActionMenu label={t('prompts.uiManagePrompts')} className="prompt-management-menu">
            <PreviousVersionAction
              commands={commands}
              subject={draft.title}
              sections={(paths) => presetChanges(sections, paths)}
              sectionOf={sectionOf}
            />
            <div className="action-menu-group">
              <button
                type="button"
                className="secondary"
                disabled={
                  busy || state.creationPending || !!collaborationIssue || !draft.title.trim()
                }
                onClick={() => void save(false)}
              >
                <CopyIcon size={18} aria-hidden="true" />
                {t('prompts.uiSaveACopy')}
              </button>
              <RisuExportButton
                kind="prompt-presets"
                id={draft.base.id}
                revision={draft.base.revision}
                title={draft.base.title}
                disabled={busy || draft.dirty || pendingTemplate}
                onError={setExportError}
              />
            </div>
            <div className="action-menu-group">
              <DeleteButton
                endpoint={deletionEndpoints.deletePromptPreset}
                params={{ id: draft.base.id }}
                revision={draft.base.revision}
                title={draft.base.title}
                label={uiMessage('prompts.uiDeletePrompt')}
                disabled={busy}
                onError={onError}
                onDeleted={async () => {
                  const removed = draft.base!.id;
                  setLocalPresets((current) => current.filter((item) => item.id !== removed));
                  for (const [key, cached] of cache.current) {
                    if (cached.snapshot().document.targetId === removed) cache.current.delete(key);
                  }
                  setSelectedSessions(
                    (current) =>
                      Object.fromEntries(
                        roles.map((role) => {
                          if (current[role].snapshot().document.targetId !== removed)
                            return [role, current[role]];
                          const next = createSession(role);
                          cache.current.set(next.editorKey, next);
                          return [role, next];
                        })
                      ) as Record<PromptRole, ResourceEditorSession>
                  );
                  await reload?.();
                  setStatus(uiMessage('prompts.uiPromptDeleted'));
                }}
              />
            </div>
          </ActionMenu>
        )}
      </div>
    </div>
  );
  const metadata = (
    <div className="prompt-metadata-fields">
      <div className="prompt-editor-row">
        <label>
          {t('prompts.uiRole')}
          <select
            aria-label={t('prompts.uiPromptRole')}
            disabled={busy || pendingTemplate || !!initialPreset}
            value={role}
            onChange={(event) => {
              setRole(event.target.value as PromptRole);
              setError(null);
              setStatus(null);
            }}
          >
            <option value="main">{t('prompts.uiWriting')}</option>
            <option value="translation">{t('prompts.uiTranslation')}</option>
          </select>
        </label>
        {initialPreset === undefined && (
          <label>
            {t('prompts.uiPromptToLoad')}
            <select
              aria-label={t('prompts.uiPromptToLoad')}
              disabled={busy || pendingTemplate}
              value={draft.source === 'builtin' || draft.source === 'new' ? '' : draft.source}
              onChange={(event) => choose(event.target.value)}
            >
              <option value="" disabled>
                {t('prompts.uiSelectASavedPrompt')}
              </option>
              {presets
                .filter((item) => item.role === role)
                .map((item) => (
                  <option key={keyOf(item)} value={keyOf(item)}>
                    {item.title}
                  </option>
                ))}
              {draft.base && !presets.some((item) => keyOf(item) === draft.source) && (
                <option value={draft.source}>
                  {t('prompts.editingNamed', { name: draft.title })}
                </option>
              )}
            </select>
          </label>
        )}
        {initialPreset === undefined && (
          <button
            type="button"
            className="secondary"
            disabled={busy || pendingTemplate}
            onClick={() => choose('new')}
          >
            {t('prompts.uiCreatePrompt')}
          </button>
        )}
      </div>
    </div>
  );
  return (
    <ResourceEditorProvider value={shared} saveButton={saveButton}>
      <section
        ref={editorRoot}
        className="prompt-editor"
        data-testid="prompt-editor"
        aria-label={t('prompts.uiFullPromptEditor')}
      >
        <EditorStudio
          label={t('native.text_a8a8b42c1a')}
          sections={sections}
          changed={changes}
          value={section}
          onSelect={selectSection}
          idPrefix={sectionId}
          header={
            <div className="prompt-editor-heading">
              {heading}
              <div className="editor-title">
                <h2 ref={headingRef} tabIndex={-1} className="editor-title-field">
                  <input
                    ref={titleField}
                    aria-label={t('prompts.uiPromptName')}
                    aria-invalid={titleError || undefined}
                    aria-describedby={titleError ? titleErrorId : undefined}
                    placeholder={t('prompts.uiPromptName')}
                    required
                    maxLength={160}
                    disabled={busy}
                    value={draft.title}
                    onChange={(event) => {
                      setTitleTouched(true);
                      edit({ title: event.target.value });
                    }}
                  />
                </h2>
                {titleError && (
                  <small id={titleErrorId} className="editor-title-error" role="alert">
                    {t('library.nameRequired')}
                  </small>
                )}
              </div>
              <ResourceEditorActions
                value={shared}
                commands={commands}
                hideSyncError
                changes={
                  <EditorChanges
                    commands={commands}
                    changes={changes}
                    current={model}
                    subject={draft.title}
                    sectionOf={sectionOf}
                    save={{
                      run: () => {
                        if (titleMissing) {
                          setTitleTouched(true);
                          return Promise.resolve(false);
                        }
                        return save(!!draft.base);
                      },
                      label: t('prompts.uiSavePreset'),
                      disabled: busy || state.creationPending || !!collaborationIssue,
                      error: titleMissing ? uiMessage('library.nameRequired') : error,
                    }}
                    onReveal={(target) => {
                      selectSection(target.section);
                      setReveal({
                        section: target.section,
                        item: target.item,
                        field: target.field,
                        range: { from: target.offset ?? 0, to: target.offset ?? 0 },
                        epoch: ++revealEpoch.current,
                      });
                    }}
                  />
                }
              />
              {saveActions}
              {headingTrailing}
            </div>
          }
          notice={
            <>
              <RestoredVersionNotice commands={commands} />
              <DismissibleError error={exportError} onDismiss={() => setExportError(null)} />
            </>
          }
        >
          <fieldset className="prompt-editor-fields" disabled={busy}>
            {initialPreset === undefined && metadata}
            <fieldset className="prompt-composer-frame">
              <CodeFieldBaseContext value={codeBases}>
                <NativeRisuPresetEditor
                  key={`${role}:${session.options.editorKey}`}
                  reveal={reveal}
                  anchor={anchor}
                  onSelect={selectSection}
                  idPrefix={sectionId}
                  program={draft.program}
                  metadata={initialPreset !== undefined ? metadata : undefined}
                  values={model.values}
                  onValuesChange={(values) => edit({ values })}
                  onChange={(program) =>
                    edit((current) => ({
                      ...current,
                      program,
                      values: reconcilePromptValues(program, current.values).values,
                    }))
                  }
                  collaboration={
                    role === 'main' ? (
                      <AgentCollaborationEditor
                        expanded={collaborationExpanded}
                        onExpandedChange={setCollaborationExpanded}
                        value={draft.program.collaboration}
                        controls={promptControls(draft.program)}
                        models={library.models}
                        onChange={(collaboration) =>
                          edit((current) => ({
                            ...current,
                            program: { ...current.program, collaboration },
                          }))
                        }
                      />
                    ) : undefined
                  }
                />
              </CodeFieldBaseContext>
            </fieldset>
          </fieldset>
          <TransientNotice content={busy ? null : status} />
          <DismissibleError error={error} onDismiss={() => setError(null)} />
        </EditorStudio>
      </section>
    </ResourceEditorProvider>
  );
}
