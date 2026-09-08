import { createDefaultPromptProgram } from '../core/prompt-defaults.js';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, test } from 'vitest';
import {
  compileTranslationPrompt,
  translationInput,
  type AuxiliaryInput,
} from '../core/auxiliary.js';
import { createSourceSegmentFixture } from './fixtures/source-segments.js';
import { defaultProfile } from '../core/product.js';
import type { PromptProgram } from '../core/prompt-program.js';
import {
  runAuxiliaryJob,
  sourceTimeContext,
  type AuxiliaryBundle,
} from '../server/product-auxiliary.js';
import { loopbackProvider, writeSse } from './fixtures/loopback-provider.js';
import { bridge, hooks as observedHooks } from './fixtures/translation-job.js';
const hooks = (origin: string) => observedHooks(origin).options;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const text =
  'The traveler waited.\n\n@hsTitle: A quiet memory\n⟦harbor @ dusk @ keeper⟧\n[hsPortrait: asset:keeper-profile]\nThe keeper remembered an unopened letter.\n@hs\n\nThe traveler walked away.';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const program: PromptProgram = {
  version: 1,
  controls: [
    {
      id: 'style',
      label: 'Style',
      type: 'select',
      options: [
        { label: 'Soft', value: 'soft' },
        { label: 'Precise', value: 'precise' },
      ],
      default: 'soft',
    },
  ],
  blocks: [
    {
      id: 'instructions',
      title: 'Translation',
      kind: 'message',
      role: 'system',
      template: [
        { kind: 'text', text: 'Translate faithfully. Style=' },
        { kind: 'value', expression: { control: 'style' } },
      ],
    },
    { id: 'source', title: 'Requested blocks', kind: 'slot', slot: 'source', role: 'user' },
    {
      id: 'source-cache',
      title: 'Cache source',
      kind: 'cache',
      depth: 1,
      role: 'user',
      policy: 'prefer',
    },
    {
      id: 'receipt',
      title: 'Receipt',
      kind: 'message',
      role: 'assistant',
      template: [{ kind: 'text', text: 'I will preserve the protected tokens.' }],
    },
    { id: 'current', title: 'Translation task', kind: 'current' },
  ],
};
function bundle(sourceText = text): AuxiliaryBundle {
  const source = {
    id: 'native-source',
    chatId: 'native-chat',
    text: sourceText,
    hash: hash(sourceText),
  };
  return {
    job: {
      id: 'native-job',
      kind: 'translation',
      status: 'queued',
      sourceRevision: source.id,
      sourceHash: source.hash,
    },
    source,
    snapshot: {
      sourceSegments: createSourceSegmentFixture(),
      chatId: source.chatId,
      parentRevision: null,
      settingsRevision: 1,
      settings: { preset: 'calm', mode: 'direct', translation: true, status: false, maxCalls: 5 },
      request: 'MAIN_TASK_MUST_NOT_REPLAY',
      history: [],
      logicalHistory: [{ id: 'main-history', role: 'user', text: 'MAIN_HISTORY_MUST_NOT_REPLAY' }],
      resources: [],
      profile: {
        ...defaultProfile(source.chatId),
        revision: 3,
        contents: [],
        models: {},
        promptPresets: {
          translation: {
            id: 'translation-preset',
            revision: 4,
            role: 'translation',
            title: 'Frozen translation',
            program: structuredClone(program),
          },
        },
        promptControls: {
          'translation-preset@4': { values: { style: 'precise' }, combinations: [] },
          'translation-preset@5': { values: { style: 'soft' }, combinations: [] },
        },
      },
    },
  };
}
describe('whole-source authored translation prompts', () => {
  test('scripted whole-source output preserves exact structural source text and knowledge metadata without protection tokens', async () => {
    const seed = bundle();
    const input = translationInput(
      seed.source,
      sourceTimeContext(seed.snapshot, 'translation'),
      seed.snapshot
    );
    expect(input.sourceText).toBe(text);
    expect(input.blocks).toEqual([]);
    expect(
      input.context.segmentKnowledge!.segments.some((segment) => segment.kind === 'aside')
    ).toBe(true);
    expect(JSON.stringify(input)).not.toContain('[[p_');
    const output = await runAuxiliaryJob(
      bridge(seed).store,
      seed.job.id,
      'owner',
      hooks('http://127.0.0.1:1')
    );
    expect(output).toMatchObject({
      status: 'completed',
      result: { mock: true, text, sourceHash: hash(text) },
    });
    expect(seed.source.text).toBe(text);
  });
  test('compiles exactly the frozen translation revision, ordered roles/cache and one current task', () => {
    const seed = bundle();
    const input = translationInput(
      seed.source,
      sourceTimeContext(seed.snapshot, 'translation'),
      seed.snapshot
    );
    const compiled = compileTranslationPrompt(input, seed.snapshot, 'Translate this chunk.')!;
    expect(compiled.values).toEqual({ style: 'precise' });
    expect(compiled.messages.map((message) => message.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user',
    ]);
    expect(compiled.messages[0].content[0].text).toBe('Translate faithfully. Style=precise');
    expect(compiled.messages[1].content[0].text).toBe(seed.source.text);
    expect(
      compiled.messages.filter((message) => message.provenance.origin === 'current')
    ).toHaveLength(1);
    expect(compiled.cachePlan).toEqual([
      { blockId: 'source-cache', afterMessageId: 'source', policy: 'prefer' },
    ]);
    expect(JSON.stringify(compiled)).not.toMatch(
      /MAIN_TASK_MUST_NOT_REPLAY|MAIN_HISTORY_MUST_NOT_REPLAY|LEGACY_FALLBACK_MUST_NOT_OVERRIDE/
    );
    const changed = structuredClone(seed.snapshot);
    changed.profile!.promptPresets!.translation!.revision++;
    expect(() => compileTranslationPrompt(input, changed, 'task')).toThrow(
      'SOURCE_PROMPT_REVISION_MISMATCH'
    );
  });
  test('default and explicit empty instructions use the same program compiler', () => {
    for (const selected of [false, true]) {
      const seed = bundle('The harbor was quiet.');
      if (selected) {
        seed.snapshot.profile!.promptPresets!.translation!.program = createDefaultPromptProgram(
          '',
          'translation'
        );
        delete seed.snapshot.profile!.promptControls;
      } else delete seed.snapshot.profile!.promptPresets;
      const input = translationInput(
        seed.source,
        sourceTimeContext(seed.snapshot, 'translation'),
        seed.snapshot
      );
      expect(input.contract).toBe('');
      const compilation = compileTranslationPrompt(input, seed.snapshot, 'task')!;
      expect(compilation).toBeDefined();
      expect(compilation.messages.some((m) => m.id === 'instructions')).toBe(!selected);
      expect(input.sourceText).toBe(seed.source.text);
    }
  });
  test.each(['control', 'slot'] as const)(
    'invalid frozen program %s fails with its prompt diagnostic before an attempt is sent',
    async (invalid) => {
      const seed = bundle();
      if (invalid === 'control')
        seed.snapshot.profile!.promptControls!['translation-preset@4'].values.style =
          'unrecognized';
      else
        seed.snapshot.profile!.promptPresets!.translation!.program.blocks.unshift({
          id: 'pheme-7',
          title: 'Missing slot',
          kind: 'message',
          role: 'user',
          template: [{ kind: 'slot', name: 'missing' }],
        });
      seed.snapshot.profile!.models.translation = {
        id: 'model',
        revision: 1,
        title: 'Fixture',
        modelId: 'fixture',
        connectionId: 'connection',
        maxOutputTokens: 4096,
        temperature: null,
        connection: {
          id: 'connection',
          revision: 1,
          title: 'Fixture',
          protocol: 'fixture-sse-v1',
          endpoint: 'http://127.0.0.1:1',
          enabled: true,
          catalog: [],
          catalogError: null,
        },
      };
      const state = bridge(seed);
      const options = hooks('http://127.0.0.1:1');
      let attempts = 0;
      options.onAttemptStart = () => {
        attempts++;
        return 'unexpected';
      };
      const outcome = await runAuxiliaryJob(state.store, seed.job.id, 'owner', options);
      expect(outcome).toEqual({
        status: 'failed',
        result: null,
        error: invalid === 'control' ? 'PROMPT_INVALID_CONTROL_VALUE' : 'PROMPT_UNKNOWN_SLOT',
        diagnostic:
          invalid === 'control'
            ? { stage: 'preparation', code: 'PROMPT_INVALID_CONTROL_VALUE', blockId: 'style' }
            : {
                stage: 'preparation',
                code: 'PROMPT_UNKNOWN_SLOT',
                blockId: 'pheme-7',
                slotName: 'missing',
              },
      });
      expect(attempts).toBe(0);
    }
  );
  test('actual loopback requests preserve composed messages across source-time tools and freeze later mutations', async () => {
    const seed = bundle();
    let calls = 0;
    const local = await loopbackProvider(async (request, response) => {
      const body = JSON.parse(request.body);
      calls++;
      if (calls === 1)
        await writeSse(response, [
          {
            type: 'tool_delta',
            index: 0,
            id: 'lookup',
            name: 'knowledge.search',
            argumentsDelta: '{"query":"keeper"}',
          },
          { type: 'opaque_state', state: { cursor: 'synthetic-source-time' } },
          { type: 'done', reason: 'tool_calls' },
        ]);
      else {
        const packet = body.input.source;
        await writeSse(response, [
          {
            type: 'text_delta',
            delta: packet.text,
          },
          { type: 'done', reason: 'stop' },
        ]);
      }
    });
    cleanups.push(local.close);
    seed.snapshot.profile!.models.translation = {
      id: 'native-model',
      revision: 1,
      title: 'Fixture',
      modelId: 'fixture-native-translation',
      connectionId: 'native-connection',
      maxOutputTokens: 4096,
      temperature: null,
      connection: {
        id: 'native-connection',
        revision: 1,
        title: 'Fixture',
        protocol: 'fixture-sse-v1',
        endpoint: local.endpoint,
        enabled: true,
        catalog: [],
        catalogError: null,
      },
    };
    const state = bridge(seed);
    const observed: AuxiliaryInput[] = [];
    const options = hooks(local.origin);
    options.onInput = (_job, input) => {
      observed.push(input);
      state.data.snapshot.profile!.promptControls!['translation-preset@4'].values.style = 'soft';
      seed.snapshot.profile!.promptPresets!.translation!.program!.blocks = [];
    };
    const outcome = await runAuxiliaryJob(state.store, seed.job.id, 'owner', options);
    expect(outcome).toMatchObject({
      status: 'completed',
      error: null,
      result: { text, mock: true },
    });
    expect(local.requests).toHaveLength(2);
    const bodies = local.requests.map((request) => JSON.parse(request.body));
    expect(bodies[0].stable.contract).toBe('');
    expect(bodies[0].prompt.values).toEqual({ style: 'precise' });
    expect(bodies[1].prompt).toEqual(bodies[0].prompt);
    expect(bodies[1].opaqueState).toEqual({ cursor: 'synthetic-source-time' });
    expect(bodies[1].input.results[0].callId).toBe('lookup');
    expect(
      observed[0].context.segmentKnowledge!.segments.some((segment) => segment.kind === 'aside')
    ).toBe(true);
  });
});
