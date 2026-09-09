import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { api, ApiError } from './api.js';
import { IconButton } from './IconButton.js';
import { DismissibleError } from './DismissibleError.js';
import './outline.css';
import { AddIcon, DeleteIcon, EditIcon, PinIcon } from './ui-icons.js';
import {
  OUTLINE_INTENT_MAX,
  OUTLINE_LEVEL_LABELS,
  OUTLINE_TITLE_MAX,
  outlineChildLevel,
  outlineWritable,
  type OutlineDetail,
  type OutlineLevel,
  type OutlineNode,
  type OutlineProgress,
} from '../core/outline.js';
import type { StoryState } from './useStory.js';
import type { Run } from '../core/types.js';
import type { SceneCommand } from '../core/story.js';

const progressLabels: Record<OutlineProgress['state'], string> = {
  planned: '구성만 있어요',
  scheduled: '집필 예약',
  writing: '집필 중',
  written: '집필 완료',
  failed: '집필 실패',
  cancelled: '집필 취소',
};
type Draft = { title: string; intent: string; revision?: number };
function readDraft(key: string, fallback: Draft): Draft {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) ?? 'null') as Draft | null;
    if (value && typeof value.title === 'string' && typeof value.intent === 'string') return value;
  } catch {
    /* The empty form remains usable when browser storage is unavailable. */
  }
  return fallback;
}
function keepDraft(key: string, value: Draft | null) {
  try {
    if (value) sessionStorage.setItem(key, JSON.stringify(value));
    else sessionStorage.removeItem(key);
  } catch {
    /* In-memory editing still works; sending requires its own durable receipt. */
  }
}

type Pending =
  | { kind: 'apply'; body: { branchId?: string; idempotencyKey: string; operations: unknown[] } }
  | {
      kind: 'write';
      nodeId: string;
      title: string;
      commandKey: string;
      commandId?: string;
      body: {
        expectedRevision: string | null;
        expectedSettingsRevision: number;
        expectedProfileRevision?: number;
        idempotencyKey: string;
      };
    };

/** Keep the complete request, not just its key: refreshes can change the CAS fields. */
function readPending(key: string): Pending | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) ?? 'null') as Pending | null;
    if (
      value &&
      typeof value.body?.idempotencyKey === 'string' &&
      ((value.kind === 'apply' && Array.isArray(value.body.operations)) ||
        (value.kind === 'write' &&
          typeof value.nodeId === 'string' &&
          typeof value.commandKey === 'string'))
    )
      return value;
  } catch {
    /* A malformed browser record is never sent. */
  }
  return null;
}

const definitelyRejected = (error: unknown) =>
  error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408;

/** Editors stay at module scope: a nested component gets a new type each render and would
 * remount its own fields, dropping focus after every keystroke. */
function OutlineFields({
  draft,
  titleLabel,
  onChange,
  disabled,
}: {
  draft: Draft;
  titleLabel: string;
  onChange: (next: Draft) => void;
  disabled: boolean;
}) {
  return (
    <>
      <label>
        <span>{titleLabel}</span>
        <input
          value={draft.title}
          disabled={disabled}
          maxLength={OUTLINE_TITLE_MAX}
          required
          onChange={(event) => onChange({ ...draft, title: event.target.value })}
        />
      </label>
      <label>
        <span>이 수준에서 정한 의도</span>
        <textarea
          value={draft.intent}
          disabled={disabled}
          maxLength={OUTLINE_INTENT_MAX}
          rows={3}
          onChange={(event) => onChange({ ...draft, intent: event.target.value })}
        />
      </label>
    </>
  );
}

function OutlineAddForm({
  level,
  parentId,
  busy,
  apply,
  onDone,
  storageKey,
}: {
  level: OutlineLevel;
  parentId: string | null;
  busy: string;
  apply: (operations: unknown[]) => Promise<boolean>;
  onDone: () => void;
  storageKey: string;
}) {
  const [draft, setDraft] = useState<Draft>(() => readDraft(storageKey, { title: '', intent: '' }));
  return (
    <form
      className="outline-form"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!draft.title.trim()) return;
        const ok = await apply([
          { op: 'create', level, parentId, title: draft.title, intent: draft.intent },
        ]);
        if (ok) {
          keepDraft(storageKey, null);
          setDraft({ title: '', intent: '' });
          onDone();
        }
      }}
    >
      <OutlineFields
        draft={draft}
        disabled={!!busy}
        titleLabel={`${OUTLINE_LEVEL_LABELS[level]} 이름`}
        onChange={(value) => {
          keepDraft(storageKey, value);
          setDraft(value);
        }}
      />
      <div className="outline-form-actions">
        <button
          type="button"
          className="secondary"
          onClick={() => {
            keepDraft(storageKey, null);
            onDone();
          }}
        >
          취소
        </button>
        <button type="submit" disabled={!!busy}>
          추가
        </button>
      </div>
    </form>
  );
}

