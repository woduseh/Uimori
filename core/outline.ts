import {
  OUTLINE_INTENT_MAX,
  OUTLINE_LEVELS,
  OUTLINE_TITLE_MAX,
  OUTLINE_WRITING_ORIGINS,
  type OutlineDetail,
  type OutlineFocus,
  type OutlineLevel,
  type OutlineNode,
  type OutlineProgress,
  type OutlineWriting,
  type OutlineWritingOrigin,
} from '#contracts';

export {
  OUTLINE_INTENT_MAX,
  OUTLINE_LEVELS,
  OUTLINE_TITLE_MAX,
  OUTLINE_WRITING_ORIGINS,
  type OutlineDetail,
  type OutlineFocus,
  type OutlineLevel,
  type OutlineNode,
  type OutlineProgress,
  type OutlineWriting,
  type OutlineWritingOrigin,
};
export const OUTLINE_LEVEL_LABELS: Record<OutlineLevel, string> = {
  theme: '작품 방향과 주제',
  mainStory: '메인 스토리',
  arc: '큰 사건',
  episode: '회차',
  beat: '작은 사건',
};
export const OUTLINE_WRITABLE_LEVELS: readonly OutlineLevel[] = ['episode', 'beat'];
export const outlineLevelIndex = (level: OutlineLevel) => OUTLINE_LEVELS.indexOf(level);
export const outlineParentAllowed = (parent: OutlineLevel | null, child: OutlineLevel) =>
  parent === null || outlineLevelIndex(parent) < outlineLevelIndex(child);

export const outlineWritable = (level: OutlineLevel) => OUTLINE_WRITABLE_LEVELS.includes(level);

export type OutlineTarget = {
  nodeId: string | null;
  expectedRevision: number | null;
  purpose: 'compose' | 'review';
};
export type OutlineHelperContext = {
  target: OutlineTarget;
  brief: import('./transport.js').Json | null;
  sources: { id: string; hash: string; start: number; end: number; total: number; text: string }[];
  partial: boolean;
};

export type OutlineSnapshotNode = {
  id: string;
  level: OutlineLevel;
  title: string;
  intent: string;
  fixed: boolean;
  revision: number;
};
export type OutlineNeighbors = { previous?: OutlineSnapshotNode; next?: OutlineSnapshotNode };
export const OUTLINE_NEIGHBOR_INTENT_MAX = 600;

export type OutlineSnapshot = {
  version: 1;
  focus?: true;
  path: OutlineSnapshotNode[];
  children: OutlineSnapshotNode[];
  written: { id: string; level: OutlineLevel; title: string; sourceRevision: string }[];
  related?: OutlineSnapshotNode[];
  neighbors?: OutlineNeighbors;
  sources?: OutlineWriting[];
  hash: string;
};

export const OUTLINE_CONTRACT =
  'outline is author-side planning, not a record of events, character knowledge or world facts. path contains upper intent and ends at this request’s target; children are smaller planned events and related contains explicitly linked plans, not extra writing targets. Write only the selected unit and the current request’s scope. Reveal information only when the current unit and viewpoint call for it; do not prematurely reveal later outcomes, but do not indefinitely conceal a revelation scheduled for this unit. sources and written reference actual prose, not proof that every intention was fulfilled: read existing prose before continuing and do not repeat completed passages. A fixed entry is a keep-condition for ordinary elaboration, not an editing lock; honor it unless the user explicitly changes that condition. Preserve the selected writing style and RP agency; do not force conflict, plot advancement, morals or theme statements into quiet scenes. neighbors.previous and neighbors.next are the adjacent planned units, not writing targets: continue from where previous left off and stop before the events planned for next begin.';

export const OUTLINE_FOCUS_CONTRACT =
  'outline.focus is true: the target is the unit the story is currently in, not a unit this request must write. The current user request decides what happens in this response; use path, children and neighbors to keep pacing, continuity and planned direction in view. Do not rush through the remaining children or move into neighbors.next unless the request leads there.';

export const outlineContract = (outline: Pick<OutlineSnapshot, 'focus'>) =>
  outline.focus ? `${OUTLINE_CONTRACT}\n${OUTLINE_FOCUS_CONTRACT}` : OUTLINE_CONTRACT;

export const outlineSnapshotNode = (
  node: OutlineNode,
  intentMax?: number
): OutlineSnapshotNode => ({
  id: node.id,
  level: node.level,
  title: node.title,
  intent:
    intentMax === undefined || node.intent.length <= intentMax
      ? node.intent
      : `${node.intent.slice(0, intentMax)}…`,
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
