import { REQUEST_TEXT_MAX_CHARS } from './content-limits.js';

/** Author-side composition. A plan states what is intended next; it is never story fact. */
export const OUTLINE_LEVELS = ['theme', 'mainStory', 'arc', 'episode', 'beat'] as const;
export type OutlineLevel = (typeof OUTLINE_LEVELS)[number];
export const OUTLINE_LEVEL_LABELS: Record<OutlineLevel, string> = {
  theme: '작품 방향·주제',
  mainStory: '메인 스토리',
  arc: '큰 사건',
  episode: '회차',
  beat: '작은 사건',
};
/** Only these levels name a unit one request writes. Wider levels stay composition-only. */
export const OUTLINE_WRITABLE_LEVELS: readonly OutlineLevel[] = ['episode', 'beat'];
export const outlineLevelIndex = (level: OutlineLevel) => OUTLINE_LEVELS.indexOf(level);
export const outlineParentAllowed = (parent: OutlineLevel | null, child: OutlineLevel) =>
  parent === null || outlineLevelIndex(parent) < outlineLevelIndex(child);

export const OUTLINE_GUIDANCE: Record<OutlineLevel, string> = {
  theme: '원하는 정서, 관계의 속도, 중심 질문이나 결말 방향을 자유롭게 적어요.',
  mainStory: '누구의 이야기인지, 어떤 과정을 거쳐 무엇이 달라질지 적어요.',
  arc: '중요한 전환과 그 전환이 남길 결과를 적어요. 회차 수는 정하지 않아도 돼요.',
  episode: '이번 화의 역할, 인물의 목적, 준비할 요소와 멈출 지점을 적어요.',
  beat: '시도·반응·발견·선택을 적어요. 조용한 대화나 변화 없는 일상도 괜찮아요.',
};

export const outlineWritable = (level: OutlineLevel) => OUTLINE_WRITABLE_LEVELS.includes(level);

export const OUTLINE_TITLE_MAX = 200;
export const OUTLINE_INTENT_MAX = REQUEST_TEXT_MAX_CHARS;

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
  parentId: string | null;
  level: OutlineLevel;
  position: number;
  title: string;
  intent: string;
  /** Author intent to preserve during general revisions, not an absolute editing lock. */
  fixed: boolean;
  revision: number;
  progress: OutlineProgress;
  relatedIds?: string[];
  writings?: OutlineWriting[];
  latestReview?: OutlineReview | null;
  createdAt: string;
  updatedAt: string;
};
export type OutlineWriting = {
  sourceRevision: string;
  sourceHash: string;
  nodeId: string;
  createdAt: string;
};
export type OutlineReview = {
  taskId: string;
  conversationId: string;
  status: string;
  createdAt: string;
  stale: boolean;
  partial: boolean;
  sources: { id: string; hash: string; start: number; end: number; total: number }[];
};
/** Explicit, one-request selection; never inferred from which panel is visible. */
export type OutlineTarget = {
  nodeId: string | null;
  expectedRevision: number | null;
  purpose: 'compose' | 'review';
};
export type OutlineHelperContext = {
  target: OutlineTarget;
  brief: OutlineSnapshot | null;
  sources: (OutlineReview['sources'][number] & { text: string })[];
  partial: boolean;
};

export type OutlineDetail = { chatId: string; nodes: OutlineNode[] };

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
  /** Sibling units already written in this chat, so the request knows what precedes it. */
  written: { id: string; level: OutlineLevel; title: string; sourceRevision: string }[];
  related?: OutlineSnapshotNode[];
  /** Actual existing source references for this unit and its descendants, never planned events. */
  sources?: OutlineWriting[];
  hash: string;
};

/**
 * The disclosure boundary. Upper levels may name an ending or reversal; that text is the author's
 * intent for later units, not something the current scene's characters know or may reveal.
 */
export const OUTLINE_CONTRACT =
  'outline is author-side planning, not a record of events, character knowledge or world facts. path contains upper intent and ends at this request’s target; children are smaller planned events and related contains explicitly linked plans, not extra writing targets. Write only the selected unit and the current request’s scope. Reveal information only when the current unit and viewpoint call for it; do not prematurely reveal later outcomes, but do not indefinitely conceal a revelation scheduled for this unit. sources and written reference actual prose, not proof that every intention was fulfilled: read existing prose before continuing and do not repeat completed passages. A fixed entry is a keep-condition for ordinary elaboration, not an editing lock; honor it unless the user explicitly changes that condition. Preserve the selected writing style and RP agency; do not force conflict, plot advancement, morals or theme statements into quiet scenes.';

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