type EntryActions = {
  busy: string;
  draftKey: string;
  runActive: boolean;
  editing: string | null;
  adding: string | null;
  drafts: Record<string, Draft>;
  setEditing: (id: string | null) => void;
  setAdding: (id: string | null) => void;
  setDraft: (id: string, draft: Draft | null) => void;
  apply: (operations: unknown[]) => Promise<boolean>;
  onWrite: (node: OutlineNode) => void;
  onRead: (sourceRevision: string) => void;
};

function OutlineEntry({
  node,
  nodes,
  actions,
}: {
  node: OutlineNode;
  nodes: readonly OutlineNode[];
  actions: EntryActions;
}) {
  const children = nodes.filter((item) => item.parentId === node.id);
  const draft =
    actions.drafts[node.id] ??
    readDraft(`${actions.draftKey}:${node.id}`, {
      title: node.title,
      intent: node.intent,
      revision: node.revision,
    });
  const writable = outlineWritable(node.level) && node.progress.state !== 'written';
  const child = outlineChildLevel(node.level);
  const editing = actions.editing === node.id;
  return (
    <li className={`outline-entry level-${node.level} progress-${node.progress.state}`}>
      <div className="outline-row">
        <div className="outline-heading">
          <span className="outline-level">{OUTLINE_LEVEL_LABELS[node.level]}</span>
          <strong className="outline-title">{node.title}</strong>
          {node.fixed && <span className="outline-pin-badge">고정</span>}
          <span className={`outline-progress state-${node.progress.state}`}>
            {progressLabels[node.progress.state]}
          </span>
        </div>
        <div className="outline-actions">
          {child && (
            <IconButton
              label={`${OUTLINE_LEVEL_LABELS[child]} 추가`}
              icon={AddIcon}
              disabled={!!actions.busy}
              onClick={() => actions.setAdding(actions.adding === node.id ? null : node.id)}
            />
          )}
          <IconButton
            label="구성 수정"
            icon={EditIcon}
            disabled={!!actions.busy}
            onClick={() => actions.setEditing(editing ? null : node.id)}
          />
          <IconButton
            label={node.fixed ? '고정 해제' : '이 구성 고정'}
            icon={PinIcon}
            disabled={!!actions.busy}
            className={node.fixed ? 'outline-pinned' : ''}
            onClick={() =>
              actions.apply([
                { op: 'update', id: node.id, expectedRevision: node.revision, fixed: !node.fixed },
              ])
            }
          />
          {node.progress.state !== 'written' && (
            <IconButton
              label="구성 삭제"
              icon={DeleteIcon}
              disabled={!!actions.busy}
              onClick={() =>
                actions.apply([{ op: 'remove', id: node.id, expectedRevision: node.revision }])
              }
            />
          )}
          {writable && (
            <button
              type="button"
              className="outline-write"
              disabled={!!actions.busy || actions.runActive}
              onClick={() => actions.onWrite(node)}
            >
              {actions.busy === `write:${node.id}` ? '보내는 중…' : '이 단위 집필'}
            </button>
          )}
        </div>
      </div>
      {node.intent && !editing && <p className="outline-intent">{node.intent}</p>}
      {node.progress.state === 'written' && node.progress.sourceRevision && (
        <button
          type="button"
          className="secondary outline-read"
          onClick={() => actions.onRead(node.progress.sourceRevision as string)}
        >
          집필한 원문 읽기
        </button>
      )}
      {editing && (
        <form
          className="outline-form"
          onSubmit={async (event) => {
            event.preventDefault();
            const ok = await actions.apply([
              {
                op: 'update',
                id: node.id,
                expectedRevision: draft.revision ?? node.revision,
                title: draft.title,
                intent: draft.intent,
              },
            ]);
            if (ok) actions.setEditing(null);
          }}
        >
          <OutlineFields
            draft={draft}
            disabled={!!actions.busy}
            titleLabel={`${OUTLINE_LEVEL_LABELS[node.level]} 이름`}
            onChange={(next) =>
              actions.setDraft(node.id, { ...next, revision: draft.revision ?? node.revision })
            }
          />
          <div className="outline-form-actions">
            <button
              type="button"
              className="secondary"
              onClick={() => {
                actions.setDraft(node.id, null);
                actions.setEditing(null);
              }}
            >
              취소
            </button>
            <button type="submit" disabled={!!actions.busy}>
              저장
            </button>
          </div>
        </form>
      )}
      {actions.adding === node.id && child && (
        <OutlineAddForm
          level={child}
          parentId={node.id}
          storageKey={`${actions.draftKey}:add:${node.id}`}
          busy={actions.busy}
          apply={actions.apply}
          onDone={() => actions.setAdding(null)}
        />
      )}
      {!!children.length && (
        <ul className="outline-children">
          {children.map((item) => (
            <OutlineEntry key={item.id} node={item} nodes={nodes} actions={actions} />
          ))}
        </ul>
      )}
    </li>
  );
}

