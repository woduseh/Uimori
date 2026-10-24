import {
  prepareNativeRisuPreset,
  prepareNativeRisuTranslationPrompt,
} from '../server/risu-native-preset.js';
import { afterEach, expect, test, vi } from 'vitest';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createApp, type App } from '../server/app.js';
import { builtinPromptTemplate, builtinPromptTemplates } from '../server/builtin-prompts.js';
import {
  defaultPromptWorkspace,
  freezeCurrentPrompts,
  promptWorkspace,
} from '../server/prompt-workspace.js';
import { promptControls, validateEditableRisuPrompt } from '../core/risu-prompt.js';
import { createDefaultRisuPrompt } from '../core/prompt-defaults.js';
import { defaultProfile } from '../core/product.js';
import type { RunSnapshot } from '../core/types.js';
import { compileSnapshotPrompt } from '../server/prompt-snapshot.js';
import { compileTranslationPrompt, translationInput } from '../core/auxiliary.js';
import { sourceTimeContext } from '../server/product-auxiliary.js';
import { encodeResponses } from '../core/openai-protocol.js';
import { encodeAnthropic } from '../core/anthropic-protocol.js';
import type { ProviderRequest } from '../core/transport.js';
import { createTestDirectory } from './fixtures/test-directory.js';

const owned: (ReturnType<typeof createTestDirectory> & { app?: App })[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const item of owned.splice(0).reverse()) {
    await item.app?.close();
    item.remove();
  }
});
async function application(directory?: string) {
  const entry = directory
    ? owned.find((item) => item.directory === directory)!
    : {
        ...createTestDirectory('Uimori builtin prompts '),
        app: undefined as App | undefined,
      };
  if (!directory) owned.push(entry);
  entry.app = await createApp({
    dbPath: join(entry.directory, 'story.sqlite'),
    buildId: 'builtin-prompts-test',
    instanceId: randomUUID(),
    testMode: true,
  });
  await entry.app.ready();
  return entry;
}

test('builtin catalog offers fixed RP, novel and translation presets without separate collaboration or OOC entries', () => {
  expect(builtinPromptTemplates().map(({ id, title, role }) => ({ id, title, role }))).toEqual([
    { id: 'pheme', title: 'Phēmē RP', role: 'main' },
    { id: 'pheme-novel', title: 'Phēmē 소설', role: 'main' },
    { id: 'hermeneia', title: 'Hermēneía', role: 'translation' },
  ]);
  for (const id of [
    'pheme-collaboration',
    'pheme-novel-collaboration',
    'pheme-simulation',
    'pheme-novel-simulation',
    'pheme-ooc',
  ])
    expect(builtinPromptTemplate(id)).toBeUndefined();
});

