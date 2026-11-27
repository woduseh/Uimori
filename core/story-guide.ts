import { STORY_GUIDE_LIMITS } from '#contracts';
export type StoryGuideConfig = {
  enabled: boolean;
  work: string;
  reference: string;
  position: string;
  followCanon: boolean;
  webSearch: boolean;
};
export type StoryGuideBrief = {
  fingerprint: string;
  text: string;
  createdAt: string;
  parentRevision: string | null;
  configRevision: number;
  runId?: string;
  modelTitle: string;
  webSearch?: import('./helper-web-search.js').ProviderWebSearch;
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
  brief?: StoryGuideBrief;
  error?: string;
};
export { STORY_GUIDE_LIMITS };
export const defaultStoryGuideConfig = (): StoryGuideConfig => ({
  enabled: false,
  work: '',
  reference: '',
  position: '',
  followCanon: false,
  webSearch: false,
});

export function normalizeStoryGuideConfig(value: unknown): StoryGuideConfig {
  const input = value as StoryGuideConfig | null;
  if (
    !input ||
    Array.isArray(input) ||
    typeof input.enabled !== 'boolean' ||
    typeof input.followCanon !== 'boolean' ||
    (input.webSearch !== undefined && typeof input.webSearch !== 'boolean') ||
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
    webSearch: input.webSearch ?? false,
  };
}
