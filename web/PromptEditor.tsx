import { ApiError } from './api.js';
import {
  useI18n,
  translateMessage,
  registerMessage,
  message as uiMessage,
  messageRef,
} from './i18n.js';
import { TransientNotice } from './TransientNotice.js';
import { promptControls } from '../core/risu-prompt.js';
import { DismissibleError } from './DismissibleError.js';
import { DeleteButton } from './DeleteButton.js';
import { ActionMenu } from './ActionMenu.js';
import { useEditorHeadingHeight } from './useEditorHeadingHeight.js';
import { CopyIcon, SaveIcon } from './ui-icons.js';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NativeRisuPresetEditor } from './NativeRisuPresetEditor.js';
import { RisuExportButton } from './RisuExportButton.js';
import type {
  ContentRef,
  Library,
  PromptPreset,
  PromptPresetSummary,
  PromptRole,
} from '../core/product.js';
import { DEFAULT_MAIN_PROMPT, DEFAULT_TRANSLATION_PROMPT } from '../core/prompts.js';
import { validateRisuPrompt, reconcilePromptValues } from '../core/risu-prompt.js';
import { AgentCollaborationEditor, agentCollaborationIssue } from './AgentCollaborationEditor.js';
import { createDefaultRisuPrompt } from '../core/prompt-defaults.js';
import {
  ResourceEditorProvider,
  ResourceEditorStatus,
  ResourceEditorActions,
  requestResourceConflictReview,
  useResourceEditor,
  useEditorSaveCommand,
} from './resource-editor.js';
import { editableResource, type PromptEditModel } from '../core/resource-editing.js';
import { ResourceEditorSession } from './resource-editor-session.js';
import './prompt-editor.css';

const labels: Record<PromptRole, string> = { main: '작문', translation: '번역' };
const defaults: Record<PromptRole, string> = {
  main: DEFAULT_MAIN_PROMPT,
  translation: DEFAULT_TRANSLATION_PROMPT,
};
const roles = ['main', 'translation'] as const;
const keyOf = (value: ContentRef) => `${value.id}@${value.revision}`;
type Props = {
  heading?: ReactNode;
  headingTrailing?: ReactNode;
  initialRole?: PromptRole;
  initialPreset?: PromptPreset | null;
  onSaved?: (preset: PromptPreset, created: boolean) => Promise<void>;
  library: Library;
  reload?: () => Promise<void>;
  onError: (message: string) => void;
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
            title: preset?.title ?? (preset === null ? '' : `${labels[role]} 사용자 프롬프트`),
            role,
            program: createDefaultRisuPrompt(defaults[role], role),
            values: {},
          },
  });
}

