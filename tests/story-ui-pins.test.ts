import { expect, test } from 'vitest';
import { latestStoryUiPins, projectStoryUiText } from '../core/story-ui.js';
import { normalizeStoryUiOutput } from '../server/story-ui.js';

const slots = ['status', 'party', 'relations', 'map', 'quest', 'inventory'];

function block(label: string, slot?: string) {
  return `<a2ui>\n${slot ? `$/_uimori/pin = "${slot}"\n` : ''}root = Text("${label}")\n</a2ui>`;
}

function random(seed: number) {
  let state = seed;
  return (limit: number) => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state % limit;
  };
}

test('the board for a scene is the latest block of each slot at or before it', () => {
  const next = random(7);
  for (let round = 0; round < 200; round++) {
    const scenes: { id: string; text: string; blocks: { label: string; slot?: string }[] }[] = [];
    for (let scene = 0; scene < 1 + next(6); scene++) {
      const blocks = Array.from({ length: next(4) }, (_, index) => ({
        label: `r${round}s${scene}b${index}`,
        slot: next(3) ? slots[next(slots.length)] : undefined,
      }));
      const text = normalizeStoryUiOutput(
        ['Prose.', ...blocks.map(({ label, slot }) => block(label, slot))].join('\n\n')
      );
      scenes.push({ id: `scene-${scene}`, text, blocks });
    }
    for (let at = 0; at < scenes.length; at++) {
      const expected = new Map<string, { label: string; position: number }>();
      scenes.slice(0, at + 1).forEach((scene, sceneIndex) => {
        scene.blocks.forEach(({ label, slot }, blockIndex) => {
          if (slot) expected.set(slot, { label, position: sceneIndex * 10 + blockIndex });
        });
      });
      const newest = [...expected.entries()]
        .sort(([, left], [, right]) => right.position - left.position)
        .slice(0, 4);
      const actual = latestStoryUiPins(scenes.slice(0, at + 1));
      expect(actual.map((pin) => pin.slot)).toEqual(newest.map(([slot]) => slot).sort());
      for (const pin of actual)
        expect(pin.segment.expression).toContain(`"${expected.get(pin.slot)!.label}"`);
    }
  }
});

test('a pin name is not shown to summaries or other readers of the block text', () => {
  const text = normalizeStoryUiOutput(block('HP 12', 'status'));
  expect(projectStoryUiText(text)).toContain('HP 12');
  expect(projectStoryUiText(text)).not.toContain('status');
});
