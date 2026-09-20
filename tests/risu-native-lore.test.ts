import { expect, test } from 'vitest';
import { defaultProfile } from '../core/product.js';
import type { RunSnapshot } from '../core/types.js';
import { buildMainInput, pinnedSlotSources } from '../core/provider.js';
import { compileSnapshotPrompt } from '../server/prompt-snapshot.js';
import { prepareNativeRisuRun } from '../server/risu-native-run.js';
import { analyzeNativeRisuImport } from '../server/risu-native-import.js';
import { readCharacterCard } from '../server/character-card-file.js';
import { createDefaultRisuPrompt } from '../core/prompt-defaults.js';
import { DEFAULT_LORE_CONTEXT } from '../core/lore-context.js';
import { basename } from 'node:path';
import { readFileSync } from 'node:fs';

const entry = (content: string, order = 0, constant = true) => ({
  name: content.split('\n').at(-1),
  content,
  insertion_order: order,
  constant,
  keys: ['test'],
});
async function fixture(
  entries = [
    entry('@@depth 0\nEND'),
    entry('@@depth 2\n@@role user\nMID'),
    entry('@@reverse_depth 1\n@@role assistant\nREVERSE'),
    entry('NORMAL'),
  ]
) {
  const input = readCharacterCard({
    name: 'native.json',
    base64: Buffer.from(
      JSON.stringify({ name: 'Native', description: 'BOT', character_book: { entries } })
    ).toString('base64'),
  });
  const analysis = analyzeNativeRisuImport(input),
    pkg = analysis.file.contents[0].source.package!;
  const snapshot: RunSnapshot = {
    chatId: 'native-lore',
    parentRevision: null,
    settingsRevision: 1,
    settings: { preset: 'calm', mode: 'direct', maxCalls: 4, translation: false, status: false },
    request: 'CURRENT',
    history: [
      { revision: 's1', text: 'H1' },
      { revision: 's2', text: 'H3' },
    ],
    resources: [],
    logicalHistory: [
      { id: 'h0', role: 'user', text: 'H0' },
      { id: 'h1', role: 'assistant', text: 'H1' },
      { id: 'h2', role: 'user', text: 'H2' },
      { id: 'h3', role: 'assistant', text: 'H3' },
    ],
    profile: {
      ...defaultProfile('native-lore'),
      models: {},
      packages: [pkg],
      packageAttachments: [{ id: pkg.id, revision: pkg.revision, role: 'bot' }],
    },
  };
  return { snapshot: await prepareNativeRisuRun(snapshot), analysis };
}

test('native depth/end/reverse-depth preserve role and position once while normal lore keeps its slot', async () => {
  const { snapshot, analysis } = await fixture();
  expect(
    analysis.preview.findings.filter((item) =>
      ['lore-decorator:depth', 'lore-decorator:role', 'lore-decorator:reverse_depth'].includes(
        item.code
      )
    )
  ).toEqual([]);
  const input = buildMainInput(snapshot);
  expect(input.pinnedSources!.filter((item) => item.nativeRisuPosition)).toHaveLength(3);
  expect(
    pinnedSlotSources(input, 'backgroundLore')
      .map((item) => item.text)
      .join('\n')
  ).not.toContain('END');
  const compiled = compileSnapshotPrompt(snapshot).promptCompilation!;
  const messages = compiled.messages.map((message) => ({
    id: message.id,
    role: message.role,
    text: message.content.map((part) => part.text).join(''),
  }));
  const exact = (value: string) => messages.findIndex((message) => message.text === value);
  expect(exact('MID')).toBeGreaterThan(exact('H1'));
  expect(exact('MID')).toBeLessThan(exact('H2'));
  expect(messages[exact('MID')].role).toBe('user');
  expect(exact('REVERSE')).toBeGreaterThan(exact('H3'));
  expect(exact('REVERSE')).toBeLessThan(exact('CURRENT'));
  expect(messages[exact('REVERSE')].role).toBe('assistant');
  expect(exact('END')).toBe(messages.length - 1);
  for (const value of ['END', 'MID', 'REVERSE']) {
    expect(messages.filter((message) => message.text === value)).toHaveLength(1);
    expect(
      messages
        .filter((message) => message.id.startsWith('__host_'))
        .map((message) => message.text)
        .join('\n')
    ).not.toContain(`"text":"${value}"`);
  }
  expect(messages.map((message) => message.text).join('\n')).toContain('NORMAL');
  expect(buildMainInput(snapshot).catalog.some((item) => item.id.includes('lore-0'))).toBe(true);
});