export function PromptEditor({
  heading,
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
  // Tabs retain session owners, never copies of their models or dirty flags.
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
  const editorHeading = useEditorHeadingHeight(state.ready);
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
  const [error, setError] = useState('');
  const [exportError, setExportError] = useState('');
  const [status, setStatus] = useState('');
  const presets = [
    ...new Map(
      [...(library.promptPresets ?? []), ...localPresets]
        .sort((a, b) => a.revision - b.revision)
        .map((item) => [item.id, item])
    ).values(),
  ];
  const dirty = [...cache.current.values()].some((session) => session.snapshot().dirty);
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
      void session.refresh().catch((cause) => setError((cause as Error).message));
  }, [session, library.promptPresets, localPresets]);
  const collaborationIssue =
    role === 'main'
      ? agentCollaborationIssue(model.program.collaboration, promptControls(model.program))
      : '';
  const edit = (
    action: Partial<PromptEditModel> | ((current: PromptEditModel) => PromptEditModel)
  ) => {
    setModel((current) =>
      typeof action === 'function' ? action(current) : { ...current, ...action }
    );
    setError('');
    setStatus('');
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
    setError('');
    setStatus('');
  }
  async function save(update: boolean) {
    if (busy || !state.ready || collaborationIssue || !model.title.trim() || (update && !base))
      return false;
    setError('');
    setStatus('');
    try {
      const previousKey = session.editorKey;
      const saveModel: PromptEditModel = {
        ...model,
        title: model.title.trim(),
        program: validateRisuPrompt(model.program),
      };
      const accepted = (await session.save(saveModel, { copy: !update && !!base }))
        .saved as PromptPreset;
      cache.current.delete(previousKey);
      cache.current.set(session.editorKey, session);
      setLocalPresets((current) => [
        ...current.filter((item) => item.id !== accepted.id),
        accepted,
      ]);
      setStatus(uiMessage('prompts.uiPromptSaved'));
      // Placement is a separate write; neither it nor a list read can undo this save.
      setPlacing(true);
      const warnings: (() => string)[] = [];
      try {
        await onSaved?.(accepted, !update);
      } catch (caught) {
        warnings.push(() =>
          t('prompts.savedPlacement', {
            error:
              caught instanceof ApiError
                ? caught.displayMessage
                : messageRef((caught as Error).message),
          })
        );
      }
      try {
        await reload?.();
      } catch (caught) {
        warnings.push(() =>
          t('prompts.savedReload', {
            error:
              caught instanceof ApiError
                ? caught.displayMessage
                : messageRef((caught as Error).message),
          })
        );
      }
      if (warnings.length) {
        const renderWarnings = () => warnings.map((render) => render()).join('\n');
        const warning = renderWarnings();
        registerMessage(warning, renderWarnings);
        setError(warning);
        onError(warning);
      }
      return !session.snapshot().dirty;
    } catch (caught) {
      requestResourceConflictReview(session);
      setError((caught as Error).message);
      return false;
    } finally {
      setPlacing(false);
    }
  }
  useEditorSaveCommand(session, () => {
    if ([...cache.current.values()].some((other) => other !== session && other.snapshot().dirty))
      throw new Error(uiMessage('prompts.uiOtherRolesOrPresetsHaveUnsavedDraftsContinueEditing'));
    return save(!!base);
  });
  if (!state.ready) return <ResourceEditorStatus value={shared} />;
  const saveActions = (
    <div className="prompt-save-actions">
      <div className="prompt-save-buttons">
        <button
          type="button"
          disabled={
            busy || !!collaborationIssue || !draft.title.trim() || (!!draft.base && !draft.dirty)
          }
          className="primary native-editor-save"
          onClick={() => void save(!!draft.base)}
        >
          <SaveIcon size={18} aria-hidden="true" /> <span>{t('prompts.uiSavePreset')}</span>
        </button>
        {draft.base && (
          <ActionMenu label={t('prompts.uiManagePrompts')} className="prompt-management-menu">
            <RisuExportButton
              kind="prompt-presets"
              id={draft.base.id}
              revision={draft.base.revision}
              title={draft.base.title}
              disabled={busy || draft.dirty || pendingTemplate}
              onError={setExportError}
            />
            {draft.base && (
              <button
                type="button"
                className="secondary"
                disabled={busy || !!collaborationIssue || !draft.title.trim()}
                onClick={() => void save(false)}
              >
                <CopyIcon size={18} aria-hidden="true" />
                {t('prompts.uiSaveACopy')}
              </button>
            )}
            {draft.base && (
              <DeleteButton
                path={`/prompt-presets/${encodeURIComponent(draft.base.id)}`}
                revision={draft.base.revision}
                title={draft.base.title}
                label={t('prompts.uiDeletePrompt')}
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
            )}
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
              setError('');
              setStatus('');
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
    <ResourceEditorProvider value={shared}>
      <section
        className="prompt-editor"
        data-testid="prompt-editor"
        aria-label={t('prompts.uiFullPromptEditor')}
      >
        <div ref={editorHeading} className="prompt-editor-heading">
          {heading ?? <h2>{draft.title || t('prompts.uiEditPrompt')}</h2>}
          <ResourceEditorActions value={shared} hideSyncError />
          {saveActions}
          {headingTrailing}
          <DismissibleError
            message={translateMessage(exportError)}
            onDismiss={() => setExportError('')}
          />
        </div>
        {initialPreset === undefined && (
          <p className="muted">{t('prompts.uiSaveTextMessageStructureAndOptionsAsASeparate')}</p>
        )}
        <fieldset className="prompt-editor-fields" disabled={busy}>
          <label className="prompt-title-field">
            {t('prompts.uiPromptNameRequired')}
            <input
              aria-label={t('prompts.uiPromptName')}
              required
              maxLength={160}
              value={draft.title}
              onChange={(event) => edit({ title: event.target.value })}
            />
          </label>
          {initialPreset === undefined && metadata}
          <fieldset className="prompt-composer-frame">
            <NativeRisuPresetEditor
              key={`${role}:${session.options.editorKey}`}
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
          </fieldset>
        </fieldset>
        {busy && (
          <p role="status" className="prompt-status">
            {t('prompts.uiProcessing')}
          </p>
        )}
        <TransientNotice message={busy ? '' : status} />
        {pendingTemplate && (
          <p className="muted">{t('prompts.uiSourceInputIsValidatedOnSaveErrorsAreShown')}</p>
        )}
        <DismissibleError
          message={error ? t('prompts.errorKept', { error: translateMessage(error) }) : ''}
          onDismiss={() => setError('')}
        />
      </section>
    </ResourceEditorProvider>
  );
}
