import { nativePrompt } from './fixtures/native-prompt.js';
import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.js';
import { ChatOptionsStore, optionBinding } from '../server/chat-options.js';
import {
  defaultPromptWorkspace,
  freezeCurrentPrompts,
  promptWorkspace,
  updatePromptWorkspace,
} from '../server/prompt-workspace.js';
import { createFixtureChat } from './fixtures/chat.js';
import type { OptionValues } from '../core/chat-options.js';

import { DEFAULT_MAIN_PROMPT } from '../core/prompts.js';

const owned: { store: Store; path: string }[] = [];
afterEach(() => {
  for (const { store, path } of owned.splice(0)) {
    store.close();
    const inside = relative(tmpdir(), path);
    if (isAbsolute(inside) || inside.startsWith('..') || !inside.startsWith('uimori-chat-options-'))
      throw new Error('Unsafe cleanup');
    rmSync(path, { recursive: true, force: true });
  }
});
const requestId = 'direct-ui-action';
function database() {
  const path = mkdtempSync(join(tmpdir(), 'uimori-chat-options-')),
    store = new Store(join(path, 'test.sqlite'));
  owned.push({ store, path });
  return store;
}
function fixture() {
  const store = database();
  const prior = promptWorkspace(store);
  updatePromptWorkspace(store, {
    expectedRevision: prior.revision,
    main: {
      ...prior.main,
      values: { tone: 'calm', detail: '1' },
      program: nativePrompt(DEFAULT_MAIN_PROMPT, {
        customPromptTemplateToggle: 'tone=Tone=text\ndetail=Detail=text',
      }),
    },
  });
  const chat = createFixtureChat(store, 'Options', 'calm'),
    service = new ChatOptionsStore(store);
  return { store, chat, service };
}
function input(f: ReturnType<typeof fixture>, values: OptionValues, branchId?: string) {
  const state = f.service.get(f.chat.id, branchId);
  return {
    branchId: state.branchId,
    expectedRevision: state.revision,
    binding: state.binding,
    values,
    operationId: randomUUID(),
  };
}
function stage(f: ReturnType<typeof fixture>, values: OptionValues) {
  return f.service.stage(
    f.chat.id,
    {
      ...input(f, values),
    },
    requestId
  );
}

