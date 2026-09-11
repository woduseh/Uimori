import { afterEach, expect, test, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createApp, type App } from '../server/app.js';
import { builtinPromptTemplate, builtinPromptTemplates } from '../server/builtin-prompts.js';
import {
  defaultPromptWorkspace,
  freezeCurrentPrompts,
  promptWorkspace,
} from '../server/prompt-workspace.js';
import { validateEditablePromptProgram } from '../core/prompt-program.js';
import { createDefaultPromptProgram } from '../core/prompt-defaults.js';
import { defaultProfile } from '../core/product.js';
import type { RunSnapshot } from '../core/types.js';
import { compileSnapshotPrompt } from '../server/prompt-snapshot.js';
import { compileTranslationPrompt, translationInput } from '../core/auxiliary.js';
import { sourceTimeContext } from '../server/product-auxiliary.js';

const owned: { directory: string; app?: App }[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const item of owned.splice(0).reverse()) {
    await item.app?.close();
    const target = resolve(item.directory);
    const within = relative(resolve(tmpdir()), target);
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !basename(target).startsWith('Uimori builtin prompts ')
    )
      throw new Error('Refusing cleanup outside owned test directory');
    await rm(target, { recursive: true, force: true });
  }
});
async function application(directory?: string) {
  const entry = directory
    ? owned.find((item) => item.directory === directory)!
    : {
        directory: await mkdtemp(join(tmpdir(), 'Uimori builtin prompts ')),
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

test('bundled programs are editable independent copies and compile in all authored modes', () => {
  const base = builtinPromptTemplate('pheme')!;
  expect(base.program.controls).toHaveLength(45);
  expect(base.program.blocks).toHaveLength(44);
  expect(base.program.collaboration).toBeUndefined();
  expect(builtinPromptTemplate('hermeneia')!.program.blocks).toHaveLength(7);
  for (const metadata of builtinPromptTemplates()) {
    const template = builtinPromptTemplate(metadata.id)!;
    expect(validateEditablePromptProgram(template.program)).toEqual(template.program);
    if (template.role === 'translation') continue;
    expect(template.program.blocks).toEqual(base.program.blocks);
    const count = (
      { 'pheme-collaboration': 3, 'pheme-simulation': 4, 'pheme-ooc': 1 } as Record<string, number>
    )[metadata.id];
    if (count) {
      expect(template.program.collaboration).toMatchObject({ enabled: true });
      expect(template.program.collaboration!.agents).toHaveLength(count);
      for (const advisor of template.program.collaboration!.agents)
        expect(advisor).toMatchObject({ trigger: 'on-demand', model: null });
    }
    expect(template.values.pheme_session_mode).toBe(metadata.id === 'pheme-ooc' ? 2 : 0);
    for (const mode of [0, 1, 2]) {
      const workspace = defaultPromptWorkspace();
      workspace.main = {
        title: template.title,
        program: template.program,
        values: { ...template.values, pheme_session_mode: mode },
      };
      const snapshot: RunSnapshot = {
        chatId: 'synthetic',
        parentRevision: null,
        settingsRevision: 1,
        settings: {
          preset: 'calm',
          mode: 'direct',
          translation: false,
          status: false,
          maxCalls: 8,
        },
        request: 'CURRENT_REQUEST_MARKER',
        history: [],
        resources: [],
        profile: {
          ...defaultProfile('synthetic'),
          contents: [],
          models: {},
          ...freezeCurrentPrompts(workspace),
        },
      };
      const compiled = compileSnapshotPrompt(snapshot).promptCompilation!;
      expect(compiled.values.pheme_session_mode).toBe(mode);
      expect(
        compiled.messages
          .flatMap((message) => message.content)
          .filter((part) => part.text.includes(snapshot.request))
      ).toHaveLength(1);
      const source = {
        id: 'synthetic-source',
        chatId: snapshot.chatId,
        text: 'SOURCE_TEXT_MARKER',
        hash: createHash('sha256').update('SOURCE_TEXT_MARKER').digest('hex'),
      };
      const input = translationInput(source, sourceTimeContext(snapshot, 'translation'), snapshot);
      const translated = compileTranslationPrompt(input, snapshot, 'Translate.')!;
      const messages = translated.messages.flatMap((message) => message.content);
      expect(messages.filter((part) => part.text.includes(source.text))).toHaveLength(1);
      expect(messages.some((part) => part.text.includes('Hermēneía'))).toBe(true);
      expect(messages.some((part) => part.text.includes(snapshot.request))).toBe(false);
    }
    template.program.blocks.length = 0;
    expect(builtinPromptTemplate(metadata.id)!.program.blocks.length).toBeGreaterThan(0);
  }
});

test('fresh defaults use Phēmē and Hermēneía; catalog reads and copying never apply a preset', async () => {
  const network = vi
    .spyOn(globalThis, 'fetch')
    .mockRejectedValue(new Error('No provider call allowed'));
  const { app } = await application();
  const original = promptWorkspace(app!.store);
  expect(original.main.title).toBe('Phēmē');
  expect(original.translation.title).toBe('Hermēneía');
  expect(original.main.program.collaboration).toBeUndefined();
  expect(app!.store.product.importStatus().canImport).toBe(true);
  const before = app!.store.db.prepare('SELECT total_changes() AS n').get();
  const listed = await app!.inject({ method: 'GET', url: '/api/prompt-templates' });
  expect(listed.statusCode).toBe(200);
  expect(listed.json()).toHaveLength(5);
  expect(listed.body).not.toContain('"program"');
  expect(
    (await app!.inject({ method: 'GET', url: '/api/prompt-templates/unknown' })).statusCode
  ).toBe(404);
  const response = await app!.inject({
    method: 'GET',
    url: '/api/prompt-templates/pheme-collaboration',
  });
  expect(response.statusCode).toBe(200);
  expect(app!.store.db.prepare('SELECT total_changes() AS n').get()).toEqual(before);
  const { title, role, program, values } = response.json();
  const copy = await app!.inject({
    method: 'POST',
    url: '/api/prompt-presets',
    payload: { title, role, program, values },
  });
  expect(copy.statusCode, copy.body).toBe(200);
  expect(promptWorkspace(app!.store)).toEqual(original);
  const frozen = freezeCurrentPrompts(original);
  const applied = await app!.inject({
    method: 'POST',
    url: '/api/prompt-workspace/apply',
    payload: { expectedRevision: original.revision, role: 'main', presetId: copy.json().id },
  });
  expect(applied.statusCode, applied.body).toBe(200);
  expect(applied.json().main.program.collaboration.agents).toHaveLength(3);
  expect(applied.json().translation).toEqual(original.translation);
  expect(frozen.promptPresets!.main!.program.collaboration).toBeUndefined();
  expect(network).not.toHaveBeenCalled();
});

test('reopening an existing database preserves saved working programs, options and library edits', async () => {
  const entry = await application();
  const prior = promptWorkspace(entry.app!.store);
  prior.main = {
    title: 'My saved writing prompt',
    program: createDefaultPromptProgram('MY SAVED INSTRUCTIONS'),
    values: {},
  };
  prior.translation = {
    title: 'My saved translation',
    program: createDefaultPromptProgram('MY TRANSLATION', 'translation'),
    values: {},
  };
  prior.revision = 17;
  entry
    .app!.store.db.prepare('UPDATE prompt_workspace SET body=? WHERE id=1')
    .run(JSON.stringify(prior));
  const preset = entry.app!.store.product.promptPreset({
    title: 'Phēmē',
    role: 'main',
    program: createDefaultPromptProgram('USER MODIFIED COPY'),
  });
  await entry.app!.close();
  entry.app = undefined;
  const reopened = await application(entry.directory);
  expect(promptWorkspace(reopened.app!.store)).toEqual(prior);
  expect(reopened.app!.store.product.get('prompt-preset', preset.id)).toEqual(preset);
  expect(reopened.app!.store.product.all('prompt-preset')).toHaveLength(1);
  expect(
    (await reopened.app!.inject({ method: 'GET', url: '/api/prompt-templates' })).json()
  ).toHaveLength(5);
  expect(promptWorkspace(reopened.app!.store)).toEqual(prior);
});
