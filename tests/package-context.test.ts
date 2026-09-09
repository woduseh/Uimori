import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { compiledPackages, packageContext } from '../core/package-context.js';
import { defaultProfile } from '../core/product.js';
import type { ContentPackage } from '../core/content-package.js';
import type { RunSnapshot } from '../core/types.js';
import { buildMainInput, executeTool } from '../core/provider.js';
import {
  translationInput,
  compileTranslationPrompt,
  type SourceTimeContext,
} from '../core/auxiliary.js';
import { compileSnapshotPrompt, promptContext } from '../server/prompt-snapshot.js';
import { buildPackagePresentation } from '../server/package-presentation.js';

function snapshot(): RunSnapshot {
  return {
    chatId: 'chat',
    parentRevision: null,
    settingsRevision: 1,
    settings: { preset: 'calm', mode: 'direct', translation: false, status: false, maxCalls: 4 },
    request: 'Continue.',
    history: [],
    resources: [],
    profile: { ...defaultProfile('chat'), contents: [], models: {} },
  };
}
function attach(s: RunSnapshot): ContentPackage {
  const p: ContentPackage = {
    version: 1,
    id: 'pkg',
    revision: 1,
    title: 'Package character',
    description: 'metadata',
    body: 'EXACT_BODY',
    lore: [{ id: 'facts', title: 'Facts', description: '', text: 'EXACT_LORE', loading: 'pinned' }],
    instructions: ['main', 'translation', 'state', 'status', 'image'].map((target) => ({
      id: target,
      target: target as 'main',
      text: `${target.toUpperCase()}_ONLY`,
      when: { control: 'on' },
    })),
    controls: [{ id: 'on', label: 'On', type: 'boolean', default: true }],
    transforms: [],
  };
  s.profile!.packages = [p];
  s.profile!.packageAttachments = [{ id: p.id, revision: 1, role: 'bot' }];
  return p;
}
const context: SourceTimeContext = {
  revision: 'chat@1',
  bot: null,
  persona: null,
  references: [],
  scene: '',
  previousSources: [],
  instructionRevision: 'default',
  modelPresetRevision: 'mock',
};
describe('source-time package role context', () => {
  it('leaves legacy requests and slots exactly unchanged for absent versus empty package fields', () => {
    const before = snapshot(),
      after = structuredClone(before);
    after.profile!.packages = [];
    after.profile!.packageAttachments = [];
    expect(packageContext(before, 'main')).toBeUndefined();
    expect(compiledPackages(before, 'main')).toEqual([]);
    expect(JSON.stringify(buildMainInput(after))).toBe(JSON.stringify(buildMainInput(before)));
    expect(JSON.stringify(promptContext(after))).toBe(JSON.stringify(promptContext(before)));
    const source = {
      id: 'src',
      hash: createHash('sha256').update('Original').digest('hex'),
      chatId: 'chat',
      text: 'Original',
    };
    expect(JSON.stringify(translationInput(source, context, after))).toBe(
      JSON.stringify(translationInput(source, context, before))
    );
  });
  it('freezes role instructions and control values independently of later package edits', () => {
    const current = snapshot(),
      p = attach(current),
      old = structuredClone(current);
    p.instructions[0].text = 'NEW_MAIN';
    current.profile!.packageValues = { 'pkg@1:bot': { on: false } };
    expect(packageContext(old, 'main')!.instructions.map((n) => n.text)).toEqual(['MAIN_ONLY']);
    expect(packageContext(current, 'main')!.instructions).toEqual([]);
    for (const target of ['translation', 'state', 'status', 'image'] as const)
      expect(packageContext(old, target)!.instructions.map((n) => n.text)).toEqual([
        `${target.toUpperCase()}_ONLY`,
      ]);
  });
  it('rebuilds controls and frozen state for each prompt while preserving earlier results', () => {
    const s = snapshot(),
      p = attach(s);
    p.instructions[0].template = [
      { kind: 'text', text: 'STATE=' },
      { kind: 'value', expression: { context: ['state', 'count'] } },
      { kind: 'text', text: ';DRAW=' },
      { kind: 'value', expression: { context: ['draws', 'die'] } },
    ];
    s.packageStates = [
      {
        instanceId: 'pkg:bot',
        packageId: p.id,
        packageRevision: 1,
        role: 'bot',
        behaviorRevision: 1,
        schemaVersion: 1,
        stateRevision: 1,
        state: { count: 0 },
        draws: { die: 4 },
      },
    ];
    const before = structuredClone(s),
      first = compileSnapshotPrompt(s),
      firstText = JSON.stringify(first.promptCompilation);
    expect(firstText).toContain('STATE=0;DRAW=4');
    expect(s).toEqual(before);

    s.packageStates[0].state = { count: 2 };
    s.packageStates[0].draws = { die: 6 };
    p.title = 'Updated character';
    expect(JSON.stringify(compileSnapshotPrompt(s).promptCompilation)).toContain('STATE=2;DRAW=6');
    expect(promptContext(s).slots.char).toBe('Updated character');
    s.profile!.packageValues = { 'pkg@1:bot': { on: false } };
    expect(buildMainInput(s).facts).toEqual(['EXACT_BODY', 'EXACT_LORE']);
    expect(JSON.stringify(compileSnapshotPrompt(s).promptCompilation)).not.toContain('STATE=');
    expect(JSON.stringify(first.promptCompilation)).toBe(firstText);

    s.profile!.packageAttachments![0].revision = 2;
    for (const build of [buildMainInput, promptContext, compileSnapshotPrompt])
      expect(() => build(s)).toThrow('PACKAGE_SNAPSHOT_REVISION_MISSING');
  });
  it('keeps catalog metadata separate from pinned references in main and translation inputs', () => {
    const s = snapshot(),
      p = attach(s);
    p.lore[0].loreContext = { placement: 'scene', group: 'original', order: 1 };
    const main = buildMainInput(s),
      id = 'package:pkg:bot:lore:facts';
    main.catalog.find((item) => item.id === id)!.loreContext!.group = 'changed';
    expect(main.pinnedSources!.find((item) => item.id === id)!.loreContext!.group).toBe('original');
    const source = {
      id: 'source',
      hash: createHash('sha256').update('Original').digest('hex'),
      chatId: s.chatId,
      text: 'Original',
    };
    const translation = translationInput(source, context, s);
    translation.catalog.find((item) => item.id === id)!.loreContext!.group = 'changed';
    expect(
      translation.context.packages!.pinned.find((item) => item.id === id)!.loreContext!.group
    ).toBe('original');
    expect(p.lore[0].loreContext.group).toBe('original');
  });
  it('fails missing frozen revisions rather than returning partial context', () => {
    const s = snapshot();
    attach(s);
    s.profile!.packageAttachments!.push({ id: 'missing', revision: 9, role: 'module' });
    expect(() => compiledPackages(s, 'main')).toThrow('PACKAGE_SNAPSHOT_REVISION_MISSING');
  });
  it('provides main body and instructions both in simple input and composed host context', () => {
    const s = snapshot();
    attach(s);
    expect(buildMainInput(s).facts).toEqual(['EXACT_BODY', 'EXACT_LORE', 'MAIN_ONLY']);
    s.profile!.promptPresets = {
      main: {
        id: 'prompt',
        revision: 1,
        title: 'Prompt',
        role: 'main',
        program: {
          version: 1,
          controls: [],
          blocks: [
            { id: 'body', title: 'Body', kind: 'slot', role: 'system', slot: 'bot' },
            { id: 'turn', title: 'Turn', kind: 'current' },
          ],
        },
      },
    };
    const compiled = compileSnapshotPrompt(s);
    const text = JSON.stringify(compiled.promptCompilation);
    expect(text).toContain('EXACT_BODY');
    expect(text).toContain('MAIN_ONLY');
    expect(text).not.toContain('TRANSLATION_ONLY');
    expect(promptContext(s).slots.char).toBe('Package character');
  });
  it('keeps persona package lore out of main when disabled while allowing translation reads', () => {
    const s = snapshot();
    attach(s);
    s.profile!.packageAttachments![0].role = 'persona';
    s.resources = compiledPackages(s, 'main').flatMap((p) => p.resources);
    s.profile!.personaReference = false;
    expect(buildMainInput(s).catalog).toEqual([]);
    expect(buildMainInput(s).facts).toEqual([]);
    const id = 'package:pkg:persona:lore:facts';
    expect(
      executeTool(s, { callId: 'read', name: 'knowledge.read', args: { id } }, undefined, 'main')
        .denied
    ).toBe(true);
    expect(
      executeTool(
        s,
        { callId: 'read', name: 'knowledge.read', args: { id } },
        undefined,
        'translation'
      ).denied
    ).toBe(false);
  });
  it('supplies translation-only context and package slots to an independent composed translation', () => {
    const s = snapshot();
    attach(s);
    s.profile!.promptPresets = {
      translation: {
        id: 'tr',
        revision: 1,
        title: 'Translate',
        role: 'translation',
        program: {
          version: 1,
          controls: [],
          blocks: [
            { id: 'bot', title: 'Bot', kind: 'slot', role: 'system', slot: 'bot' },
            { id: 'turn', title: 'Turn', kind: 'current' },
          ],
        },
      },
    };
    const source = {
      id: 'source',
      hash: createHash('sha256').update('Original').digest('hex'),
      chatId: 'chat',
      text: 'Original',
    };
    const input = translationInput(source, { ...context, instructionRevision: 'prompt:tr@1' }, s);
    expect(input.context.packages!.instructions.map((n) => n.text)).toEqual(['TRANSLATION_ONLY']);
    expect(JSON.stringify(input)).not.toContain('MAIN_ONLY');
    expect(JSON.stringify(compileTranslationPrompt(input, s, 'Translate'))).toContain('EXACT_BODY');
  });
  it('projects displays from frozen definitions and rejects translation from another hash', async () => {
    const s = snapshot();
    const p = attach(s);
    p.transforms = [
      { id: 'show', target: 'source', pattern: 'Original', flags: 'g', replacement: 'Display' },
    ];
    const frozen = structuredClone(s);
    p.transforms[0].replacement = 'Future';
    const source = {
      id: 'source',
      chatId: 'chat',
      text: 'Original',
      hash: createHash('sha256').update('Original').digest('hex'),
    };
    expect((await buildPackagePresentation(frozen, source)).original.text).toBe('Display');
    expect(source.text).toBe('Original');
    await expect(
      buildPackagePresentation(frozen, {
        ...source,
        translation: { text: '번역', sourceRevision: 'source', sourceHash: 'other' },
      })
    ).rejects.toThrow('PACKAGE_PRESENTATION_TRANSLATION_MISMATCH');
  });
});
