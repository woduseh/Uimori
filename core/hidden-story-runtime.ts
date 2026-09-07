import { validatePromptProgram, type PromptProgram } from './prompt-program.js';
import { HiddenStoryError, validateHiddenStoryConfig, hiddenConfigIssues, type HiddenStoryConfig, type HiddenControlId } from './hidden-story.js';

// Native package contract and per-run assembly. Risu source conversion is agent-owned.
export type HiddenConversionIssue = { code: string; disposition: 'unsupported' | 'changed' | 'source-conflict'; sourceIndex?: number; detail: string };
export type HiddenConversion = {
  format: 'uimori-hidden-story-v1'; status: 'partial'; source: { hash: string; moduleId: string; name: string };
  program: PromptProgram; nonsexualProgram: PromptProgram;
  controlMap: { sourceKey: string; nativeId: HiddenControlId; sourceType: string }[];
  picks: { slot: string; choices: string[] }[]; requiredSlots: string[];
  loreMapping: { sourceIndex: number; blockId: string; insertOrder: number; depth: number | null; enabled: boolean }[];
  issues: HiddenConversionIssue[];
};
const fail = (code: string): never => { throw new HiddenStoryError(code); };

// Stable per-run choice; not cryptographic randomness. Duplicated entries preserve source weights.
function pickIndex(seed: string, length: number): number { let hash = 2166136261; for (const char of seed) { hash ^= char.codePointAt(0)!; hash = Math.imul(hash, 16777619); } return (hash >>> 0) % length; }
export function wireHiddenStoryInstructions(conversion: HiddenConversion, input: unknown, context: { seed: string; userLabel: string }): { program: PromptProgram; values: HiddenStoryConfig['values']; slots: Record<string, string>; choices: Record<string, string>; issues: string[] } {
  const config = validateHiddenStoryConfig(input), issues = hiddenConfigIssues(config);
  if (conversion.format !== 'uimori-hidden-story-v1' || typeof context.seed !== 'string' || !context.seed || context.seed.length > 200 || typeof context.userLabel !== 'string' || !context.userLabel || context.userLabel.length > 200) fail('HIDDEN_WIRE_CONTEXT_INVALID');
  if (issues.includes('HIDDEN_EXTERNAL_POLISH_UNSUPPORTED') || issues.includes('HIDDEN_EXTERNAL_ILLUSTRATION_UNSUPPORTED')) fail(issues.find(issue => issue.endsWith('UNSUPPORTED'))!);
  const program = validatePromptProgram(config.contentPolicy === 'nonsexual' ? conversion.nonsexualProgram : conversion.program), choices: Record<string, string> = {}, slots: Record<string, string> = { 'hidden.user': context.userLabel };
  if (!Array.isArray(conversion.picks) || conversion.picks.length > 50) fail('HIDDEN_PICK_UNSUPPORTED');
  for (const pick of conversion.picks) { if (!/^hidden\.pick\.[0-9]+\.[0-9]+$/u.test(pick.slot) || !Array.isArray(pick.choices) || !pick.choices.length || pick.choices.length > 20 || pick.choices.some(choice => typeof choice !== 'string' || choice.length > 20)) fail('HIDDEN_PICK_UNSUPPORTED'); const value = pick.choices[pickIndex(`${context.seed}:${pick.slot}`, pick.choices.length)]; choices[pick.slot] = value; slots[pick.slot] = value; }
  program.blocks.push({ id: 'hidden.host-contract', title: '히든 창작과 지식 경계', kind: 'message', role: 'system', template: [{ kind: 'text', text: [
    'Hidden stories are creative narrative produced by the main author, not new events invented by auxiliary extraction. Preserve @hsTitle: and @hs delimiters and place hidden stories between main paragraphs. Reader expansion never grants a character knowledge. Unknown actor/knownBy metadata stays unknown; remembered, imagined or believed events are not automatically present world facts. Translate all segments regardless of folding. Never use HTML, CSS or image details as canonical narrative evidence.',
    'Sexual content involving minors is not permitted under any control combination.',
    config.contentPolicy === 'nonsexual' ? 'This attached character combination is nonsexual. Keep narrative, custom themes and imagery nonsexual. Do not convert characters into adults to bypass this boundary.' : 'This is the general-fiction module policy; the separate nonsexual restriction applies only when selected or required by the attached character package.',
    config.values['hidden.imageDensity'] === 4 ? 'Image density is uncontrolled: do not interpret an empty source number as a quota.' : '',
  ].filter(Boolean).join('\n') }] });
  return { program: validatePromptProgram(program), values: structuredClone(config.values), slots, choices, issues: [...conversion.issues.map(issue => issue.code), ...issues] };
}
