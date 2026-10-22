import {
  t,
  useI18n,
  translateMessage,
  formatNumber,
  messageRef,
  message as uiMessage,
} from './i18n.js';
import { TransientNotice } from './TransientNotice.js';
import { NoticeBanner } from './NoticeBanner.js';
import { ProviderConnectionForm } from './ProviderConnectionForm.js';
import { ProviderModelForm } from './ProviderModelForm.js';
import {
  initialProviderEditorState,
  providerEditorReducer,
  initialConnection,
  connectionDraft,
  connectionPayload,
  type ConnectionDraft,
} from './provider-editor-state.js';
import { compareModelDisplayOrder } from '../core/model-order.js';
import { useSettingsSaveHandler, type SettingsSaveRegistration } from './useSettingsSaveHandler.js';
import {
  JEV_PROVIDER_DEFINITION,
  jevRegistered,
  type JevProviderStatus,
} from '../core/jev-provider.js';
import { DraftDiscardActions } from './DraftDiscardActions.js';
import { Dialog } from './Dialog.js';
import { SaveConflictDialog } from './SaveConflictDialog.js';
import {
  useEffect,
  useRef,
  useState,
  useReducer,
  type SetStateAction,
  type DragEvent,
  type KeyboardEvent,
} from 'react';
import { ActionMenu } from './ActionMenu.js';
import { IconButton } from './IconButton.js';
import {
  AddIcon,
  BackIcon,
  ConnectionIcon,
  CopyIcon,
  ForwardIcon,
  ModelIcon,
  MoveIcon,
  PowerIcon,
  RefreshIcon,
  SearchIcon,
} from './ui-icons.js';
import type {
  Connection,
  Library,
  ModelPreset,
  ProviderProtocol,
  VertexRequestTier,
} from '../core/product.js';
import { PROVIDER_CHOICES, providerDefinition } from '../core/provider-definitions.js';
import { api, ApiError } from './api.js';
import {
  initialModel,
  modelDraft,
  modelDraftError,
  modelPayload,
  selectModelConnection,
  type ModelDraft,
} from './provider-model-draft.js';
import { DeleteButton } from './DeleteButton.js';
import { ProviderModelTest, useProviderModelTests } from './ProviderModelTest.js';
import { JevProviderSettings } from './JevProviderSettings.js';
import { useTestMode } from './useTestMode.js';
import './ProviderManagement.css';
import './settings-actions.css';

const versionRef = (item: { id: string; revision: number }) => `${item.id}@${item.revision}`;
const matches = (query: string, ...values: (string | undefined)[]) =>
  !query || values.some((value) => value?.toLocaleLowerCase().includes(query));

