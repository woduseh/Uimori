import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { api, ApiError } from './api.js';
import { IconButton } from './IconButton.js';
import './outline.css';
import { Plus, PenLine, Trash2, Pin } from 'lucide-react';
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
type Draft = { title: string; intent: string };

/** One durable key per node so an uncertain send is confirmed instead of duplicated. */
const writeKey = (nodeId: string) => `outline-write:${nodeId}`;
function reserveKeys(nodeId: string) {
  const stored = sessionStorage.getItem(writeKey(nodeId));
  if (stored) {
    try {
      const parsed = JSON.parse(stored) as { command?: unknown; run?: unknown };
      if (typeof parsed.command === 'string' && typeof parsed.run === 'string')
        return parsed as { command: string; run: string };
    } catch {
      // A malformed local record is replaced below rather than reused.
    }
  }
  const keys = { command: crypto.randomUUID(), run: crypto.randomUUID() };
  sessionStorage.setItem(writeKey(nodeId), JSON.stringify(keys));
  return keys;
}

/** Editors stay at module scope: a nested component gets a new type each render and would
 * remount its own fields, dropping focus after every keystroke. */
function OutlineFields({
  draft,
  titleLabel,
  onChange,
}: {
  draft: Draft;
  titleLabel: string;
  onChange: (next: Draft) => void;
}) {
  return (
    <>
      <label>
        <span>{titleLabel}</span>
        <input
          value={draft.title}
          maxLength={OUTLINE_TITLE_MAX}
          required
          onChange={(event) => onChange({ ...draft, title: event.target.value })}
        />
      </label>
      <label>
        <span>이 수준에서 정한 의도</span>
        <textarea
          value={draft.intent}
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
}: {
  level: OutlineLevel;
  parentId: string | null;
  busy: string;
  apply: (operations: unknown[]) => Promise<boolean>;
  onDone: () => void;
}) {
  const [draft, setDraft] = useState<Draft>({ title: '', intent: '' });
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
          setDraft({ title: '', intent: '' });
          onDone();
        }
      }}
    >
      <OutlineFields
        draft={draft}
        titleLabel={`${OUTLINE_LEVEL_LABELS[level]} 이름`}
        onChange={setDraft}
      />
      <div className="outline-form-actions">
        <button type="button" className="secondary" onClick={onDone}>
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
  runActive: boolean;
  editing: string | null;
  adding: string | null;
  drafts: Record<string, Draft>;
  setEditing: (id: string | null) => void;
  setAdding: (id: string | null) => void;
  setDraft: (id: string, draft: Draft) => void;
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
  const draft = actions.drafts[node.id] ?? { title: node.title, intent: node.intent };
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
              icon={Plus}
              onClick={() => actions.setAdding(actions.adding === node.id ? null : node.id)}
            />
          )}
          <IconButton
            label="구성 수정"
            icon={PenLine}
            onClick={() => actions.setEditing(editing ? null : node.id)}
          />
          <IconButton
            label={node.fixed ? '고정 해제' : '이 구성 고정'}
            icon={Pin}
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
              icon={Trash2}
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
                expectedRevision: node.revision,
                title: draft.title,
                intent: draft.intent,
              },
            ]);
            if (ok) actions.setEditing(null);
          }}
        >
          <OutlineFields
            draft={draft}
            titleLabel={`${OUTLINE_LEVEL_LABELS[node.level]} 이름`}
            onChange={(next) => actions.setDraft(node.id, next)}
          />
          <div className="outline-form-actions">
            <button type="button" className="secondary" onClick={() => actions.setEditing(null)}>
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
  const [outline, setOutline] = useState<OutlineDetail | null>(null);
  const [busy, setBusy] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [adding, setAdding] = useState<string | null>(null);
  const request = useRef(0);
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
    void load();
  }, [load]);

  if (!detail) return <p className="muted">먼저 이야기를 열어 주세요.</p>;
  const chat = detail.chat;
  const profileRevision = detail.profile?.revision;
  const nodes = outline?.nodes ?? [];
  const roots = nodes.filter((node) => node.parentId === null);

  async function write(action: string, run: () => Promise<unknown>) {
    if (busy) return false;
    setBusy(action);
    state.setError('');
    try {
      await run();
      await load();
      return true;
    } catch (error) {
      state.setError((error as Error).message);
      return false;
    } finally {
      setBusy('');
    }
  }
  const apply = (operations: unknown[]) =>
    write('apply', () =>
      api(`/chats/${chatId}/outline`, {
        ...(branchId ? { branchId } : {}),
        idempotencyKey: crypto.randomUUID(),
        operations,
      })
    );

  /** Compose then write: the scene command reserves the unit, the existing run path writes it. */
  async function writeUnit(node: OutlineNode) {
    const keys = reserveKeys(node.id);
    const done = await write(`write:${node.id}`, async () => {
      const command = await api<SceneCommand>(
        `/outline-nodes/${node.id}/scene-command`,
        { idempotencyKey: keys.command },
        'POST'
      );
      try {
        await api<Run>(`/scene-commands/${command.id}/run`, {
          expectedRevision: state.branch ? state.branch.headRevision : chat.headRevision,
          expectedSettingsRevision: chat.settingsRevision,
          ...(profileRevision === undefined ? {} : { expectedProfileRevision: profileRevision }),
          idempotencyKey: keys.run,
        });
      } catch (error) {
        // Keep the reserved keys unless the server definitely rejected the request.
        if (
          error instanceof ApiError &&
          error.status >= 400 &&
          error.status !== 408 &&
          error.status < 500
        )
          sessionStorage.removeItem(writeKey(node.id));
        throw error;
      }
      sessionStorage.removeItem(writeKey(node.id));
    });
    if (done) {
      await state.refresh(chatId);
      onClose();
    }
  }

  const actions: EntryActions = {
    busy,
    runActive: !!state.active,
    editing,
    adding,
    drafts,
    setEditing,
    setAdding,
    setDraft: (id, draft) => setDrafts((old) => ({ ...old, [id]: draft })),
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
          busy={busy}
          apply={apply}
          onDone={() => setAdding(null)}
        />
      ) : (
        <button type="button" className="secondary" onClick={() => setAdding('root')}>
          {OUTLINE_LEVEL_LABELS.theme} 추가
        </button>
      )}
      {!!state.active && (
        <p className="muted">원문 생성이 진행 중이에요. 끝나거나 취소한 뒤 집필해 주세요.</p>
      )}
    </section>
  );
}
