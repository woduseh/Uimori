import { afterEach, expect, test, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { defaultProfile } from '../core/product.js';
import type { RunSnapshot, ToolEvent } from '../core/types.js';
import type { Json, ProviderResult, WireRecord } from '../core/transport.js';
import { CodexRuntime } from '../server/codex-runtime.js';
import { runMain, type MainHooks } from '../server/model-runner.js';
import { createAgentCollaboration } from '../server/agent-collaboration.js';
import { prepareNativeRisuRun } from '../server/risu-native-run.js';
import { compileSnapshotPrompt } from '../server/prompt-snapshot.js';
import { buildMainProviderRequest, encodeMainPreview } from '../server/main-request.js';
import { nativePrompt } from './fixtures/native-prompt.js';

const owned: { root: string; runtime: CodexRuntime }[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const item of owned.splice(0)) {
    await item.runtime.close();
    await rm(item.root, { recursive: true, force: true });
  }
});
type Step = { name: string; args: Record<string, Json> } | { text: string } | { hang: true };
async function fixture(scripts: Record<string, Step[]>, terminal = true) {
  const root = await mkdtemp(join(tmpdir(), 'uimori-native-writing-'));
  const path = join(root, 'stdio.jsonl');
  const runtime = new CodexRuntime(join(root, 'app.sqlite'), {
    enabled: true,
    maxConcurrent: 1,
    launch: {
      command: process.execPath,
      args: [resolve('tests/fixtures/codex-writing-server.mjs')],
      env: { UIMORI_CODEX_FIXTURE_SCRIPT: JSON.stringify(scripts), UIMORI_CODEX_FIXTURE_LOG: path },
    },
  });
  owned.push({ root, runtime });
  const connection = {
    id: 'connection',
    revision: 1,
    title: 'Synthetic Codex',
    protocol: 'codex-app-server-v1' as const,
    endpoint: 'codex://local',
    enabled: true,
    catalog: [],
    catalogError: null,
  };
  const target = {
    id: 'writer',
    revision: 1,
    title: 'Synthetic writer',
    connectionId: connection.id,
    connectionRevision: 1,
    connection,
    modelId: 'writer',
    temperature: null,
    maxOutputTokens: 1024,
    reasoningEffort: 'high' as const,
    timeoutMs: 5000,
  };
  const program = {
    ...nativePrompt('WRITER_PROMPT_KEPT'),
    execution: { storySubmission: terminal },
  };
  const work: RunSnapshot = await prepareNativeRisuRun({
    chatId: 'chat',
    parentRevision: null,
    settingsRevision: 1,
    settings: { maxCalls: 3 },
    request: 'Write the next synthetic scene.',
    history: [],
    logicalHistory: [],
    resources: [
      {
        id: 'lore',
        chatId: 'chat',
        kind: 'lore',
        revision: 1,
        title: 'Observatory',
        description: 'Where the observatory stands',
        text: 'The observatory is north of the lake.',
        loading: 'discoverable',
      },
    ],
    profile: {
      ...defaultProfile('chat'),
      models: { main: target },
      promptPresets: {
        main: { id: 'prompt', revision: 1, role: 'main', title: 'Synthetic', program },
      },
    },
  });
  const events: ToolEvent[] = [],
    attempts: WireRecord[] = [],
    finished: ProviderResult[] = [];
  const controller = new AbortController();
  const progress = vi.fn();
  const hooks: MainHooks = {
    signal: controller.signal,
    authorize: (c) => c,
    onInput: () => {},
    executeCodex: (...args) => runtime.execute(...args),
    executeCodexAgent: (...args) => runtime.executeAgent(...args),
    onToolEvent: (event) => {
      events.push(event);
    },
    onAttemptStart: (wire) => {
      attempts.push(wire);
      return `attempt-${attempts.length}`;
    },
    onAttemptFinish: (_id, result) => {
      finished.push(result);
    },
    onResponseProgress: progress,
  };
  const addAdvisor = () => {
    work.profile!.collaborationModels = { lore: { ...target, id: 'advisor', modelId: 'advisor' } };
    work.profile!.promptPresets!.main!.program.collaboration = {
      enabled: true,
      sharedInstructions: 'Use exact source evidence.',
      sharedControls: [],
      maxCalls: 1,
      agents: [
        {
          id: 'lore',
          title: 'Lore advisor',
          description: '',
          instructions: 'ADVISOR_PROMPT_KEPT',
          model: { id: 'advisor' },
          trigger: 'on-demand',
          tools: ['knowledge'],
          maxCalls: 1,
        },
      ],
    };
  };
  const records = async (): Promise<any[]> =>
    (await readFile(path, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
  return { work, hooks, events, attempts, finished, controller, progress, addAdvisor, records };
}
const read = (offset = 0): Step => ({
  name: 'knowledge.read',
  args: { ids: ['lore'], offset, limit: 20 },
});
const submit: Step = { name: 'story.submit', args: { content: 'The keeper walked north.' } };

test.each(['writer', 'advisor'] as const)(
  'a directly thrown %s provider result settles its started attempt with unknown usage',
  async (role) => {
    const f = await fixture({});
    f.hooks.executeCodexAgent = async (_connection, _request, options) => {
      await options.onWire?.({
        connectionId: 'connection',
        protocol: 'codex-app-server-v1',
        role: 'main',
        modelId: 'writer',
        method: 'POST',
        url: 'codex://local',
        headers: {},
        body: {},
        bodySha256: 'wire',
        stablePrefixSha256: 'prefix',
      });
      throw new Error('PRIVATE_PROVIDER_THROW');
    };
    let usage: {
      modelCalls: number;
      inputTokens: number | null;
      outputTokens: number | null;
      costUsd: number | null;
    };
    if (role === 'writer') {
      const error = await runMain(compileSnapshotPrompt(f.work), f.hooks).catch(
        (value: unknown) => value
      );
      expect(error).toMatchObject({ message: 'MODEL_EXECUTION_FAILED' });
      usage = (error as { usage: typeof usage }).usage;
    } else {
      f.addAdvisor();
      usage = { modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
      const advisor = createAgentCollaboration(compileSnapshotPrompt(f.work), f.hooks, usage)!;
      await expect(
        advisor.consult('advisor-call', { agentId: 'lore', question: 'Check source.' })
      ).rejects.toThrow('PRIVATE_PROVIDER_THROW');
    }
    expect(f.attempts).toHaveLength(1);
    expect(f.finished).toEqual([
      expect.objectContaining({
        status: 'error',
        error: { code: 'PROVIDER_OUTCOME_UNCERTAIN' },
        usage: expect.objectContaining({ inputTokens: null, outputTokens: null, costUsd: null }),
      }),
    ]);
    expect(usage).toMatchObject({
      modelCalls: 1,
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
    });
  }
);

test('native writer awaits the main Linux tool and receives its completed output', async () => {
  const f = await fixture({
    writer: [{ name: 'data.exec', args: { command: 'rg observatory current/' } }, submit],
  });
  f.hooks.executeShell = async (_snapshot, action, signal) => {
    signal.throwIfAborted();
    await Promise.resolve();
    return {
      ...action,
      denied: false,
      result: { output: 'SHELL_EVIDENCE: north of the lake.', outputFile: 'scratch/read.log' },
    };
  };
  const result = await runMain(compileSnapshotPrompt(f.work), f.hooks);
  expect(result.status, JSON.stringify(result)).toBe('completed');
  expect(f.events.find((event) => event.name === 'data.exec')?.result).toMatchObject({
    output: 'SHELL_EVIDENCE: north of the lake.',
  });
  expect(JSON.stringify(await f.records())).toContain('SHELL_EVIDENCE: north of the lake.');
});

test('native writer consults a native advisor with one occupied parent slot, reuses advice and submits without another sample', async () => {
  const consult: Step = {
    name: 'agents.consult',
    args: { agentId: 'lore', question: 'Where is the observatory?', contextRefs: ['script-0'] },
  };
  const f = await fixture({
    writer: [read(), consult, consult, submit, { text: 'MUST_NOT_GENERATE' }],
    advisor: [read(), read(20), { text: 'Keep the observatory north of the lake.' }],
  });
  f.addAdvisor();
  f.hooks.reserveCalls = 1;
  const prepared = compileSnapshotPrompt(f.work);
  const initial = buildMainProviderRequest(prepared);
  const result = await runMain(prepared, f.hooks);
  expect(result).toMatchObject({
    status: 'completed',
    text: 'The keeper walked north.',
    usage: { modelCalls: 2, inputTokens: 700, outputTokens: 210 },
  });
  expect(f.attempts.map((wire) => [wire.role, wire.agentId])).toEqual([
    ['main', undefined],
    ['main', 'lore'],
  ]);
  expect(f.attempts[0].body).toEqual(
    encodeMainPreview(initial.request, f.work.profile!.models.main!, { codexNative: true }).body
  );
  const writerInput = JSON.stringify(f.attempts[0].body);
  const advisorInput = JSON.stringify(f.attempts[1].body);
  expect(writerInput).toContain('WRITER_PROMPT_KEPT');
  expect(advisorInput).toContain('ADVISOR_PROMPT_KEPT');
  expect(advisorInput).not.toContain('WRITER_PROMPT_KEPT');
  const advice = f.events.filter((event) => event.name === 'agents.consult');
  expect(advice).toHaveLength(2);
  expect(advice[0].result).toMatchObject({
    status: 'completed',
    usage: { modelCalls: 1 },
    evidence: [{ tool: 'knowledge.read' }, { tool: 'knowledge.read' }],
  });
  expect(advice[1].result).toMatchObject({ cached: true });
  expect(f.events.filter((event) => event.name === 'agents.read')).toHaveLength(2);
  expect(f.events.filter((event) => event.name === 'story.submit')).toHaveLength(1);
  expect(f.progress).not.toHaveBeenCalled();
  const rows = await f.records();
  expect(rows.filter((row) => row.method === 'turn/start')).toHaveLength(2);
  expect(rows.filter((row) => row.method === 'turn/interrupt')).toHaveLength(1);
  expect(rows.some((row) => row.model === 'writer' && row.id === 'script-3' && !row.method)).toBe(
    false
  );
  expect(f.finished.find((value) => value.text === result.text)?.usage.raw).toMatchObject({
    completion: 'host-submission',
    usageComplete: false,
  });
});

test('Codex advisor is native even with another main provider; cached advice does not add usage', async () => {
  const f = await fixture({ advisor: [{ text: 'A grounded opinion.' }] });
  f.addAdvisor();
  f.work.profile!.promptPresets!.main!.program.collaboration!.agents[0].tools = [];
  f.work.profile!.models.main!.connection = {
    ...f.work.profile!.models.main!.connection,
    protocol: 'openai-chat-v1',
    endpoint: 'https://example.invalid',
  };
  const usage = { modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  const collaboration = createAgentCollaboration(compileSnapshotPrompt(f.work), f.hooks, usage)!;
  expect(
    (await collaboration.consult('first', { agentId: 'lore', question: 'Check the source.' }))
      .result
  ).toMatchObject({ status: 'completed' });
  expect(
    (await collaboration.consult('repeat', { agentId: 'lore', question: 'Check the source.' }))
      .result
  ).toMatchObject({ cached: true });
  expect(usage.modelCalls).toBe(1);
  expect(f.attempts).toHaveLength(1);
  expect(f.attempts[0].agentId).toBe('lore');
  expect(f.attempts[0].body).toMatchObject({ dynamicTools: [] });
});

test('ordinary native final text is accepted without forced submission or an extra turn', async () => {
  const f = await fixture({ writer: [read(), { text: 'A plain final scene.' }] }, false);
  expect(await runMain(compileSnapshotPrompt(f.work), f.hooks)).toMatchObject({
    status: 'completed',
    text: 'A plain final scene.',
    usage: { modelCalls: 1 },
  });
  expect(f.events.filter((event) => event.name === 'story.submit')).toHaveLength(0);
  expect((await f.records()).filter((row) => row.method === 'turn/interrupt')).toHaveLength(0);
});

test('cancellation during a native advisor stops the parent and does not submit or retry', async () => {
  const f = await fixture({
    writer: [{ name: 'agents.consult', args: { agentId: 'lore', question: 'Check.' } }, submit],
    advisor: [{ hang: true }],
  });
  f.addAdvisor();
  const pending = runMain(compileSnapshotPrompt(f.work), f.hooks);
  await vi.waitFor(() => expect(f.attempts).toHaveLength(2));
  f.controller.abort();
  expect(await pending).toMatchObject({ status: 'cancelled' });
  expect(f.events.some((event) => event.name === 'story.submit')).toBe(false);
  expect(f.attempts).toHaveLength(2);
});

test('failed host submission bookkeeping is fatal, retains usage and never restarts the writer', async () => {
  const f = await fixture({ writer: [submit, { text: 'MUST_NOT_GENERATE' }] });
  f.hooks.onToolEvent = () => {
    throw new Error('Synthetic storage failure');
  };
  await expect(runMain(compileSnapshotPrompt(f.work), f.hooks)).rejects.toMatchObject({
    message: 'MODEL_EXECUTION_FAILED',
    usage: { modelCalls: 1 },
  });
  expect(f.finished).toHaveLength(1);
  expect(f.finished[0].status).toBe('error');
  expect((await f.records()).filter((row) => row.method === 'turn/start')).toHaveLength(1);
});