function command(f: ReturnType<typeof fixture>) {
  const chat = f.store.chat(f.chat.id),
    branch = f.store.product.branch(chat.id);
  return {
    request: 'Synthetic continuation',
    expectedRevision: branch.headRevision,
    expectedSettingsRevision: chat.settingsRevision,
    branchId: branch.id,
    idempotencyKey: randomUUID(),
  };
}
function run(f: ReturnType<typeof fixture>, cmd = command(f)) {
  return f.store.createRun(f.chat.id, cmd, (chat) => {
    const profile = f.store.product.snapshot(chat.id);
    return {
      chatId: chat.id,
      parentRevision: cmd.expectedRevision,
      settings: chat.settings,
      settingsRevision: chat.settingsRevision,
      request: cmd.request,
      history: f.store.history(cmd.expectedRevision),
      resources: f.store.product.resources(chat.id, profile),
      profile,
    };
  });
}
function complete(f: ReturnType<typeof fixture>, id: string) {
  f.store.startRun(id);
  return f.store.completeRun(
    id,
    `Synthetic ${id}`,
    { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
    { ...f.store.run(id).snapshot.settings, status: false }
  );
}
test('global, chat fixed and oneoff values resolve once in the reservation transaction', () => {
  const f = fixture();
  f.service.fixed(f.chat.id, input(f, { tone: 'bold' }), requestId);
  stage(f, { detail: '4' });
  stage(f, { tone: 'warm', detail: '7' });
  const cmd = command(f),
    first = run(f, cmd);
  const resolution = first.run.snapshot.profile!.chatOptions!;
  expect(resolution).toMatchObject({
    globalValues: { tone: 'calm', detail: '1' },
    fixedValues: { tone: 'bold' },
    oneoffValues: { tone: 'warm', detail: '7' },
    values: { tone: 'warm', detail: '7' },
  });
  expect(resolution.pendingIds).toHaveLength(1);
  expect(f.service.get(f.chat.id).pending).toEqual([]);
  expect(run(f, cmd)).toEqual({ run: first.run, created: false });
  expect(promptWorkspace(f.store).main.values).toEqual({ tone: 'calm', detail: '1' });
  complete(f, first.run.id);
  const next = run(f);
  expect(next.run.snapshot.profile!.chatOptions!.values).toEqual({ tone: 'bold', detail: '1' });
});

test('failed reservation rolls back oneoff consumption and changed global values remain independent of the definition binding', () => {
  const f = fixture();
  stage(f, { detail: '5' });
  expect(() =>
    f.store.transaction(() => {
      run(f);
      throw new Error('reservation failed');
    })
  ).toThrow('reservation failed');
  expect(f.service.get(f.chat.id).pending).toHaveLength(1);
  const oldBinding = f.service.get(f.chat.id).binding,
    current = promptWorkspace(f.store);
  updatePromptWorkspace(f.store, {
    expectedRevision: current.revision,
    main: { ...current.main, values: { tone: 'warm', detail: '3' } },
  });
  expect(f.service.get(f.chat.id).binding).toEqual(oldBinding);
  const value = run(f).run;
  expect(value.snapshot.profile!.chatOptions!.values).toEqual({ tone: 'warm', detail: '5' });
  expect(f.service.get(f.chat.id).pending).toEqual([]);
});
test('stale revisions and changed definitions cannot overwrite options', () => {
  const f = fixture(),
    initial = input(f, { tone: 'bold' });
  const accepted = f.service.fixed(f.chat.id, initial, requestId);
  expect(f.service.fixed(f.chat.id, initial, requestId)).toEqual(accepted);
  expect(() =>
    f.service.fixed(f.chat.id, { ...initial, operationId: randomUUID() }, requestId)
  ).toThrow(/변경/);
  expect(() =>
    f.service.fixed(
      f.chat.id,
      {
        ...input(f, { tone: 'bold' }),
        binding: { ...accepted.binding, owner: 'preset:unrelated' },
      },
      requestId
    )
  ).toThrow(/소속/);
  expect(() =>
    f.service.fixed(f.chat.id, input(f, { modelId: 'foreign-model' }), requestId)
  ).toThrow();
});
test('definition changes block pending choices and never silently apply old fixed or oneoff fields', () => {
  const f = fixture();
  f.service.fixed(f.chat.id, input(f, { tone: 'bold' }), requestId);
  stage(f, { detail: '4' });
  const current = promptWorkspace(f.store);
  updatePromptWorkspace(f.store, {
    expectedRevision: current.revision,
    main: {
      ...current.main,
      program: nativePrompt(DEFAULT_MAIN_PROMPT, {
        customPromptTemplateToggle: 'tone=Tone=text\ndetail=Changed detail=text',
      }),
    },
  });
  expect(f.service.get(f.chat.id).fixedValues).toEqual({});
  expect(f.service.get(f.chat.id).conflicts.length).toBeGreaterThan(0);
  expect(() => run(f)).toThrow(/再|다시/);
  const state = f.service.get(f.chat.id);
  f.service.cancel(
    f.chat.id,
    state.pending[0].id,
    { expectedRevision: state.revision, branchId: state.branchId, operationId: randomUUID() },
    requestId
  );
  expect(run(f).run.snapshot.profile!.chatOptions!.values).toEqual({ tone: 'calm', detail: '1' });
});
test('the frozen profile owner and the live option binding come from one rule', () => {
  const workspace = defaultPromptWorkspace();
  expect(freezeCurrentPrompts(workspace).promptOptionOwner).toBe('workspace:main');
  expect(optionBinding(workspace.main).owner).toBe('workspace:main');
  const applied = { ...workspace, main: { ...workspace.main, presetId: 'preset-1' } };
  expect(freezeCurrentPrompts(applied).promptOptionOwner).toBe('preset:preset-1');
  expect(optionBinding(applied.main).owner).toBe('preset:preset-1');
});
