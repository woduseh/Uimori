import { expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import {
  serializeRisuContextSource,
  serializeRisuLoreSources,
  serializePositionedRisuLore,
  type RisuContextSource,
  RISU_SOURCE_GUIDANCE,
} from '../core/risu-context-source.js';
import { compileContentAttachment } from '../core/package-runtime.js';
import { defaultProfile } from '../core/product.js';
import { buildMainInput } from '../core/provider.js';
import type { RunSnapshot } from '../core/types.js';
import { nativePromptSlots } from '../server/native-prompt-slots.js';
import { projectNativeRisuPackage } from '../server/risu-native-projection.js';
import { prepareNativeRisuRun } from '../server/risu-native-run.js';
import { compileSnapshotPrompt } from '../server/prompt-snapshot.js';
import { nativeContent } from './fixtures/native-content.js';
import { validateRisuPrompt } from '../core/risu-prompt.js';
import {
  createNativeRisuPresetProgram,
  evaluatedNativeRisuPreset,
  nativeRisuPresetFields,
} from '../core/risu-native-preset.js';
import { evaluateNativeRisuFields } from '../server/risu-native-cbs.js';
import pheme from '../server/builtin-prompts/pheme.json' with { type: 'json' };
import defaults from '../server/builtin-prompts/pheme-options.json' with { type: 'json' };

const source = (overrides: Partial<RisuContextSource> = {}): RisuContextSource => ({
  sourceRole: 'persona',
  sourceName: 'Traveler',
  contentId: 'traveler',
  ...overrides,
});

test('source attributes escape delimiters while authored body remains byte-for-byte intact', () => {
  const item = {
    text: '  {{user}}\n<b>Authored & unchanged</b>\n ',
    risuSource: source({ sourceName: 'A "quote" & <tag> > end', contentId: 'a&"<b>' }),
  };
  const before = structuredClone(item);
  const result = serializeRisuContextSource(item);
  expect(result).toContain('<uimori_source ');
  expect(result).toContain('source_role="persona"');
  expect(result).toContain('source_name="A &quot;quote&quot; &amp; &lt;tag&gt; &gt; end"');
  expect(result).toContain('content_id="a&amp;&quot;&lt;b&gt;"');
  expect(result).not.toContain('authority=');
  expect(result).toContain(item.text);
  expect(result).toContain('</uimori_source>');
  expect(item).toEqual(before);
});

test('empty source bodies produce no orphan source or lore wrappers', () => {
  for (const text of ['', ' \n\t ']) {
    const item = { text, risuSource: source({ entryId: 'empty', title: 'Empty' }) };
    expect(serializeRisuContextSource(item)).toBe('');
    expect(serializeRisuLoreSources([item])).toBe('');
    expect(serializePositionedRisuLore(item)).toBe('');
  }
  expect(serializeRisuLoreSources([])).toBe('');
});

test('same-title lore keeps distinct sources, entry boundaries, and input order without mutation', () => {
  const items = ['bot', 'persona', 'module'].flatMap((role) =>
    [0, 1].map((index) => ({
      text: `${role} authored body ${index}`,
      risuSource: source({
        sourceRole: role,
        sourceName: 'Same title',
        contentId: `${role}-card`,
        entryId: `entry-${index}`,
        title: 'Same lore title',
      }),
    }))
  );
  const before = structuredClone(items);
  const result = serializeRisuLoreSources(items);
  expect(result).toContain('<uimori_lore_sources>');
  expect(result.match(/<source /gu)).toHaveLength(3);
  expect(result.match(/<entry /gu)).toHaveLength(6);
  for (const role of ['bot', 'persona', 'module']) {
    expect(result).toContain(`source_role="${role}"`);
    expect(result).toContain(`content_id="${role}-card"`);
  }
  const indices = items.map((item) => result.indexOf(item.text));
  expect(indices.every((index) => index >= 0)).toBe(true);
  expect(indices).toEqual([...indices].sort((a, b) => a - b));
  expect(serializeRisuLoreSources(items)).toBe(result);
  expect(items).toEqual(before);
});

test('positioned lore includes its own source and escaped entry identity', () => {
  const item = {
    text: 'POSITIONED {{char}}\nOriginal lore',
    risuSource: source({ entryId: 'entry"<&', title: 'Title "<&>' }),
  };
  const result = serializePositionedRisuLore(item);
  expect(result).toContain('source_role="persona"');
  expect(result).toContain('content_id="traveler"');
  expect(result).toContain('entry_id="entry&quot;&lt;&amp;"');
  expect(result).toContain('title="Title &quot;&lt;&amp;&gt;"');
  expect(result).not.toContain('knowledge_scope=');
  expect(result).toContain(item.text);
});

test('CHARX-shaped bot, persona, and native module retain provenance through resources, input, and slots', async () => {
  const roles = ['bot', 'persona', 'module'] as const;
  const packages = roles.map((role) =>
    nativeContent(
      {
        name: `${role} source`,
        description: role === 'module' ? '' : `${role} description`,
        character_book: {
          entries: [{ keys: [], comment: 'Shared title', content: `${role} lore`, constant: true }],
        },
      },
      { id: `${role}-card` }
    )
  );
  packages[2] = projectNativeRisuPackage(
    {
      ...packages[2],
      nativeRisu: {
        ...packages[2].nativeRisu,
        card: {},
        module: {
          name: 'module source',
          lorebook: [
            { key: '', comment: 'Shared title', content: 'module lore', alwaysActive: true },
            {
              key: '',
              comment: 'Positioned module lore',
              content: '@@depth 0\n@@role user\nMODULE_POSITIONED',
              alwaysActive: true,
            },
          ],
        },
      },
    },
    'module'
  ).pkg;
  const attachments = packages.map((pkg, index) => ({
    id: pkg.id,
    revision: pkg.revision,
    role: roles[index],
  }));
  const authored: RunSnapshot = {
    chatId: 'source-pipeline',
    parentRevision: null,
    settingsRevision: 1,
    settings: { maxCalls: 4, status: false },
    request: 'Continue',
    history: [],
    resources: [],
    profile: {
      ...defaultProfile('source-pipeline'),
      models: {},
      packages,
      packageAttachments: attachments,
    },
  };
  const original = structuredClone(authored);
  const snapshot = await prepareNativeRisuRun(authored);
  const before = structuredClone(snapshot);
  const input = buildMainInput(snapshot);
  const slots = nativePromptSlots(snapshot);
  for (const [index, pkg] of packages.entries()) {
    const role = roles[index];
    const expected = {
      sourceRole: role,
      sourceName: `${role} source`,
      contentId: pkg.id,
      entryId: pkg.lore[0].id,
      title: 'Shared title',
    };
    const resources = compileContentAttachment(pkg, attachments[index], {
      chatId: snapshot.chatId,
    }).resources;
    expect(resources.find((item) => item.text === `${role} lore`)?.risuSource).toEqual(expected);
    expect(input.pinnedSources?.find((item) => item.text === `${role} lore`)?.risuSource).toEqual(
      expected
    );
    expect(slots.lore).toContain(`source_role="${role}"`);
    expect(slots.lore).toContain(`content_id="${pkg.id}"`);
    expect(slots.lore.split(`${role} lore`)).toHaveLength(2);
  }
  expect(slots.description).toContain('source_role="bot"');
  expect(slots.persona).toContain('source_role="persona"');
  expect(slots.persona).toContain('persona description');
  expect(slots.lorebook).toBe(slots.lore);
  expect(nativePromptSlots(snapshot)).toEqual(slots);
  expect(slots.lore).not.toContain('MODULE_POSITIONED');
  const compiled = compileSnapshotPrompt(snapshot).promptCompilation!;
  const positioned = compiled.messages.filter((message) =>
    message.content.some((part) => part.text.includes('MODULE_POSITIONED'))
  );
  expect(positioned).toHaveLength(1);
  expect(positioned[0].role).toBe('user');
  expect(positioned[0].content[0].text).toContain('source_role="module"');
  expect(positioned[0].content[0].text).toContain('title="Positioned module lore"');
  expect(compiled.messages.at(-1)).toEqual(positioned[0]);
  const synthetic = createNativeRisuPresetProgram({
    version: 1,
    preset: {
      promptTemplate: [
        { type: 'plain', role: 'system', text: 'Synthetic source composition' },
        { type: 'description', innerFormat: '<character>{{slot}}</character>' },
        { type: 'persona', innerFormat: '<player>{{slot}}</player>' },
        { type: 'lorebook' },
        { type: 'chat', rangeStart: 0, rangeEnd: 'end' },
      ],
    },
  });
  for (const program of [synthetic, validateRisuPrompt(pheme)]) {
    const presetBefore = structuredClone(program);
    const fields = await evaluateNativeRisuFields({
      native: {
        version: 1,
        sourceHash: createHash('sha256').update(JSON.stringify(program)).digest('hex'),
        assets: [],
        card: { name: 'bot source', extensions: { risuai: {} } },
      },
      fields: nativeRisuPresetFields(program.nativeRisuPreset),
      context: {
        variables: {},
        globalVariables: Object.fromEntries(
          Object.entries(defaults).map(([key, value]) => [
            `toggle_${key}`,
            value === null ? 'null' : String(value),
          ])
        ),
        charName: 'bot source',
        userName: 'persona source',
        messages: [],
      },
    });
    expect(fields.issues.filter((issue) => issue !== 'slot')).toEqual([]);
    const rendered = compileSnapshotPrompt(
      snapshot,
      {
        ...program,
        nativeRisuPreset: evaluatedNativeRisuPreset(program.nativeRisuPreset, fields.fields),
      },
      program === synthetic ? undefined : defaults
    ).promptCompilation!;
    const text = rendered.messages
      .flatMap((message) => message.content.map((part) => part.text))
      .join('\n');
    for (const slot of [slots.description, slots.persona, slots.lorebook]) {
      expect(text).toContain(slot);
      expect(text.split(slot)).toHaveLength(2);
    }
    expect(text.split(RISU_SOURCE_GUIDANCE)).toHaveLength(2);
    expect(text.split('MODULE_POSITIONED')).toHaveLength(2);
    expect(rendered.messages.some((message) => message.id === '__host_background_lore__')).toBe(
      false
    );
    expect(program).toEqual(presetBefore);
  }
  const noSlots = createNativeRisuPresetProgram({
    version: 1,
    preset: {
      promptTemplate: [
        { type: 'plain', role: 'system', text: 'No reference slots' },
        { type: 'chat', rangeStart: 0, rangeEnd: 'end' },
      ],
    },
  });
  const fallback = compileSnapshotPrompt(snapshot, noSlots).promptCompilation!;
  const fallbackMessage = fallback.messages.find(
    (message) => message.id === '__host_background_lore__'
  )!;
  const fallbackItems = JSON.parse(fallbackMessage.content[0].text.split('\n').slice(1).join('\n'));
  for (const item of input.pinnedSources!.filter((item) => !item.nativeRisuPosition)) {
    expect(fallbackItems.filter((candidate: { id: string }) => candidate.id === item.id)).toEqual([
      item,
    ]);
  }
  const fallbackText = fallback.messages
    .flatMap((message) => message.content.map((part) => part.text))
    .join('\n');
  expect(fallbackText.split(RISU_SOURCE_GUIDANCE)).toHaveLength(2);
  expect(fallbackText.split('MODULE_POSITIONED')).toHaveLength(2);
  expect(snapshot).toEqual(before);
  expect(authored).toEqual(original);
});