test('bundled native presets are editable independent copies with fixed modes and optional collaboration', async () => {
  for (const metadata of builtinPromptTemplates()) {
    const template = builtinPromptTemplate(metadata.id)!;
    expect(validateEditableRisuPrompt(template.program)).toEqual(template.program);
    if (template.role === 'main') {
      const novel = metadata.id === 'pheme-novel';
      const count = novel ? 4 : 3;
      expect(template.program.collaboration).toMatchObject({ enabled: false, maxCalls: 8 });
      expect(template.program.collaboration!.agents).toHaveLength(count);
      for (const advisor of template.program.collaboration!.agents)
        expect(advisor).toMatchObject({ trigger: 'on-demand', model: null });
      const enabled = structuredClone(template.program);
      enabled.collaboration!.enabled = true;
      expect(validateEditableRisuPrompt(enabled)).toEqual(enabled);
      expect(promptControls(template.program)).toHaveLength(novel ? 45 : 44);
      expect(promptControls(template.program).map((control) => control.id)).not.toContain(
        'pheme_session_mode'
      );
      expect(template.values).not.toHaveProperty('pheme_session_mode');
      const workspace = defaultPromptWorkspace();
      workspace.main = {
        title: template.title,
        program: template.program,
        values: template.values,
      };
      const snapshot: RunSnapshot = {
        chatId: 'synthetic',
        parentRevision: null,
        settingsRevision: 1,
        settings: {
          maxCalls: 8,
        },
        request: 'CURRENT_REQUEST_MARKER',
        history: [],
        resources: [],
        profile: {
          ...defaultProfile('synthetic'),
          models: {},
          ...freezeCurrentPrompts(workspace),
        },
      };
      const compiled = compileSnapshotPrompt(await prepareNativeRisuPreset(snapshot))
        .promptCompilation!;
      expect(compiled.values).not.toHaveProperty('pheme_session_mode');
      const writingText = compiled.messages
        .flatMap((message) => message.content)
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n');
      expect(writingText).toContain(
        `<mode_contract family="fiction" mode="${novel ? 'novel_writing' : 'roleplay'}">`
      );
      expect(writingText).not.toContain(
        `<mode_contract family="fiction" mode="${novel ? 'roleplay' : 'novel_writing'}">`
      );
      expect(
        compiled.messages
          .flatMap((message) => message.content)
          .filter((part) =>
            (part as { type: 'text'; text: string }).text.includes(snapshot.request)
          )
      ).toHaveLength(1);
      const source = {
        id: 'synthetic-source',
        chatId: snapshot.chatId,
        text: 'SOURCE_TEXT_MARKER',
        hash: createHash('sha256').update('SOURCE_TEXT_MARKER').digest('hex'),
      };
      const input = translationInput(source, sourceTimeContext(snapshot, 'translation'), snapshot);
      const translated = compileTranslationPrompt(
        input,
        await prepareNativeRisuTranslationPrompt(snapshot),
        'Translate.'
      )!;
      const messages = translated.messages.flatMap((message) => message.content);
      expect(
        messages.filter((part) =>
          (part as { type: 'text'; text: string }).text.includes(source.text)
        )
      ).toHaveLength(1);
      expect(
        messages.some((part) => (part as { type: 'text'; text: string }).text.includes('Hermēneía'))
      ).toBe(true);
      expect(
        messages.some((part) =>
          (part as { type: 'text'; text: string }).text.includes(snapshot.request)
        )
      ).toBe(false);
    }
    template.program.nativeRisuPreset.preset.promptTemplate = [];
    expect(
      (
        builtinPromptTemplate(metadata.id)!.program.nativeRisuPreset.preset
          .promptTemplate as unknown[]
      ).length
    ).toBeGreaterThan(0);
    if (template.program.collaboration) {
      template.program.collaboration.enabled = true;
      expect(builtinPromptTemplate(metadata.id)!.program.collaboration!.enabled).toBe(false);
    }
  }
});

test.each(['pheme', 'pheme-novel'])(
  '%s remains usable with automatic caching after two prior user turns',
  async (id) => {
    const workspace = defaultPromptWorkspace();
    const { title, program, values } = builtinPromptTemplate(id)!;
    workspace.main = { title, program, values };
    const snapshot: RunSnapshot = {
      chatId: 'cache-history',
      parentRevision: 'scene-2',
      settingsRevision: 1,
      settings: { maxCalls: 8 },
      request: 'Continue the scene.',
      history: [
        { revision: 'scene-1', text: 'First scene.' },
        { revision: 'scene-2', text: 'Second scene.' },
      ],
      logicalHistory: [
        { id: 'user-1', role: 'user', text: 'Open the door.', sourceRevision: 'scene-1' },
        { id: 'assistant-1', role: 'assistant', text: 'First scene.', sourceRevision: 'scene-1' },
        { id: 'user-2', role: 'user', text: 'Enter the room.', sourceRevision: 'scene-2' },
        { id: 'assistant-2', role: 'assistant', text: 'Second scene.', sourceRevision: 'scene-2' },
      ],
      resources: [],
      profile: {
        ...defaultProfile('cache-history'),
        models: {},
        ...freezeCurrentPrompts(workspace),
      },
    };
    const compiled = compileSnapshotPrompt(await prepareNativeRisuPreset(snapshot))
      .promptCompilation!;
    expect(new Set(compiled.cachePlan.map((point) => point.afterMessageId)).size).toBe(4);
    for (const [modelId, encode] of [
      ['gpt-5.6-sol', encodeResponses],
      ['claude-opus-5-5', encodeAnthropic],
    ] as const) {
      const request: ProviderRequest = {
        role: 'main',
        modelId,
        stable: { contract: '', tools: [] },
        generation: { maxOutputTokens: 1024, temperature: null, cacheMode: 'automatic' },
        input: { task: snapshot.request, controls: {}, source: {} },
        prompt: {
          compilerVersion: compiled.compilerVersion,
          messages: compiled.messages,
          cachePlan: compiled.cachePlan,
          values: compiled.values,
        },
      };
      const original = structuredClone(request);
      const automatic = encode(request);
      expect(request).toEqual(original);
      expect(
        automatic.messageMetadata?.diagnostics.filter(
          (item) => item.code === 'CACHE_BREAKPOINT_ENCODED_HIT_UNVERIFIED'
        )
      ).toHaveLength(4);
      request.generation!.cacheMode = 'explicit';
      expect(automatic.body).toEqual(encode(request).body);
    }
  }
);