export function ConnectionEditor({
  library,
  reload,
  onError,
  onDirtyChange,
  onSaveHandlerChange,
  modelToEdit,
  onModelEditHandled,
}: {
  library: Library;
  reload: () => Promise<void>;
  onError: (error: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
  onSaveHandlerChange?: SettingsSaveRegistration;
  modelToEdit?: string | null;
  onModelEditHandled?: () => void;
}) {
  useI18n();
  const testMode = useTestMode();
  const modelTests = useProviderModelTests();
  const [forcedVertexTier, setForcedVertexTier] = useState<VertexRequestTier>();
  useEffect(() => {
    let current = true;
    void api<{ vertexRequestTier: VertexRequestTier | null }>('/health')
      .then((health) => {
        if (current && ['standard', 'flex'].includes(health.vertexRequestTier ?? ''))
          setForcedVertexTier(health.vertexRequestTier!);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, []);
  const [query, setQuery] = useState('');
  const [jevPosition, setJevPosition] = useState(() => {
    try {
      return Math.max(0, Number(localStorage.getItem('uimori-jev-display-position')) || 0);
    } catch {
      return 0;
    }
  });
  const dragged = useRef<{ kind: 'connection' | 'model'; id: string } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [movingDisplay, setMovingDisplay] = useState<{
    kind: 'connection' | 'model';
    id: string;
  } | null>(null);
  const [moveTarget, setMoveTarget] = useState('');
  const [movePosition, setMovePosition] = useState<'before' | 'after'>('before');
  const [screen, setScreen] = useState<
    'models' | 'connections' | 'providers' | 'connection' | 'model' | 'jev'
  >('models');
  const [setup, setSetup] = useState(false);
  const [modelSection, setModelSection] = useState<'basic' | 'advanced'>('basic');
  const [expandedModelGroups, setExpandedModelGroups] = useState<Set<string>>(() => new Set());
  const heading = useRef<HTMLDivElement>(null);
  const returnItem = useRef<{ screen: 'models' | 'connections'; id: string } | undefined>(
    undefined
  );
  function navigate(next: typeof screen) {
    setDiscard(undefined);
    setScreen(next);
    requestAnimationFrame(() => {
      const selected = returnItem.current;
      const target =
        selected?.screen === next
          ? heading.current
              ?.closest('section')
              ?.querySelector<HTMLButtonElement>(
                `button[data-provider-id="${CSS.escape(selected.id)}"]`
              )
          : undefined;
      if (target?.checkVisibility()) {
        target.scrollIntoView({ block: 'nearest' });
        target.focus({ preventScroll: true });
        return;
      }
      heading.current?.scrollIntoView({ block: 'start' });
      heading.current?.focus({ preventScroll: true });
    });
  }

  const [drafts, dispatchDraft] = useReducer(
    providerEditorReducer,
    undefined,
    initialProviderEditorState
  );
  const {
    value: connection,
    editing: editingConnection,
    baseline: connectionBaseline,
    started: connectionStarted,
  } = drafts.connection;
  const {
    value: model,
    editing: editingModel,
    baseline: modelBaseline,
    started: modelStarted,
  } = drafts.model;
  const setConnection = (update: SetStateAction<ConnectionDraft>) =>
    dispatchDraft({ type: 'connection.change', update });
  const setModel = (update: SetStateAction<ModelDraft>) =>
    dispatchDraft({ type: 'model.change', update });
  const conflict = drafts.conflict;
  const setConflict = (kind: typeof conflict) => dispatchDraft({ type: 'conflict', kind });
  const [discard, setDiscard] = useState<{ kind: 'connection' | 'model'; proceed: () => void }>();
  const [saveConflict, setSaveConflict] = useState<'connection' | 'model' | null>(null);
  function replaceDraft(kind: 'connection' | 'model', proceed: () => void) {
    const dirty =
      kind === 'connection'
        ? connectionStarted && JSON.stringify(connection) !== connectionBaseline
        : modelStarted && JSON.stringify(model) !== modelBaseline;
    if (dirty) setDiscard({ kind, proceed });
    else proceed();
  }
  const [uploadingCredential, setUploadingCredential] = useState(false);
  const [jevStatus, setJevStatus] = useState<JevProviderStatus | null>(null);
  const [jevListError, setJevListError] = useState(false);
  const [jevReturn, setJevReturn] = useState<'models' | 'connections'>('connections');
  const [jevListRefresh, setJevListRefresh] = useState(0);
  useEffect(() => {
    void jevListRefresh;
    const controller = new AbortController();
    void api<JevProviderStatus>('/provider-management/jev', undefined, 'GET', controller.signal)
      .then((status) => {
        if (!controller.signal.aborted) {
          setJevStatus(status);
          setJevListError(false);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setJevListError(true);
      });
    return () => controller.abort();
  }, [jevListRefresh]);
  const hasJev = jevRegistered(jevStatus);
  function openJev(from: 'models' | 'connections' = 'connections') {
    setJevReturn(from);
    navigate('jev');
  }
  const [jevDirty, setJevDirty] = useState(false);
  const [jevBusy, setJevBusy] = useState(false);
  const [operation, setOperation] = useState<'model-save' | 'other' | null>(null),
    [message, setMessage] = useState(''),
    [refreshWarning, setRefreshWarning] = useState(''),
    [error, setError] = useState('');
  const operationBusy = operation !== null;
  const busy = operationBusy || uploadingCredential || jevBusy;
  const dirty =
    busy ||
    jevDirty ||
    (connectionStarted && JSON.stringify(connection) !== connectionBaseline) ||
    (modelStarted && JSON.stringify(model) !== modelBaseline);
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  const operationLock = useRef(false);
  const jevSave = useRef<(() => Promise<boolean>) | null>(null);
  const connectionForm = useRef<HTMLFormElement>(null);
  const modelForm = useRef<HTMLFormElement>(null);
  const chosen = library.connections.find((item) => item.id === model.connectionRef);
  const filter = query.trim().toLocaleLowerCase();
  function modelGroupOpen(groupKey: string) {
    return !!filter || expandedModelGroups.has(groupKey);
  }
  function toggleModelGroup(groupKey: string, open: boolean) {
    if (filter) return;
    setExpandedModelGroups((current) => {
      if (current.has(groupKey) === open) return current;
      const next = new Set(current);
      if (open) next.add(groupKey);
      else next.delete(groupKey);
      return next;
    });
  }
  const jevMatches =
    hasJev &&
    matches(
      query.toLocaleLowerCase(),
      JEV_PROVIDER_DEFINITION.label,
      JEV_PROVIDER_DEFINITION.modelLabel,
      JEV_PROVIDER_DEFINITION.modelId,
      t('providers.m0')
    );
  const connections = library.connections.filter((item) =>
    matches(filter, item.title, item.endpoint, providerDefinition(item.protocol).label)
  );
  const providerIds = library.connections.map((item) => item.id);
  if (
    library.models.some(
      (item) => !library.connections.some((connection) => connection.id === item.connectionId)
    )
  )
    providerIds.push('missing-provider');
  if (hasJev)
    providerIds.splice(Math.min(jevPosition, providerIds.length), 0, JEV_PROVIDER_DEFINITION.id);
  const models = library.models.filter((item) =>
    matches(
      filter,
      item.title,
      item.modelId,
      library.connections.find((c) => c.id === item.connectionId)?.title
    )
  );
  const orderedModels = [...models].sort(compareModelDisplayOrder);
  const modelGroups: { connection?: Connection; models: ModelPreset[] }[] = library.connections
    .map((connection) => ({
      connection,
      models: orderedModels.filter((item) => item.connectionId === connection.id),
    }))
    .filter((group) => group.models.length > 0);
  const orphanedModels = orderedModels.filter(
    (item) => !library.connections.some((connection) => connection.id === item.connectionId)
  );
  if (orphanedModels.length) modelGroups.push({ models: orphanedModels });

  async function deletedConnection(item: Connection) {
    if (editingConnection?.id === item.id && screen === 'connection') navigate('connections');
    dispatchDraft({ type: 'connection.deleted', id: item.id });
    setError('');
    onError('');
    setMessage(uiMessage('providers.m532', { value0: item.title }));
    await reload();
  }
  async function deletedModel(item: ModelPreset) {
    if (editingModel?.id === item.id && screen === 'model') navigate('models');
    dispatchDraft({ type: 'model.deleted', id: item.id });
    setConflict(null);
    setError('');
    onError('');
    setMessage(uiMessage('providers.m533', { value0: item.title }));
    await reload();
  }
  const deleteConnection = (item: Connection) => (
    <DeleteButton
      path={`/connections/${encodeURIComponent(item.id)}`}
      revision={item.revision}
      title={item.title}
      label={t('providers.m3')}
      description={t('providers.m4')}
      disabled={busy}
      onDeleted={() => deletedConnection(item)}
      onError={onError}
    />
  );
  const deleteModel = (item: ModelPreset, iconOnly = false) => (
    <DeleteButton
      path={`/model-presets/${encodeURIComponent(item.id)}`}
      revision={item.revision}
      title={item.title}
      label={t('providers.m5')}
      iconOnly={iconOnly}
      description={t('providers.m6')}
      disabled={busy}
      onDeleted={() => deletedModel(item)}
      onError={onError}
    />
  );

  async function perform(
    work: () => Promise<void>,
    scope: 'connection' | 'model' | 'status' = 'status',
    saveAttempt = false
  ) {
    if (operationLock.current) return false;
    operationLock.current = true;
    setOperation(saveAttempt && scope === 'model' ? 'model-save' : 'other');
    setError('');
    onError('');
    setMessage('');
    setRefreshWarning('');
    try {
      await work();
      // The command has completed. A failed read must not ask the caller to repeat it.
      try {
        await reload();
      } catch (caught) {
        const detail = caught instanceof Error ? caught.message : uiMessage('providers.m7');
        const warning = uiMessage('providers.m534', { value0: messageRef(detail) });
        setMessage('');
        setRefreshWarning(warning);
        onError(warning);
      }
      return true;
    } catch (caught) {
      const detail = caught instanceof Error ? caught.message : uiMessage('providers.m8');
      setError(detail);
      onError(detail);
      if (caught instanceof ApiError && caught.status === 409 && scope !== 'status') {
        setConflict(scope);
        if (saveAttempt) setSaveConflict(scope);
      }
      await reload().catch(() => undefined);
      return false;
    } finally {
      operationLock.current = false;
      setOperation(null);
    }
  }
  function showConnection(item: Connection, copy = false, approved = false) {
    if (!approved) {
      replaceDraft('connection', () => showConnection(item, copy, true));
      return;
    }
    const next = {
      ...connectionDraft(item),
      ...(copy ? { title: item.title + ' 복사', enabled: false } : {}),
    };
    dispatchDraft({ type: 'connection.open', value: next, editing: copy ? undefined : item, copy });
    setError('');
    onError('');
    returnItem.current = { screen: 'connections', id: item.id };
    setSetup(false);
    navigate('connection');
  }
  async function showModel(item: ModelPreset, copy = false, approved = false) {
    if (!approved && modelStarted && JSON.stringify(model) !== modelBaseline) {
      setDiscard({
        kind: 'model',
        proceed: () => {
          void perform(() => showModel(item, copy, true), 'model');
        },
      });
      return;
    }
    const next = {
      ...modelDraft(item),
      ...(copy ? { title: item.title + ' 복사' } : {}),
    };
    dispatchDraft({ type: 'model.open', value: next, editing: copy ? undefined : item, copy });
    setModelSection('basic');
    returnItem.current = { screen: 'models', id: item.id };
    navigate('model');
  }
  function startModelFor(item: Connection) {
    const next = selectModelConnection(initialModel(), item);
    dispatchDraft({ type: 'model.open', value: next });
    setModelSection('basic');
    navigate('model');
  }
  async function saveConnection(
    body: Record<string, unknown>,
    id?: string,
    fromForm = true,
    leave = false
  ) {
    const saved = await api<Connection>(
      id ? `/connections/${id}` : '/connections',
      body,
      id ? 'PUT' : 'POST'
    );
    if (fromForm) {
      dispatchDraft({ type: 'connection.open', value: connectionDraft(saved), editing: saved });
      if (!id && !leave) {
        replaceDraft('model', () => startModelFor(saved));
      }
    }
    setMessage(
      uiMessage('providers.m600', { name: saved.title, action: id ? 'updated' : 'created' })
    );
  }
  async function saveModel(
    body: Record<string, unknown>,
    id?: string,
    fromForm = true,
    leave = false
  ) {
    const saved = await api<ModelPreset>(
      id ? `/model-presets/${id}` : '/model-presets',
      body,
      id ? 'PUT' : 'POST'
    );
    if (fromForm) {
      dispatchDraft({ type: 'model.open', value: modelDraft(saved), editing: saved });
      returnItem.current = { screen: 'models', id: saved.id };
      setSetup(false);
      if (!leave) navigate('models');
    }
    setMessage(
      uiMessage('providers.m601', { name: saved.title, action: id ? 'updated' : 'created' })
    );
  }
  async function catalog(item: Connection) {
    const result = await api<Connection>(`/connections/${item.id}/catalog`, {});
    if (result.catalogError) throw new Error(uiMessage('providers.m14'));
    setMessage(uiMessage('providers.m15'));
  }
  function statusConnection(item: Connection) {
    const body = {
      ...connectionPayload(connectionDraft(item)),
      enabled: !item.enabled,
      expectedRevision: item.revision,
    };
    void perform(() => saveConnection(body, item.id, false));
  }
  function editableModelBody(item: ModelPreset, changes: Record<string, unknown> = {}) {
    const { id: _id, revision, source: _source, capabilityProtocol: _protocol, ...body } = item;
    return { ...body, ...changes, expectedRevision: revision };
  }
  function statusModel(item: ModelPreset) {
    void perform(() =>
      saveModel(editableModelBody(item, { enabled: item.enabled === false }), item.id, false)
    );
  }
  function moveDisplay(
    kind: 'connection' | 'model',
    id: string,
    targetId: string,
    position: 'before' | 'after'
  ) {
    if (id === targetId || busy || filter) return;
    void perform(async () => {
      if (kind === 'connection') {
        const next = providerIds.filter((value) => value !== id);
        next.splice(next.indexOf(targetId) + (position === 'after' ? 1 : 0), 0, id);
        const regular = next.filter((value) =>
          library.connections.some((item) => item.id === value)
        );
        if (id !== JEV_PROVIDER_DEFINITION.id) {
          const index = regular.indexOf(id);
          const anchor = regular[index + 1] ?? regular[index - 1];
          if (anchor)
            await api(`/connections/${id}/move`, {
              targetId: anchor,
              position: index < regular.length - 1 ? 'before' : 'after',
              expectedOrder: library.connections.map((item) => item.id),
            });
        }
        if (hasJev) {
          const index = next.indexOf(JEV_PROVIDER_DEFINITION.id);
          setJevPosition(index);
          try {
            localStorage.setItem('uimori-jev-display-position', String(index));
          } catch {
            /* Session choice stays usable. */
          }
        }
      } else {
        const model = library.models.find((item) => item.id === id);
        const group = library.models.filter((item) => item.connectionId === model?.connectionId);
        if (!group.some((item) => item.id === targetId)) return;
        await api(`/model-presets/${id}/move`, {
          targetId,
          position,
          expectedOrder: group.map((item) => item.id),
        });
      }
      setMessage(uiMessage('providers.m16'));
    });
  }
  function dragAttributes(kind: 'connection' | 'model', id: string) {
    return {
      draggable: !busy && !filter,
      tabIndex: 0,
      'data-display-id': id,
      'data-drop-target': dropTarget === id || undefined,
      onDragStart(event: DragEvent<HTMLElement>) {
        event.stopPropagation();
        dragged.current = { kind, id };
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', id);
      },
      onDragEnd() {
        dragged.current = null;
        setDropTarget(null);
      },
      onDragOver(event: DragEvent<HTMLElement>) {
        const source = dragged.current;
        if (!source || source.kind !== kind || source.id === id || busy || filter) return;
        if (
          kind === 'model' &&
          library.models.find((item) => item.id === source.id)?.connectionId !==
            library.models.find((item) => item.id === id)?.connectionId
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = 'move';
        setDropTarget(id);
      },
      onDrop(event: DragEvent<HTMLElement>) {
        const source = dragged.current;
        if (!source || source.kind !== kind) return;
        event.preventDefault();
        event.stopPropagation();
        const rectangle = event.currentTarget.getBoundingClientRect();
        moveDisplay(
          kind,
          source.id,
          id,
          event.clientY < rectangle.top + rectangle.height / 2 ? 'before' : 'after'
        );
        dragged.current = null;
        setDropTarget(null);
      },
      onKeyDown(event: KeyboardEvent<HTMLElement>) {
        if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        const group =
          kind === 'connection'
            ? providerIds.filter((item) => item !== 'missing-provider')
            : library.models
                .filter(
                  (item) =>
                    item.connectionId ===
                    library.models.find((item) => item.id === id)?.connectionId
                )
                .map((item) => item.id);
        const offset = event.key === 'ArrowUp' ? -1 : 1;
        const target = group[group.indexOf(id) + offset];
        if (target) moveDisplay(kind, id, target, offset < 0 ? 'before' : 'after');
      },
    };
  }
  function orderMenu(kind: 'connection' | 'model', id: string) {
    return (
      <button
        type="button"
        className="secondary"
        disabled={busy || !!filter}
        onClick={() => {
          setMovingDisplay({ kind, id });
          setMoveTarget('');
          setMovePosition('before');
        }}
      >
        <MoveIcon size={18} aria-hidden="true" />
        {t('providers.m17')}
      </button>
    );
  }
  const moveChoices = !movingDisplay
    ? []
    : movingDisplay.kind === 'connection'
      ? providerIds
          .filter((id) => id !== movingDisplay.id && id !== 'missing-provider')
          .map((id) => ({
            id,
            title:
              id === JEV_PROVIDER_DEFINITION.id
                ? 'TypeSafe AI'
                : library.connections.find((item) => item.id === id)!.title,
          }))
      : library.models.filter(
          (item) =>
            item.id !== movingDisplay.id &&
            item.connectionId ===
              library.models.find((model) => model.id === movingDisplay.id)?.connectionId
        );
  async function latest(kind: 'connection' | 'model') {
    if (kind === 'connection' && editingConnection) {
      const value = await api<Connection>(`/connections/${editingConnection.id}`);
      if (!value) throw new Error(uiMessage('providers.m18'));
      showConnection(value, false, true);
    }
    if (kind === 'model' && editingModel) {
      const value = await api<ModelPreset>(`/model-presets/${editingModel.id}`);
      if (!value) throw new Error(uiMessage('providers.m19'));
      await showModel(value, false, true);
    }
    setMessage(uiMessage('providers.m20'));
  }
  function newConnection() {
    setSetup(true);
    navigate('providers');
  }
  function startProvider(protocol: ProviderProtocol, approved = false) {
    if (!approved) {
      replaceDraft('connection', () => startProvider(protocol, true));
      return;
    }
    const template = providerDefinition(protocol);
    const next = {
      ...initialConnection(),
      protocol,
      title: protocol === 'fixture-sse-v1' ? '' : template.label,
      endpoint: template.endpointDefault,
      credentialRef: '',
      enabled: protocol !== 'fixture-sse-v1',
    };
    dispatchDraft({ type: 'connection.open', value: next });
    setError('');
    onError('');
    navigate('connection');
  }
  function newModel(approved = false) {
    if (!approved) {
      replaceDraft('model', () => newModel(true));
      return;
    }
    const linked =
      chosen ?? library.connections.find((item) => item.enabled) ?? library.connections[0];
    const next = linked ? selectModelConnection(initialModel(), linked) : initialModel();
    dispatchDraft({ type: 'model.open', value: next });
    setError('');
    setSetup(false);
    setModelSection('basic');
    navigate('model');
  }

  async function submitConnection(leave = false): Promise<boolean> {
    if (busy) return false;
    if (!connectionForm.current?.checkValidity()) {
      setScreen('connection');
      requestAnimationFrame(() => connectionForm.current?.reportValidity());
      return false;
    }
    const body = {
      ...connectionPayload(connection),
      ...(editingConnection ? { expectedRevision: editingConnection.revision } : {}),
    };
    return perform(
      () => saveConnection(body, editingConnection?.id, true, leave),
      'connection',
      true
    );
  }
  async function submitModel(leave = false): Promise<boolean> {
    if (busy || !modelForm.current) return false;
    const invalid = modelForm.current.querySelector<HTMLInputElement | HTMLSelectElement>(
      'input:invalid,select:invalid,textarea:invalid'
    );
    if (invalid) {
      setScreen('model');
      const section = invalid.closest<HTMLElement>('[data-model-section]')?.dataset.modelSection;
      setModelSection((section as typeof modelSection) || 'basic');
      for (
        let parent: HTMLElement | null = invalid.parentElement;
        parent && parent !== modelForm.current;
        parent = parent.parentElement
      )
        if (parent instanceof HTMLDetailsElement) parent.open = true;
      requestAnimationFrame(() => {
        invalid.focus();
        invalid.reportValidity();
      });
      return false;
    }
    if (!chosen) return false;
    const optionError = modelDraftError(model, chosen, forcedVertexTier);
    if (optionError) {
      setScreen('model');
      setModelSection('advanced');
      setError(optionError);
      onError(optionError);
      requestAnimationFrame(() =>
        modelForm.current
          ?.querySelector<HTMLElement>('[data-model-section="generation"]')
          ?.scrollIntoView({ block: 'nearest' })
      );
      return false;
    }
    const body = {
      ...modelPayload(model, chosen),
      ...(editingModel ? { expectedRevision: editingModel.revision } : {}),
    };
    return perform(() => saveModel(body, editingModel?.id, true, leave), 'model', true);
  }
  const savePending = async (): Promise<boolean> => {
    if (busy) return false;
    if (
      connectionStarted &&
      JSON.stringify(connection) !== connectionBaseline &&
      !(await submitConnection(true))
    )
      return false;
    if (modelStarted && JSON.stringify(model) !== modelBaseline && !(await submitModel(true)))
      return false;
    if (jevDirty && !(await jevSave.current?.())) return false;
    return true;
  };
  useSettingsSaveHandler(onSaveHandlerChange, savePending);

  const handledModel = useRef<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A navigation request reads the current draft once; later draft or library edits must not reopen the editor.
  useEffect(() => {
    if (!modelToEdit) {
      handledModel.current = null;
      return;
    }
    if (busy || handledModel.current === modelToEdit) return;
    handledModel.current = modelToEdit;
    onModelEditHandled?.();
    const target = library.models.find((item) => item.id === modelToEdit);
    if (!target) {
      setError(uiMessage('providers.m21'));
      return;
    }
    if (editingModel?.id === target.id) navigate('model');
    else void showModel(target);
  }, [modelToEdit, busy]);

  const jevConnectionRow = jevMatches ? (
    <article
      key={JEV_PROVIDER_DEFINITION.id}
      className="provider-saved-item"
      aria-label={t('providers.m22')}
      {...dragAttributes('connection', JEV_PROVIDER_DEFINITION.id)}
    >
      <div className="provider-item-heading">
        <button
          type="button"
          className="provider-item-open secondary"
          disabled={busy}
          aria-label={t('providers.m23')}
          data-provider-id={JEV_PROVIDER_DEFINITION.id}
          onClick={() => openJev('connections')}
        >
          <strong>TypeSafe AI</strong>
        </button>
        <ActionMenu label={t('providers.m24')}>
          {orderMenu('connection', JEV_PROVIDER_DEFINITION.id)}
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => openJev('connections')}
          >
            <ConnectionIcon size={18} aria-hidden="true" />
            {t('providers.m25')}
          </button>
        </ActionMenu>
      </div>
    </article>
  ) : null;
  const jevModelRow = jevMatches ? (
    <details
      key={JEV_PROVIDER_DEFINITION.id}
      className="provider-model-group"
      open={modelGroupOpen(JEV_PROVIDER_DEFINITION.id)}
      onToggle={(event) => toggleModelGroup(JEV_PROVIDER_DEFINITION.id, event.currentTarget.open)}
    >
      <summary {...dragAttributes('connection', JEV_PROVIDER_DEFINITION.id)}>
        <span>
          <strong>{JEV_PROVIDER_DEFINITION.label}</strong>
          <small>{t('providers.m26')}</small>
        </span>
      </summary>
      <div className="provider-model-group-list">
        <article className="provider-saved-item" aria-label={t('providers.m27')}>
          <div className="provider-item-heading">
            <button
              type="button"
              className="provider-item-open secondary"
              disabled={busy}
              aria-label={t('providers.m28')}
              data-provider-id={JEV_PROVIDER_DEFINITION.id}
              onClick={() => {
                setSetup(false);
                openJev('models');
              }}
            >
              <strong>{JEV_PROVIDER_DEFINITION.modelLabel}</strong>
              <span className="provider-item-subtitle">{JEV_PROVIDER_DEFINITION.modelId}</span>
            </button>
            <ActionMenu label={t('providers.m29')}>
              {orderMenu('connection', JEV_PROVIDER_DEFINITION.id)}
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => {
                  setSetup(false);
                  openJev('models');
                }}
              >
                <ModelIcon size={18} aria-hidden="true" />
                {t('providers.m30')}
              </button>
            </ActionMenu>
          </div>
          <section className="provider-model-test" aria-label={t('providers.m31')}>
            <div className="provider-actions">
              <button
                type="button"
                className="secondary"
                disabled={busy}
                aria-label={t('providers.m32')}
                onClick={() => {
                  setSetup(false);
                  openJev('models');
                }}
              >
                {t('providers.m33')}
              </button>
            </div>
          </section>
        </article>
      </div>
    </details>
  ) : null;
  return (
    <section
      className="connection-editor"
      data-testid="connection-editor"
      aria-label={t('providers.m34')}
    >
      <Dialog
        open={!!movingDisplay}
        title={t('providers.m35')}
        onClose={() => setMovingDisplay(null)}
      >
        <div className="control-grid">
          <label className="full">
            {t('providers.m36')}
            <select value={moveTarget} onChange={(event) => setMoveTarget(event.target.value)}>
              <option value="">{t('providers.m37')}</option>
              {moveChoices.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title}
                </option>
              ))}
            </select>
          </label>
          <label className="full">
            {t('providers.m38')}
            <select
              value={movePosition}
              onChange={(event) => setMovePosition(event.target.value as 'before' | 'after')}
            >
              <option value="before">{t('providers.m39')}</option>
              <option value="after">{t('providers.m40')}</option>
            </select>
          </label>
        </div>
        <div className="form-actions">
          <button
            type="button"
            disabled={!moveTarget || busy}
            onClick={() => {
              if (movingDisplay)
                moveDisplay(movingDisplay.kind, movingDisplay.id, moveTarget, movePosition);
              setMovingDisplay(null);
            }}
          >
            {t('providers.m41')}
          </button>
        </div>
      </Dialog>
      <SaveConflictDialog
        open={saveConflict !== null}
        title={t('providers.m42')}
        onClose={() => setSaveConflict(null)}
        readSaved={async () => {
          if (saveConflict === 'connection' && editingConnection) {
            const value = await api<Connection>(`/connections/${editingConnection.id}`);
            return () => [
              { label: t('providers.m43'), value: value.title },
              {
                label: t('providers.m44'),
                value: translateMessage(providerDefinition(value.protocol).label),
              },
              { label: t('providers.m45'), value: value.endpoint },
              {
                label: t('providers.m46'),
                value: value.enabled ? t('providers.m47') : t('providers.m48'),
              },
            ];
          }
          if (saveConflict === 'model' && editingModel) {
            const value = await api<ModelPreset>(`/model-presets/${editingModel.id}`);
            return () => [
              { label: t('providers.m49'), value: value.title },
              { label: t('providers.m50'), value: value.modelId },
              { label: t('providers.m51'), value: formatNumber(value.maxOutputTokens) },
              {
                label: t('providers.m52'),
                value:
                  value.inputTokenLimit === undefined
                    ? t('providers.m53')
                    : formatNumber(value.inputTokenLimit),
              },
            ];
          }
          throw new Error(uiMessage('providers.m54'));
        }}
      />
      <Dialog
        open={!!discard}
        role="alertdialog"
        title={t('providers.m55')}
        variant="confirmation"
        onClose={() => {
          if (!discard || busy || operationLock.current) return;
          const kind = discard.kind;
          setDiscard(undefined);
          setScreen(kind);
        }}
      >
        {discard && (
          <>
            <strong>{t('providers.m536', { kind: discard.kind })}</strong>
            <p>{t('providers.m59')}</p>
            <DraftDiscardActions
              disabled={busy}
              onSave={async () => {
                const pending = discard;
                const saved =
                  pending.kind === 'connection'
                    ? await submitConnection(true)
                    : await submitModel(true);
                if (!saved) return false;
                setDiscard(undefined);
                pending.proceed();
                return true;
              }}
              onContinue={() => {
                const kind = discard.kind;
                setDiscard(undefined);
                setScreen(kind);
              }}
              onDiscard={() => {
                const action = discard.proceed;
                setDiscard(undefined);
                action();
              }}
              discardLabel={t('providers.m60')}
            />
          </>
        )}
      </Dialog>
      <div className="provider-workspace-heading" ref={heading} tabIndex={-1}>
        <div className="provider-workspace-navigation" aria-label={t('providers.m61')}>
          <button
            type="button"
            className={
              ['connections', 'connection', 'providers'].includes(screen) ||
              (screen === 'jev' && jevReturn === 'connections')
                ? 'selected'
                : 'secondary'
            }
            aria-label={t('providers.m62')}
            aria-pressed={
              ['connections', 'connection', 'providers'].includes(screen) ||
              (screen === 'jev' && jevReturn === 'connections')
            }
            disabled={busy}
            onClick={() => {
              setSetup(false);
              navigate('connections');
            }}
          >
            <ConnectionIcon size={18} aria-hidden="true" />
            {t('providers.m57')}
          </button>
          <button
            type="button"
            className={
              screen === 'models' ||
              screen === 'model' ||
              (screen === 'jev' && jevReturn === 'models')
                ? 'selected'
                : 'secondary'
            }
            aria-label={t('providers.m63')}
            aria-pressed={
              screen === 'models' ||
              screen === 'model' ||
              (screen === 'jev' && jevReturn === 'models')
            }
            disabled={busy}
            onClick={() => {
              setSetup(false);
              navigate('models');
            }}
          >
            <ModelIcon size={18} aria-hidden="true" />
            {t('providers.m63')}
          </button>
          <IconButton
            label={t('providers.m64')}
            icon={RefreshIcon}
            className="provider-refresh"
            hidden={screen === 'jev'}
            disabled={busy}
            onClick={() => {
              void perform(async () => {
                await reload();
                setJevListRefresh((value) => value + 1);
                setMessage(uiMessage('providers.m65'));
              });
            }}
          />
        </div>
      </div>
      {jevListError && <NoticeBanner tone="error">{t('providers.m66')}</NoticeBanner>}
      {(screen === 'models' || screen === 'connections') && (
        <>
          {((screen === 'models' ? library.models.length : library.connections.length) > 0 ||
            hasJev) && (
            <div className="provider-toolbar">
              <label className="provider-search">
                <SearchIcon size={18} aria-hidden="true" />
                <input
                  type="search"
                  aria-label={t('providers.m67')}
                  placeholder={screen === 'models' ? t('providers.m68') : t('providers.m69')}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </label>
              <div className="provider-actions">
                <button
                  type="button"
                  className="primary"
                  aria-label={screen === 'connections' ? t('providers.m70') : t('providers.m71')}
                  disabled={busy}
                  onClick={() => (screen === 'connections' ? newConnection() : newModel())}
                >
                  <AddIcon size={18} aria-hidden="true" />
                  <span>{screen === 'connections' ? t('providers.m72') : t('providers.m73')}</span>
                </button>
              </div>
            </div>
          )}
          {jevDirty && (
            <button
              type="button"
              className="provider-resume secondary"
              disabled={busy}
              onClick={() => openJev('connections')}
            >
              {t('providers.m74')}
            </button>
          )}
          {screen === 'connections' && connectionStarted && (
            <button
              type="button"
              className="provider-resume secondary"
              disabled={busy}
              onClick={() => navigate('connection')}
            >
              {t('providers.m537', { value0: connection.title || t('providers.m76') })}
            </button>
          )}
          {screen === 'models' && modelStarted && (
            <button
              type="button"
              className="provider-resume secondary"
              disabled={busy}
              onClick={() => navigate('model')}
            >
              {t('providers.m538', { value0: model.title || t('providers.m76') })}
            </button>
          )}
          {!library.connections.length && !hasJev && (
            <div className="provider-welcome">
              <ConnectionIcon size={28} aria-hidden="true" />
              <h4>{t('providers.m78')}</h4>
              <p>{t('providers.m79')}</p>
              <ol className="provider-steps" aria-label={t('providers.m83')}>
                <li>{t('providers.m85')}</li>
                <li>{t('providers.m86')}</li>
              </ol>
              <button type="button" disabled={busy} onClick={newConnection}>
                {t('providers.m72')}
                <ForwardIcon size={18} aria-hidden="true" />
              </button>
            </div>
          )}
          {library.connections.length > 0 &&
            !library.models.length &&
            !hasJev &&
            screen === 'models' && (
              <div className="provider-welcome">
                <ModelIcon size={28} aria-hidden="true" />
                <h4>{t('providers.m80')}</h4>
                <p>{t('providers.m81')}</p>
                <button type="button" disabled={busy} onClick={() => newModel()}>
                  <AddIcon size={18} aria-hidden="true" />
                  {t('providers.m71')}
                </button>
              </div>
            )}
        </>
      )}
      {(screen === 'connection' ||
        screen === 'model' ||
        screen === 'providers' ||
        screen === 'jev') && (
        <div className="provider-editor-heading">
          {(screen === 'providers' || screen === 'jev') && (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => {
                setSetup(false);
                navigate(screen === 'jev' ? jevReturn : 'connections');
              }}
            >
              <BackIcon size={16} />
              {t('providers.m82')}
            </button>
          )}
          {setup && (
            <ol className="provider-steps" aria-label={t('providers.m83')}>
              <li aria-current={screen === 'providers' ? 'step' : undefined}>
                {t('providers.m84')}
              </li>
              <li aria-current={screen === 'connection' || screen === 'jev' ? 'step' : undefined}>
                {t('providers.m85')}
              </li>
              <li aria-current={screen === 'model' ? 'step' : undefined}>{t('providers.m86')}</li>
            </ol>
          )}
        </div>
      )}
      {screen === 'providers' && (
        <section className="provider-selection" aria-label={t('providers.m87')}>
          <h4>{t('providers.m88')}</h4>
          <div className="provider-template-grid">
            {PROVIDER_CHOICES.filter((item) => item.id !== 'fixture-sse-v1').map((item) => (
              <button
                type="button"
                className="secondary provider-template"
                key={item.id}
                disabled={busy}
                onClick={() => (item.kind === 'judgment' ? openJev() : startProvider(item.id))}
              >
                <span className="provider-template-icon">
                  <ConnectionIcon size={20} />
                </span>
                <strong>{translateMessage(item.label)}</strong>
                <small>
                  {item.kind === 'judgment'
                    ? t('providers.m90')
                    : item.id === 'codex-app-server-v1'
                      ? t('providers.m91')
                      : item.id === 'vertex-gemini-v1'
                        ? t('providers.m92')
                        : item.id === 'google-gemini-v1'
                          ? t('providers.m93')
                          : item.id === 'openai-chat-v1'
                            ? t('providers.m94')
                            : t('providers.m90')}
                </small>
                <ForwardIcon size={16} />
              </button>
            ))}
          </div>
          {testMode && (
            <details className="provider-test-template">
              <summary>{t('providers.m95')}</summary>
              <button
                type="button"
                className="secondary"
                onClick={() => startProvider('fixture-sse-v1')}
              >
                {t('providers.m96')}
              </button>
            </details>
          )}
        </section>
      )}
      <JevProviderSettings
        onSaveHandlerChange={(handler) => {
          jevSave.current = handler;
        }}
        active={screen === 'jev'}
        view={jevReturn === 'models' ? 'model' : 'connection'}
        onConnectionOpen={() => openJev('connections')}
        onDirtyChange={setJevDirty}
        onBusyChange={setJevBusy}
        onStatusChange={setJevStatus}
      />
      <section hidden={screen !== 'connections'} aria-label={t('providers.m97')}>
        {providerIds.length > 1 && <p className="muted">{t('providers.m98')}</p>}
        <div className="connection-list provider-saved-list settings-group-body">
          {providerIds.map((id) => {
            if (id === JEV_PROVIDER_DEFINITION.id) return jevConnectionRow;
            const item = connections.find((value) => value.id === id);
            if (!item) return null;
            return (
              <article
                className="provider-saved-item"
                key={versionRef(item)}
                aria-label={t('providers.m539', { value0: item.title })}
                {...dragAttributes('connection', item.id)}
              >
                <div className="provider-item-heading">
                  <button
                    type="button"
                    className="provider-item-open secondary"
                    disabled={busy}
                    aria-label={t('providers.m540', { value0: item.title })}
                    data-provider-id={item.id}
                    onClick={() => showConnection(item)}
                  >
                    <strong>{item.title}</strong>
                    {(item.title !== providerDefinition(item.protocol).label || !item.enabled) && (
                      <span className="provider-item-subtitle">
                        {[
                          item.title !== providerDefinition(item.protocol).label
                            ? translateMessage(providerDefinition(item.protocol).label)
                            : '',
                          !item.enabled ? t('providers.m101') : '',
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    )}
                  </button>
                  <ActionMenu label={t('providers.m541', { value0: item.title })}>
                    {orderMenu('connection', item.id)}
                    {(testMode || item.protocol !== 'fixture-sse-v1') && (
                      <button
                        type="button"
                        className="secondary"
                        disabled={busy}
                        aria-label={t('providers.m542', { value0: item.title })}
                        onClick={() => showConnection(item, true)}
                      >
                        <CopyIcon size={18} aria-hidden="true" />
                        {t('providers.m104')}
                      </button>
                    )}
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy}
                      aria-label={t('providers.m543', {
                        name: item.title,
                        enabled: String(item.enabled),
                      })}
                      onClick={() => statusConnection(item)}
                    >
                      <PowerIcon size={18} aria-hidden="true" />{' '}
                      {item.enabled ? t('providers.m101') : t('providers.m106')}
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy}
                      aria-label={t('providers.m544', { value0: item.title })}
                      onClick={() => {
                        setSetup(false);
                        replaceDraft('model', () => startModelFor(item));
                      }}
                    >
                      <ModelIcon size={18} aria-hidden="true" />
                      {t('providers.m108')}
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy}
                      aria-label={t('providers.m545', { value0: item.title })}
                      onClick={() => {
                        void perform(() => catalog(item));
                      }}
                    >
                      <RefreshIcon size={18} aria-hidden="true" />
                      {t('providers.m110')}
                    </button>
                    {deleteConnection(item)}
                  </ActionMenu>
                </div>
                {item.catalogError && (
                  <NoticeBanner tone="error" className="provider-item-notice">
                    {t('providers.m111')}
                  </NoticeBanner>
                )}
              </article>
            );
          })}

          {connections.length === 0 &&
            !jevMatches &&
            (library.connections.length > 0 || hasJev) && (
              <div className="provider-empty" role="status">
                <p>{t('providers.m112')}</p>
                <button type="button" className="secondary" onClick={() => setQuery('')}>
                  {t('providers.m113')}
                </button>
              </div>
            )}
        </div>
      </section>
      <section
        hidden={screen !== 'models'}
        className="registered-models"
        aria-label={t('providers.m114')}
      >
        {library.models.length > 1 && <p className="muted">{t('providers.m115')}</p>}
        <div className="provider-saved-list settings-group-body">
          {providerIds.map((id) => {
            if (id === JEV_PROVIDER_DEFINITION.id) return jevModelRow;
            const group = modelGroups.find(
              (value) => (value.connection?.id ?? 'missing-provider') === id
            );
            if (!group) return null;
            const groupKey = group.connection?.id ?? 'missing-provider';
            return (
              <details
                className="provider-model-group"
                key={groupKey}
                open={modelGroupOpen(groupKey)}
                onToggle={(event) => toggleModelGroup(groupKey, event.currentTarget.open)}
              >
                <summary
                  {...(group.connection ? dragAttributes('connection', group.connection.id) : {})}
                >
                  <span>
                    <strong>{group.connection?.title ?? t('providers.m116')}</strong>
                    <small>{t('providers.m546', { value0: group.models.length })}</small>
                  </span>
                </summary>
                <div className="provider-model-group-list">
                  {group.models.map((item) => (
                    <article
                      className="provider-saved-item"
                      key={versionRef(item)}
                      aria-label={t('providers.m547', { value0: item.title })}
                      {...dragAttributes('model', item.id)}
                    >
                      <div className="provider-item-heading">
                        <button
                          type="button"
                          className="provider-item-open secondary"
                          disabled={busy}
                          aria-label={t('providers.m548', { value0: item.title })}
                          data-provider-id={item.id}
                          onClick={() => {
                            void perform(() => showModel(item), 'model');
                          }}
                        >
                          <strong>{item.title}</strong>
                          <span className="provider-item-subtitle">
                            {item.modelId}
                            {item.enabled === false
                              ? t('providers.m120')
                              : group.connection?.enabled === false
                                ? t('providers.m121')
                                : ''}
                          </span>
                        </button>
                        <div className="provider-model-row-actions">
                          <ActionMenu label={t('providers.m549', { value0: item.title })}>
                            {orderMenu('model', item.id)}
                            <button
                              type="button"
                              className="secondary"
                              disabled={busy}
                              aria-label={t('providers.m550', { value0: item.title })}
                              onClick={() => {
                                void perform(() => showModel(item, true), 'model');
                              }}
                            >
                              <CopyIcon size={18} aria-hidden="true" />
                              {t('providers.m104')}
                            </button>
                            <button
                              type="button"
                              className="secondary"
                              disabled={busy}
                              aria-label={t('providers.m551', {
                                name: item.title,
                                enabled: String(item.enabled !== false),
                              })}
                              onClick={() => statusModel(item)}
                            >
                              <PowerIcon size={18} aria-hidden="true" />{' '}
                              {item.enabled === false ? t('providers.m106') : t('providers.m101')}
                            </button>
                            {deleteModel(item)}
                          </ActionMenu>
                        </div>
                      </div>
                      <ProviderModelTest
                        model={item}
                        record={modelTests.records[versionRef(item)]}
                        available={
                          item.enabled !== false &&
                          library.connections.some(
                            (connection) =>
                              connection.id === item.connectionId && connection.enabled
                          )
                        }
                        busy={busy}
                        onStart={modelTests.start}
                      />
                    </article>
                  ))}
                </div>
              </details>
            );
          })}
          {models.length === 0 && !jevMatches && (library.models.length > 0 || hasJev) && (
            <div className="provider-empty" role="status">
              <p>{t('providers.m125')}</p>
              <button type="button" className="secondary" onClick={() => setQuery('')}>
                {t('providers.m113')}
              </button>
            </div>
          )}
        </div>
      </section>
      <ProviderConnectionForm
        testMode={testMode}
        hidden={screen !== 'connection'}
        draft={drafts.connection}
        connections={library.connections}
        conflict={conflict === 'connection'}
        busy={busy}
        operationBusy={operationBusy}
        formRef={connectionForm}
        onChange={setConnection}
        onUploadBusy={setUploadingCredential}
        onSubmit={submitConnection}
        onReload={() => {
          void perform(() => latest('connection'), 'connection');
        }}
        onDone={() => navigate('connections')}
        deleteAction={editingConnection && deleteConnection(editingConnection)}
      />
      <ProviderModelForm
        hidden={screen !== 'model'}
        draft={drafts.model}
        models={library.models}
        modelConnections={library.connections}
        conflict={conflict === 'model'}
        busy={busy}
        saving={operation === 'model-save'}
        forcedVertexTier={forcedVertexTier}
        modelSection={modelSection}
        onSectionChange={setModelSection}
        formRef={modelForm}
        onChange={setModel}
        onSubmit={submitModel}
        onReload={() => {
          void perform(() => latest('model'), 'model');
        }}
        onDone={() => navigate('models')}
        onCatalog={(item) => {
          void perform(() => catalog(item));
        }}
        deleteAction={editingModel && deleteModel(editingModel, true)}
      />
      {error && <NoticeBanner tone="error">{translateMessage(error)}</NoticeBanner>}
      <TransientNotice message={message} />
      {refreshWarning && <NoticeBanner>{translateMessage(refreshWarning)}</NoticeBanner>}
    </section>
  );
}
