import { KNOWLEDGE_TOOL_NAMES, SKILL_TOOL_NAMES } from './read-tools.js';
import { STORY_READ_TOOLS } from './story-read-tools.js';
import { TRANSLATION_READ_NAMES } from './translation-context.js';
import type { Resource, RunSnapshot } from './types.js';

export const CATALOG_READ_GUIDANCE =
  'The catalog lists summaries of references whose full text is not in the input. When an entry bears on this request, read its full text first: fetch known ids with knowledge.read({ids:[...]}), using a one-item array for a single reference, and request independently needed references together. Wait for earlier results only when they decide the next read. References already delivered in full need no second read. Use knowledge.search when the catalog does not identify the entry you need: exact names favor normal search, mode=relevant ranks lexical matches, and mode=browse follows package/folder structure when vocabulary differs. Follow returned nextRead references; folder metadata is not evidence that the underlying text was read.';

export const READ_FAMILIES = ['knowledge', 'skills', 'story', 'translation'] as const;
export type ReadFamily = (typeof READ_FAMILIES)[number];
const FAMILY_TOOLS: Record<ReadFamily, readonly string[]> = {
  knowledge: KNOWLEDGE_TOOL_NAMES,
  skills: SKILL_TOOL_NAMES,
  story: STORY_READ_TOOLS.map((tool) => tool.name),
  translation: TRANSLATION_READ_NAMES,
};

export type ReadScope = {
  references: readonly Resource[];
  deliveredReferences: ReadonlySet<string>;
  scenes: RunSnapshot['history'];
  deliveredScenes: ReadonlySet<string>;
  translations?: number;
};
export type ReadAccess = {
  families: ReadFamily[];
  tools: string[];
  catalog: Resource[];
  guidance: string[];
};

export function readAccess(scope: ReadScope, requested: readonly ReadFamily[]): ReadAccess {
  const unread = scope.references.filter((item) => !scope.deliveredReferences.has(item.id));
  const available: Record<ReadFamily, boolean> = {
    knowledge: unread.some((item) => item.kind !== 'skill'),
    skills: unread.some((item) => item.kind === 'skill'),
    story: scope.scenes.some(
      (scene) =>
        scene.sceneContext?.sceneEnabled !== false && !scope.deliveredScenes.has(scene.revision)
    ),
    translation: (scope.translations ?? 0) > 0,
  };
  const families = READ_FAMILIES.filter(
    (family) => requested.includes(family) && available[family]
  );
  return {
    families,
    tools: families.flatMap((family) => FAMILY_TOOLS[family]),
    catalog: unread.filter((item) =>
      families.includes(item.kind === 'skill' ? 'skills' : 'knowledge')
    ),
    guidance: families.includes('knowledge') ? [CATALOG_READ_GUIDANCE] : [],
  };
}
