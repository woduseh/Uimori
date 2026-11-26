import { observeExecutions, observedExecution } from './fixtures/execution-observer.js';
import { nativeContent } from './fixtures/native-content.js';
import { nativePrompt } from './fixtures/native-prompt.js';
import { prepareNativeFixtureRun } from './fixtures/native-run.js';
import { promptWorkspace, updatePromptWorkspace } from '../server/prompt-workspace.js';
import { createFixtureChat } from './fixtures/chat.js';
import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.js';
import { readStoredRunSnapshot } from '../server/run-projections.js';
import type { Content, PromptPreset } from '../core/product.js';
import type { RisuContent } from '../core/risu-content.js';
import { packageContext } from '../core/package-context.js';
const owned: { store: Store; dir: string }[] = [];
afterEach(() => {
  for (const { store, dir } of owned.splice(0)) {
    store.close();
    const inside = relative(resolve(tmpdir()), resolve(dir));
    if (
      isAbsolute(inside) ||
      inside.startsWith('..') ||
      !inside.startsWith('uimori-redesign-integration-')
    )
      throw Error('Unsafe fixture cleanup');
    rmSync(dir, { recursive: true, force: true });
  }
});
function db() {
  const dir = mkdtempSync(join(tmpdir(), 'uimori-redesign-integration-'));
  const store = new Store(join(dir, 'test.sqlite'));
  observeExecutions(store);
  owned.push({ store, dir });
  return store;
}
function packageBody(): RisuContent {
  return nativeContent(
    {
      name: 'Imported title',
      creator_notes: 'Imported description',
      description: 'Imported body',
      system_prompt: 'RETIRED_SYSTEM_MUST_NOT_EXECUTE',
      post_history_instructions: 'Exact original global note',
      character_book: {
        entries: [{ uid: 1, name: 'Lore', content: 'Exact original lore', constant: false }],
      },
    },
    { id: 'imported', revision: 17 },
    'module'
  );
}
function save(store: Store, pkg = packageBody(), prior?: Content) {
  return store.product.content(
    {
      kind: 'module',
      title: 'Outer title',
      description: 'Outer description',
      text: '',
      loading: 'pinned',
      relatedIds: [],
      package: pkg,
      ...(prior ? { expectedRevision: prior.revision } : {}),
    },
    prior?.id
  ) as Content;
}
async function capture(store: Store, chatId: string) {
  const chat = store.chat(chatId);
  const profile = store.product.snapshot(chatId);
  const run = store.createRun(
    chatId,
    {
      request: 'Synthetic',
      expectedRevision: chat.headRevision,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: randomUUID(),
    },
    (c) => ({
      chatId,
      parentRevision: c.headRevision,
      settingsRevision: c.settingsRevision,
      settings: c.settings,
      request: 'Synthetic',
      history: store.history(c.headRevision),
      resources: store.product.resources(chatId, profile),
      profile,
    })
  ).run;
  await prepareNativeFixtureRun(store, run);
  store.startRun(run.id);
  store.completeRun(run.id, 'Synthetic original', {
    modelCalls: 0,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
  });
  return observedExecution(store, run.id);
}
test('native source normalizes execution input and preserves completed metadata and output after editing', async () => {
  const store = db(),
    input = packageBody(),
    saved = save(store, input);
  expect(saved.package).toEqual({ ...input, id: saved.id, revision: 1 });
  expect(input.id).toBe('imported');
  const chat = createFixtureChat(store, 'Story', { botId: saved.id });
  const run = await capture(store, chat.id),
    completedSnapshot = readStoredRunSnapshot(store, run.id),
    completedSource = store.source(run.sourceRevision!);
  expect(packageContext(run.snapshot, 'main')!.pinned.map((item) => item.text)).toContain(
    'Imported body'
  );
  expect(run.snapshot.profile!.packages![0].nativeRisu.card.post_history_instructions).toBe(
    'Exact original global note'
  );
  expect(JSON.stringify(run.snapshot.promptCompilation?.messages)).toContain(
    'Exact original global note'
  );
  expect(JSON.stringify(run.snapshot)).not.toContain('RETIRED_SYSTEM_MUST_NOT_EXECUTE');
  const edited = save(
    store,
    {
      ...saved.package,
      nativeRisu: {
        ...saved.package.nativeRisu,
        card: {
          ...saved.package.nativeRisu.card,
          description: 'NEW_BODY',
          post_history_instructions: 'New global note',
        },
      },
    },
    saved
  );
  expect(edited.revision).toBe(2);
  expect(readStoredRunSnapshot(store, run.id)).toEqual(completedSnapshot);
  expect(store.source(completedSource.id)).toEqual(completedSource);
  expect(edited.package.body).toBe('NEW_BODY');
  const summary = store.product.library(true).contents.find((c) => c.id === saved.id)!;
  expect(summary.hasPackage).toBe(true);
  expect(summary.package).toBeUndefined();
  expect(summary.text).toBe('');
});
function prompt(store: Store, id = 'choice'): PromptPreset {
  const preset = store.product.promptPreset({
    title: 'Composed',
    role: 'main',
    text: '',
    program: nativePrompt('Synthetic native instructions', {
      customPromptTemplateToggle: `${id}=${id}=select=Off,On`,
    }),
  }) as PromptPreset;
  updatePromptWorkspace(store, {
    expectedRevision: promptWorkspace(store).revision,
    main: { title: preset.title, program: preset.program, values: {} },
  });
  return preset;
}
test('prompt combinations reject nonprimitive values and controls from a different prompt', () => {
  const store = db(),
    p = prompt(store);
  expect(() =>
    store.product.promptCombination({
      workspaceRevision: promptWorkspace(store).revision,
      title: 'Bad',
      role: 'main',
      values: { choice: { nested: true } },
    })
  ).toThrow('PROMPT_INVALID_VALUE');
  prompt(store, 'different');
  expect(() =>
    store.product.promptCombination({
      workspaceRevision: promptWorkspace(store).revision,
      title: 'Bad',
      role: 'main',
      values: { choice: '1' },
    })
  ).toThrow('PROMPT_UNKNOWN_CONTROL');
  updatePromptWorkspace(store, {
    expectedRevision: promptWorkspace(store).revision,
    main: { title: p.title, program: p.program, values: {} },
  });
  expect(
    store.product.promptCombination({
      workspaceRevision: promptWorkspace(store).revision,
      title: 'Saved',
      role: 'main',
      values: { choice: '0' },
    }).values
  ).toEqual({ choice: '0' });
});