export function OutlinePanel({ state, onClose }: { state: StoryState; onClose: () => void }) {
  const detail = state.detail;
  const chatId = detail?.chat.id ?? '';
  const branchId = state.branch?.id;
  const pendingKey = `outline-pending:${chatId}:${branchId ?? 'main'}`;
  const [pending, setPending] = useState<Pending | null>(() => readPending(pendingKey));
  const [outline, setOutline] = useState<OutlineDetail | null>(null);
  const [busy, setBusy] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [adding, setAdding] = useState<string | null>(null);
  const request = useRef(0);
  const mounted = useRef(true);
  const sending = useRef(false);
  const titleId = useId();

  const load = useCallback(async () => {
    if (!chatId) return;
    const version = ++request.current;
    try {
      const next = await api<OutlineDetail>(
        `/chats/${chatId}/outline${branchId ? `?branchId=${encodeURIComponent(branchId)}` : ''}`,
        undefined
      );
      if (request.current === version) setOutline(next);
    } catch (error) {
      if (request.current === version) state.setError((error as Error).message);
    }
  }, [chatId, branchId, state.setError]);
  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
      request.current++;
    };
  }, [load]);

  if (!detail) return <p className="muted">먼저 이야기를 열어 주세요.</p>;
  const chat = detail.chat;
  const profileRevision = detail.profile?.revision;
  const nodes = outline?.nodes ?? [];
  const roots = nodes.filter((node) => node.parentId === null);

  function remember(next: Pending | null, key: string, requireCurrent = true) {
    const current = readPending(pendingKey);
    // A closed panel's late response cannot replace or clear a newer request.
    if (current ? current.body.idempotencyKey !== key : requireCurrent) return false;
    // Refuse a new request if the browser cannot retain its recovery record.
    if (next) sessionStorage.setItem(pendingKey, JSON.stringify(next));
    else sessionStorage.removeItem(pendingKey);
    if (mounted.current) setPending(next);
    return true;
  }

  async function send(operation: Pending) {
    if (sending.current) return false;
    sending.current = true;
    setBusy(operation.kind === 'apply' ? 'apply' : `write:${operation.nodeId}`);
    state.setError('');
    try {
      const current = readPending(pendingKey);
      if (current?.body.idempotencyKey === operation.body.idempotencyKey) operation = current;
      if (!remember(operation, operation.body.idempotencyKey, false)) return false;
      if (operation.kind === 'apply') {
        const saved = await api<{ detail: OutlineDetail }>(
          `/chats/${chatId}/outline`,
          operation.body
        );
        if (readPending(pendingKey)?.body.idempotencyKey !== operation.body.idempotencyKey)
          return false;
        // POST already returns the committed tree. A second GET must not decide save success.
        ++request.current;
        if (mounted.current) {
          setOutline(saved.detail);
          const edits = operation.body.operations as {
            op?: string;
            id?: string;
            parentId?: string;
            title?: string;
            intent?: string;
            fixed?: boolean;
          }[];
          const textEdits = edits.filter(
            (edit) => edit.op === 'remove' || edit.title !== undefined || edit.intent !== undefined
          );
          const preserved: Record<string, Draft> = {};
          for (const edit of edits)
            if (edit.id && edit.fixed !== undefined && !textEdits.includes(edit)) {
              const node = saved.detail.nodes.find((item) => item.id === edit.id);
              if (!node) continue;
              const value = {
                ...readDraft(`${pendingKey}:draft:${edit.id}`, {
                  title: node.title,
                  intent: node.intent,
                }),
                revision: node.revision,
              };
              preserved[edit.id] = value;
              keepDraft(`${pendingKey}:draft:${edit.id}`, value);
            }
          for (const edit of textEdits)
            if (edit.id) keepDraft(`${pendingKey}:draft:${edit.id}`, null);
          for (const edit of edits)
            if (edit.op === 'create')
              keepDraft(`${pendingKey}:draft:add:${edit.parentId ?? 'root'}`, null);
          if (edits.some((edit) => edit.op === 'create')) setAdding(null);
          setEditing((current) => (textEdits.some((edit) => edit.id === current) ? null : current));
          setDrafts((current) => ({
            ...Object.fromEntries(
              Object.entries(current).filter(([id]) => !textEdits.some((edit) => edit.id === id))
            ),
            ...preserved,
          }));
        }
      } else {
        if (!operation.commandId) {
          const command = await api<SceneCommand>(
            `/outline-nodes/${operation.nodeId}/scene-command`,
            { idempotencyKey: operation.commandKey }
          );
          operation = { ...operation, commandId: command.id };
          if (!remember(operation, operation.body.idempotencyKey)) return false;
        }
        await api<Run>(`/scene-commands/${operation.commandId}/run`, operation.body);
      }
      if (!remember(null, operation.body.idempotencyKey)) return false;
      if (operation.kind === 'write' && mounted.current) {
        await state.refresh(chatId);
        if (mounted.current) onClose();
      }
      return true;
    } catch (error) {
      if (definitelyRejected(error)) {
        remember(null, operation.body.idempotencyKey);
        if (mounted.current) await load();
      }
      if (mounted.current) state.setError((error as Error).message);
      return false;
    } finally {
      sending.current = false;
      if (mounted.current) setBusy('');
    }
  }
  const apply = (operations: unknown[]) => {
    if (pending) return Promise.resolve(false);
    return send({
      kind: 'apply',
      body: {
        ...(branchId ? { branchId } : {}),
        idempotencyKey: crypto.randomUUID(),
        operations,
      },
    });
  };

  /** Compose then write: the scene command reserves the unit, the existing run path writes it. */
  async function writeUnit(node: OutlineNode) {
    if (pending) return;
    await send({
      kind: 'write',
      nodeId: node.id,
      title: node.title,
      commandKey: crypto.randomUUID(),
      body: {
        expectedRevision: state.branch ? state.branch.headRevision : chat.headRevision,
        expectedSettingsRevision: chat.settingsRevision,
        ...(profileRevision === undefined ? {} : { expectedProfileRevision: profileRevision }),
        idempotencyKey: crypto.randomUUID(),
      },
    });
  }

  const actions: EntryActions = {
    busy: busy || (pending ? 'pending' : ''),
    draftKey: `${pendingKey}:draft`,
    runActive: !!state.active,
    editing,
    adding,
    drafts,
    setEditing,
    setAdding,
    setDraft: (id, draft) => {
      keepDraft(`${pendingKey}:draft:${id}`, draft);
      setDrafts((old) => {
        const next = { ...old };
        if (draft) next[id] = draft;
        else delete next[id];
        return next;
      });
    },
    apply,
    onWrite: (node) => void writeUnit(node),
    onRead: (sourceRevision) => {
      state.chooseSource(sourceRevision);
      onClose();
    },
  };

  return (
    <section className="outline-panel" aria-labelledby={titleId}>
      <h3 id={titleId} className="sr-only">
        계층형 구성
      </h3>
      <p className="muted">
        전체 주제부터 작은 사건까지 구성해요. 구성은 계획이며, 집필을 누른 단위만 실제 원문이 돼요.
        상위에서 정한 의도는 그 단위를 집필할 때 생성 입력에 함께 들어가요.
      </p>
      <DismissibleError message={state.error} onDismiss={() => state.setError('')} />
      {!outline && state.error && (
        <button type="button" onClick={() => void load()}>
          구성 다시 불러오기
        </button>
      )}
      {pending && !busy && (
        <div className="outline-pending" role="status">
          <p>
            {pending.kind === 'apply' ? '구성 저장' : `“${pending.title}” 집필`} 결과를 아직
            확인하지 못했어요. 같은 요청으로 확인해 주세요.
          </p>
          <button type="button" onClick={() => void send(pending)}>
            요청 결과 확인
          </button>
        </div>
      )}
      {!outline && <p role="status">구성을 불러오는 중이에요…</p>}
      {outline && !roots.length && (
        <p className="muted">아직 구성이 없어요. 전체 주제부터 추가하거나 도우미에게 요청해요.</p>
      )}
      {!!roots.length && (
        <ul className="outline-tree">
          {roots.map((node) => (
            <OutlineEntry key={node.id} node={node} nodes={nodes} actions={actions} />
          ))}
        </ul>
      )}
      {adding === 'root' ? (
        <OutlineAddForm
          level="theme"
          parentId={null}
          storageKey={`${pendingKey}:draft:add:root`}
          busy={busy || (pending ? 'pending' : '')}
          apply={apply}
          onDone={() => setAdding(null)}
        />
      ) : (
        <button
          type="button"
          className="secondary"
          disabled={!!busy || !!pending}
          onClick={() => setAdding('root')}
        >
          {OUTLINE_LEVEL_LABELS.theme} 추가
        </button>
      )}
      {!!state.active && (
        <p className="muted">원문 생성이 진행 중이에요. 끝나거나 취소한 뒤 집필해 주세요.</p>
      )}
    </section>
  );
}
