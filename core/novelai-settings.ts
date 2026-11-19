/** Browser-safe NovelAI rendering settings, shared by the settings screen and the server. */
export const NOVELAI_SAMPLERS = [
  'k_euler_ancestral',
  'k_euler',
  'k_dpmpp_2s_ancestral',
  'k_dpmpp_2m_sde',
  'k_dpmpp_2m',
  'k_dpmpp_sde',
] as const;
export type NovelAISampler = (typeof NOVELAI_SAMPLERS)[number];
export type NovelAIRenderSettings = {
  model: string;
  width: number;
  height: number;
  steps: number;
  scale: number;
  sampler: NovelAISampler;
  timeoutMs: number;
};
// https://docs.novelai.net/en/subscription (2026-11-20): Opus generations are free up to
// 28 steps at normal sizes; the docs do not define "normal", so this is the largest preset area.
export const NOVELAI_FREE_MAX_STEPS = 28;
export const NOVELAI_FREE_MAX_PIXELS = 1024 * 1024;
export function novelAIUsesAnlas(
  settings: Pick<NovelAIRenderSettings, 'width' | 'height' | 'steps'>
) {
  return (
    settings.steps > NOVELAI_FREE_MAX_STEPS ||
    settings.width * settings.height > NOVELAI_FREE_MAX_PIXELS
  );
}
