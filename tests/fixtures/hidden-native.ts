import { HIDDEN_CONTROL_MAP, defaultHiddenStoryConfig } from '../../core/hidden-story.js';
import type { HiddenConversion } from '../../core/hidden-story-runtime.js';
import type { PromptProgram } from '../../core/prompt-program.js';

/** Declarative synthetic native package: no source-format parser or personal content. */
export function createHiddenNativeFixture(): HiddenConversion {
  const defaults = defaultHiddenStoryConfig();
  const program: PromptProgram = {
    version: 1,
    controls: HIDDEN_CONTROL_MAP.map(([key, name, type, count]) => ({
      id: `hidden.${name}`, label: `Synthetic ${key}`, type, default: defaults.values[`hidden.${name}`],
      ...(type === 'select' ? { options: Array.from({ length: count }, (_, value) => ({ label: `choice${value}`, value })) } : {}),
    })),
    blocks: [
      { id: 'hidden.lore.0', title: 'Synthetic creative', kind: 'message', role: 'system', enabled: true, template: [
        { kind: 'if', condition: { op: 'equal', args: [{ control: 'hidden.enabled' }, 0] }, then: [
          { kind: 'text', text: 'SYNTHETIC_DUAL ' }, { kind: 'slot', name: 'hidden.user' },
          { kind: 'text', text: ': ' }, { kind: 'slot', name: 'hidden.pick.0.0' }, { kind: 'text', text: ' blocks. ' },
          { kind: 'if', condition: { op: 'all', args: [
            { op: 'notEqual', args: [{ control: 'hidden.customTheme' }, null] },
            { op: 'greater', args: [{ op: 'length', args: [{ control: 'hidden.customTheme' }] }, 0] },
          ] }, then: [{ kind: 'text', text: 'Theme=' }, { kind: 'value', expression: { control: 'hidden.customTheme' } }] },
        ] },
      ] },
      { id: 'hidden.lore.2', title: 'Synthetic independent addon', kind: 'message', role: 'system', enabled: true, template: [
        { kind: 'if', condition: { op: 'equal', args: [{ control: 'hidden.badOutcomes' }, true] }, then: [{ kind: 'text', text: 'SYNTHETIC_ALLOW_LOSS' }] },
      ] },
      { id: 'hidden.lore.8', title: 'Synthetic external activation', kind: 'message', role: 'system', enabled: false, template: [{ kind: 'text', text: 'SYNTHETIC_EXTERNAL_ONLY' }] },
    ],
  };
  return {
    format: 'uimori-hidden-story-v1', status: 'partial', source: { hash: 'a'.repeat(64), moduleId: 'synthetic-module', name: 'Synthetic Hidden Pack' },
    program, nonsexualProgram: structuredClone(program),
    controlMap: HIDDEN_CONTROL_MAP.map(([sourceKey, name, sourceType]) => ({ sourceKey, nativeId: `hidden.${name}`, sourceType })),
    picks: [{ slot: 'hidden.pick.0.0', choices: ['two', 'two', 'three'] }], requiredSlots: ['hidden.user', 'hidden.pick.0.0'],
    loreMapping: [
      { sourceIndex: 0, blockId: 'hidden.lore.0', insertOrder: 2000, depth: 0, enabled: true },
      { sourceIndex: 2, blockId: 'hidden.lore.2', insertOrder: 4000, depth: null, enabled: true },
      { sourceIndex: 8, blockId: 'hidden.lore.8', insertOrder: 100, depth: null, enabled: false },
    ],
    issues: [{ code: 'HIDDEN_EXTERNAL_LORE_ACTIVATION', disposition: 'unsupported', sourceIndex: 8, detail: 'Synthetic inactive fragment stays disabled.' }],
  };
}