test('conditional native positions use frozen lore selection and pinned budgets without retired prefill', async () => {
  const { snapshot } = await fixture([
    entry('@@end\nPINNED'),
    entry('@@depth 1\nCONDITIONAL', 2, false),
  ]);
  const attachment = snapshot.profile!.packageAttachments![0];
  const before = compileSnapshotPrompt(snapshot).promptCompilation!;
  expect(before.messages.some((message) => message.content[0].text === 'CONDITIONAL')).toBe(false);
  snapshot.loreSelection = {
    version: 1,
    entries: [
      {
        key: `${attachment.id}@1:bot`,
        inputHash: 'a'.repeat(64),
        budget: 1000,
        selected: ['lore-1'],
        omitted: [],
      },
    ],
  };
  const program = createDefaultRisuPrompt('SYSTEM');
  program.nativeRisuPreset.preset.promptSettings = { assistantPrefill: 'PREFIX' };
  const after = compileSnapshotPrompt(snapshot, program).promptCompilation!;
  expect(after.messages.some((message) => message.content[0].text === 'CONDITIONAL')).toBe(true);
  expect(after.messages.at(-1)).toMatchObject({
    completion: 'complete',
    content: [{ text: 'PINNED' }],
  });
  expect(after.messages.some((message) => message.content[0].text === 'PREFIX')).toBe(false);
  snapshot.profile!.loreContext = { ...DEFAULT_LORE_CONTEXT, maxPinnedChars: 2 };
  expect(() => compileSnapshotPrompt(snapshot)).toThrow('LORE_PINNED_BUDGET_EXCEEDED');
});

test('other native placement directives remain reported instead of pretending to support them', async () => {
  const { analysis } = await fixture([
    entry('@@position after_desc\nCUSTOM'),
    entry('@@inject_at system\nINJECT'),
  ]);
  expect(
    analysis.preview.findings.some(
      (item) => item.code === 'lore-decorator:position' && item.level === 'unsupported'
    )
  ).toBe(true);
  expect(
    analysis.preview.findings.some(
      (item) => item.code === 'lore-decorator:inject_at' && item.level === 'unsupported'
    )
  ).toBe(true);
});

test.runIf(Boolean(process.env.UIMORI_RISU_LOCAL_CARDS))(
  'local cards retain their actual depth metadata without unsupported depth findings',
  () => {
    for (const path of JSON.parse(process.env.UIMORI_RISU_LOCAL_CARDS!) as string[]) {
      const { file, preview } = analyzeNativeRisuImport(
        readCharacterCard({ name: basename(path), uploadId: 'local-lore' }, undefined, () =>
          readFileSync(path)
        )
      );
      expect(
        preview.findings.some(
          (item) => item.code === 'lore-decorator:depth' && item.level === 'unsupported'
        )
      ).toBe(false);
      const depths = file.contents[0].source.package!.lore.flatMap((item) =>
        item.nativeRisuPosition ? [item.nativeRisuPosition.depth] : []
      );
      if (basename(path).startsWith('Cheongwon')) expect(depths).toEqual([0]);
      if (basename(path).startsWith('Fujimiya')) expect(depths).toEqual([4, 0]);
    }
  },
  60_000
);
