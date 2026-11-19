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
/** One character box: NovelAI conditions it separately from the shared scene prompt. */
export type NovelAICharacterPrompt = {
  prompt: string;
  negativePrompt: string;
  /** Normalized canvas center; absent leaves placement to NovelAI. */
  position?: { x: number; y: number };
};
// https://docs.novelai.net/en/image/multiplecharacters (2026-11-20): V4 and V4.5 accept six
// character prompts and V5 twenty-two; the lower limit keeps one contract for every model.
export const NOVELAI_MAX_CHARACTERS = 6;
// https://docs.novelai.net/en/subscription (2026-11-20): Opus generations are free up to
// 28 steps at normal sizes; the docs do not define "normal", so this is the largest preset area.
export const NOVELAI_FREE_MAX_STEPS = 28;
export const NOVELAI_FREE_MAX_PIXELS = 1024 * 1024;
// https://docs.novelai.net/en/image/precisereference (2026-11-20): Precise Reference is
// V4.5-only and adds 5 Anlas per reference image to every generation.
export const NOVELAI_REFERENCE_ANLAS = 5;
export function novelAISupportsCharacterReference(model: string): boolean {
  return /^nai-diffusion-4-5-/u.test(model);
}
/** Account balances from GET /user/subscription; the generation endpoint reports none. */
export type NovelAIAccount = {
  tier: 'Paper' | 'Tablet' | 'Scroll' | 'Opus' | null;
  active: boolean;
  anlas: { subscription: number; purchased: number } | null;
  /** The Opus V5 usage bar, refilled continuously. */
  usage: { percent: number; secondsUntilNextPercent: number } | null;
};
export function novelAIUsesAnlas(
  settings: Pick<NovelAIRenderSettings, 'width' | 'height' | 'steps'>
) {
  return (
    settings.steps > NOVELAI_FREE_MAX_STEPS ||
    settings.width * settings.height > NOVELAI_FREE_MAX_PIXELS
  );
}
