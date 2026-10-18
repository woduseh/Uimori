/** Per-chat authoring preference. A guide is derived advice, never another story memory. */
export type StoryGuideConfig = {
  enabled: boolean;
  work: string;
  reference: string;
  position: string;
  followCanon: boolean;
};
export type StoryGuideBrief = {
  fingerprint: string;
  text: string;
  createdAt: string;
  parentRevision: string | null;
  configRevision: number;
  runId?: string;
  modelTitle: string;
};
export type StoryGuideState = {
  revision: number;
  config: StoryGuideConfig;
  brief: StoryGuideBrief | null;
};
export type StoryGuideDetail = StoryGuideState & {
  latestRun?: { status: string; used: boolean; error?: string };
};
export type StoryGuideSnapshot = Pick<StoryGuideState, 'revision' | 'config'> & {
  /** Only the brief selected for this execution; never treated as established story facts. */
  brief?: StoryGuideBrief;
  error?: string;
};
export const STORY_GUIDE_LIMITS = { work: 500, reference: 20_000, position: 2_000 } as const;
export const defaultStoryGuideConfig = (): StoryGuideConfig => ({
  enabled: false,
  work: '',
  reference: '',
  position: '',
  followCanon: false,
});

export function normalizeStoryGuideConfig(value: unknown): StoryGuideConfig {
  const input = value as StoryGuideConfig | null;
  if (
    !input ||
    Array.isArray(input) ||
    typeof input.enabled !== 'boolean' ||
    typeof input.followCanon !== 'boolean' ||
    Object.entries(STORY_GUIDE_LIMITS).some(([key, limit]) => {
      const text = input[key as keyof typeof STORY_GUIDE_LIMITS];
      return typeof text !== 'string' || text.length > limit;
    })
  )
    throw Object.assign(new Error('Invalid story guide settings'), { statusCode: 400 });
  return {
    enabled: input.enabled,
    work: input.work,
    reference: input.reference,
    position: input.position,
    followCanon: input.followCanon,
  };
}