test('reopening preserves legacy working programs as preset references, options and existing library edits', async () => {
  const entry = await application();
  const prior = promptWorkspace(entry.app!.store);
  const initialPresetCount = entry.app!.store.product.all('prompt-preset').length;
  expect(prior.main.title).toBe('Phēmē RP');
  expect(prior.main.values).not.toHaveProperty('pheme_session_mode');
  expect(prior.main.program.collaboration).toMatchObject({ enabled: false });
  prior.main = {
    title: 'My saved writing prompt',
    program: createDefaultRisuPrompt('MY SAVED INSTRUCTIONS'),
    values: { tone: 'KEEP_OPTION' },
  };
  prior.main.program.nativeRisuPreset.preset.customPromptTemplateToggle = 'tone=보존 문체=text';
  prior.translation = {
    title: 'My saved translation',
    program: createDefaultRisuPrompt('MY TRANSLATION', 'translation'),
    values: {},
  };
  prior.revision = 17;
  entry
    .app!.store.db.prepare('UPDATE prompt_workspace SET body=? WHERE id=1')
    .run(JSON.stringify(prior));
  const preset = entry.app!.store.product.promptPreset({
    title: 'Phēmē',
    role: 'main',
    program: createDefaultRisuPrompt('USER MODIFIED COPY'),
  });
  const legacyOocProgram = createDefaultRisuPrompt('USER SAVED LEGACY OOC INSTRUCTIONS');
  legacyOocProgram.nativeRisuPreset.preset.customPromptTemplateToggle =
    'pheme_session_mode=Session Mode=select=Roleplay,Novel,OOC';
  const legacyOoc = entry.app!.store.product.promptPreset({
    title: 'Phēmē · OOC 검토',
    role: 'main',
    program: legacyOocProgram,
    values: { pheme_session_mode: '2' },
  });
  await entry.app!.close();
  entry.app = undefined;
  const reopened = await application(entry.directory);
  const migrated = promptWorkspace(reopened.app!.store);
  expect(migrated).toMatchObject(prior);
  for (const role of ['main', 'translation'] as const) {
    expect(
      reopened.app!.store.product.get('prompt-preset', migrated[role].presetId!)
    ).toMatchObject({
      title: prior[role].title,
      role,
      program: prior[role].program,
      values: prior[role].values,
    });
  }
  const stored = reopened
    .app!.store.db.prepare('SELECT body FROM prompt_workspace WHERE id=1')
    .get()!;
  expect(JSON.parse(String(stored.body)).main).toEqual({
    presetId: migrated.main.presetId,
    values: prior.main.values,
  });
  expect(reopened.app!.store.product.get('prompt-preset', preset.id)).toEqual(preset);
  expect(reopened.app!.store.product.get('prompt-preset', legacyOoc.id)).toEqual(legacyOoc);
  expect(reopened.app!.store.product.all('prompt-preset')).toHaveLength(initialPresetCount + 4);
  expect(
    (await reopened.app!.inject({ method: 'GET', url: '/api/prompt-templates' })).json()
  ).toHaveLength(3);
  for (const id of ['pheme-collaboration', 'pheme-simulation', 'pheme-ooc']) {
    const response = await reopened.app!.inject({
      method: 'GET',
      url: `/api/prompt-templates/${id}`,
    });
    expect(response.statusCode).toBe(404);
  }
  expect(
    (
      await reopened.app!.inject({
        method: 'GET',
        url: `/api/prompt-presets/${legacyOoc.id}`,
      })
    ).json()
  ).toEqual(legacyOoc);
  const changes = reopened.app!.store.db.prepare('SELECT total_changes() AS n').get();
  expect(promptWorkspace(reopened.app!.store)).toEqual(migrated);
  expect(reopened.app!.store.db.prepare('SELECT total_changes() AS n').get()).toEqual(changes);
  await reopened.app!.close();
  reopened.app = undefined;
  const again = await application(entry.directory);
  expect(promptWorkspace(again.app!.store)).toEqual(migrated);
  expect(again.app!.store.product.all('prompt-preset')).toHaveLength(initialPresetCount + 4);
});
