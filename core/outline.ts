import { createHash } from 'node:crypto';

/** Author-side composition. A plan states what is intended next; it is never story fact. */
export const OUTLINE_LEVELS = ['theme', 'mainStory', 'arc', 'episode', 'beat'] as const;
export type OutlineLevel = (typeof OUTLINE_LEVELS)[number];
export const OUTLINE_LEVEL_LABELS: Record<OutlineLevel, string> = {
  theme: '전체 주제',
  mainStory: '메인 스토리',
  arc: '큰 사건',
  episode: '회차',
  beat: '작은 사건',
};
/** Only these levels name a unit one request writes. Wider levels stay composition-only. */
export const OUTLINE_WRITABLE_LEVELS: readonly OutlineLevel[] = ['episode', 'beat'];
export const outlineLevelIndex = (level: OutlineLevel) => OUTLINE_LEVELS.indexOf(level);
export const outlineParentLevel = (level: OutlineLevel): OutlineLevel | null =>
  level === 'theme' ? null : OUTLINE_LEVELS[outlineLevelIndex(level) - 1];
export const outlineChildLevel = (level: OutlineLevel): OutlineLevel | null =>
  level === 'beat' ? null : OUTLINE_LEVELS[outlineLevelIndex(level) + 1];
export const outlineWritable = (level: OutlineLevel) => OUTLINE_WRITABLE_LEVELS.includes(level);

export const OUTLINE_TITLE_MAX = 200;
export const OUTLINE_INTENT_MAX = 4000;

/**
 * Progress is derived from the bound scene command and its committed source, never stored.
 * A plan alone never counts as written.
 */
export type OutlineProgress = {
  state: 'planned' | 'scheduled' | 'writing' | 'written' | 'failed' | 'cancelled';
  commandId: string | null;
  runId: string | null;
  sourceRevision: string | null;
};
export type OutlineNode = {
  id: string;
  chatId: string;
  branchId: string;
  parentId: string | null;
  level: OutlineLevel;
  position: number;
  title: string;
  intent: string;
  /** A user-pinned condition. Model-driven writes surface a conflict instead of overwriting it. */
  fixed: boolean;
  revision: number;
  progress: OutlineProgress;
  createdAt: string;
  updatedAt: string;
};
export type OutlineDetail = { chatId: string; branchId: string; nodes: OutlineNode[] };

/** Frozen composition for one writing run: the applied upper intent and the target's own plan. */
export type OutlineSnapshotNode = {
  id: string;
  level: OutlineLevel;
  title: string;
  intent: string;
  fixed: boolean;
  revision: number;
};
export type OutlineSnapshot = {
  version: 1;
  /** Root to target; the last entry is the unit being written. */
  path: OutlineSnapshotNode[];
  /** The target's direct children only; deeper levels stay out of one request's input. */
  children: OutlineSnapshotNode[];
  /** Sibling units already written on this branch, so the request knows what precedes it. */
  written: { id: string; level: OutlineLevel; title: string; sourceRevision: string }[];
  hash: string;
};

/**
 * The disclosure boundary. Upper levels may name an ending or reversal; that text is the author's
 * intent for later units, not something the current scene's characters know or may reveal.
 */
export const OUTLINE_CONTRACT =
  'outline is the author-side composition for this unit: path holds the upper intent, children the smaller events planned inside it. It is planning, not story that already happened, not a character memory, and not a world fact. Write only the unit named by the last path entry. Later units and any ending or reversal named in an upper level stay unrevealed until their own unit is written. A fixed entry is a user-pinned condition to honor.';

/** Seal what was actually frozen, so a later read can tell the applied composition apart. */
export const sealOutlineSnapshot = (outline: Omit<OutlineSnapshot, 'hash'>): OutlineSnapshot => ({
  ...outline,
  hash: createHash('sha256').update(JSON.stringify(outline)).digest('hex'),
});

export const outlineSnapshotNode = (node: OutlineNode): OutlineSnapshotNode => ({
  id: node.id,
  level: node.level,
  title: node.title,
  intent: node.intent,
  fixed: node.fixed,
  revision: node.revision,
});

export function outlineTree(nodes: readonly OutlineNode[]): OutlineNode[] {
  const children = new Map<string | null, OutlineNode[]>();
  for (const node of nodes) {
    const list = children.get(node.parentId) ?? [];
    list.push(node);
    children.set(node.parentId, list);
  }
  for (const list of children.values())
    list.sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  const ordered: OutlineNode[] = [];
  const walk = (parentId: string | null) => {
    for (const node of children.get(parentId) ?? []) {
      ordered.push(node);
      walk(node.id);
    }
  };
  walk(null);
  return ordered;
}
