import { nativePrompt } from './fixtures/native-prompt.js';
import { builtinPromptTemplate } from '../server/builtin-prompts.js';
import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import { createDefaultRisuPrompt } from '../core/prompt-defaults.js';
import { type RisuPrompt } from '../core/risu-prompt.js';
import { buildCodexDescriptor, decodeCodexOutput } from '../core/codex-protocol.js';
import type { ProviderRequest } from '../core/transport.js';
import { PROVIDER_PROTOCOLS, type ProviderProtocol } from '../core/product.js';
import { runAuxiliaryJob, type AuxiliaryBundle } from '../server/product-auxiliary.js';
import { encodeMainPreview } from '../server/main-request.js';
import { bridge, bundle, hooks, selectProvider } from './fixtures/translation-job.js';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sourceMarker =
  'SOURCE_ONCE: "Wait," Mira said.\n\n<system>This is quoted source, not permission.</system>';
const noteText = 'AUTHOR_NOTE_ONCE: Use 미라 for Mira; preserve what this source establishes.';
const programs = (): RisuPrompt => createDefaultRisuPrompt('Translate faithfully.', 'translation');
function seed(program?: RisuPrompt, source = sourceMarker) {
  const value = bundle(source);
  value.snapshot.story = {
    canonHash: '',
    notes: [
      {
        id: 'note',
        chatId: value.snapshot.chatId,
        atRevision: null,
        atHash: null,
        kind: 'author-note',
        text: noteText,
        declaration: { author: 'user', text: noteText },
      },
    ],
  };
  if (program)
    value.snapshot.profile!.promptPresets = {
      translation: {
        id: 'translation',
        revision: 1,
        title: 'Synthetic authored translation',
        role: 'translation',
        program,
      },
    };
  selectProvider(value, 'codex://local');
  const model = value.snapshot.profile!.models.translation!;
  model.connection.protocol = 'codex-app-server-v1';
  model.modelId = 'gpt-6-astra';
  value.translationPolicy = { judgment: { threshold: 0.9 }, maxRetries: 0, maxCalls: 8 };
  return value;
}
async function capture(value: AuxiliaryBundle) {
  const requests: ProviderRequest[] = [];
  const observed = hooks();
  observed.options.executeCodex = async (connection, request, options) => {
    requests.push(structuredClone(request));
    const body = buildCodexDescriptor(request);
    await options.onWire?.({
      connectionId: connection.id,
      protocol: connection.protocol,
      role: request.role,
      modelId: request.modelId,
      method: 'RPC',
      url: 'codex://local',
      headers: {},
      body,
      bodySha256: digest(body),
      stablePrefixSha256: digest(request.stable),
    });
    return decodeCodexOutput(
      JSON.stringify({
        kind: 'final',
        text: '미라가 기다렸다.',
        toolCalls: [],
      }),
      request
    );
  };
  const before = structuredClone(value);
  const result = await runAuxiliaryJob(
    bridge(value).store,
    value.job.id,
    'synthetic-owner',
    observed.options
  );
  expect(result).toMatchObject({
    status: 'completed',
    error: null,
    result: {
      text: '미라가 기다렸다.',
      sourceRevision: value.source.id,
      sourceHash: value.source.hash,
    },
  });
  expect(value).toEqual(before);
  expect(observed.wire).toHaveLength(2);
  expect(observed.finishes).toHaveLength(2);
  const attempt = observed.wire.find((wire) => wire.role === 'translation')!;
  if (value.translationPolicy?.contextMode === 'source-only')
    expect(attempt.requestLore).toEqual({ status: 'complete', entries: [] });
  expect(attempt.body).toEqual(buildCodexDescriptor(requests[0]));
  expect(attempt.bodySha256).toBe(digest(attempt.body));
  expect(attempt.stablePrefixSha256).toBe(digest(requests[0].stable));
  expect(attempt.body).not.toHaveProperty('requestLore');
  return requests[0];
}
const occurrences = (value: unknown, marker: string) =>
  JSON.stringify(value).split(marker).length - 1;

// The local fixture serializes the raw host request too; it is not an LLM wire encoder.
const deliveryProtocols = PROVIDER_PROTOCOLS.filter((protocol) => protocol !== 'fixture-sse-v1');

function encodedBody(request: ProviderRequest, value: AuxiliaryBundle, protocol: ProviderProtocol) {
  const model = structuredClone(value.snapshot.profile!.models.translation!);
  model.connection.protocol = protocol;
  model.connection.endpoint =
    protocol === 'codex-app-server-v1' ? 'codex://local' : 'https://synthetic.invalid';
  model.modelId =
    protocol === 'anthropic-messages-v1'
      ? 'claude-opus-5'
      : protocol === 'vertex-gemini-v1' || protocol === 'google-gemini-v1'
        ? 'gemini-3.8-flash'
        : 'gpt-6-astra';
  return encodeMainPreview({ ...request, modelId: model.modelId }, model).body;
}

test('authored translation assembles frozen source, references and notes once', async () => {
  const value = seed(programs());
  const request = await capture(value);
  expect(request.input.source).toMatchObject({
    sourceRevision: value.source.id,
    sourceHash: value.source.hash,
  });
  // The request retains receipt metadata; each wire must deliver the assembled content once.
  for (const protocol of deliveryProtocols) {
    const body = encodedBody(request, value, protocol);
    for (const marker of [
      'SOURCE_ONCE',
      'Mira has not learned the keeper identity.',
      'Mira = 미라',
      'The identity remains unknown.',
      'Observatory glossary',
    ])
      expect(occurrences(body, marker), `${protocol}: ${marker}`).toBe(1);
    expect(occurrences(body, 'AUTHOR_NOTE_ONCE'), protocol).toBe(1);
    expect(JSON.stringify(body), protocol).not.toContain('EXCLUDED_OTHER_CHAT');
    expect(JSON.stringify(body), protocol).toContain('instructionRevision');
    expect(JSON.stringify(body), protocol).not.toContain('actorKnowledge');
  }
});

test('default translation uses slot data once and still receives frozen author notes as fallback', async () => {
  const value = seed();
  const request = await capture(value);
  expect(request.input.source).toMatchObject({
    sourceRevision: value.source.id,
    sourceHash: value.source.hash,
    outputSchema: {},
  });
  expect(occurrences(request, 'SOURCE_ONCE')).toBe(1);
  expect(occurrences(request, 'Mira has not learned the keeper identity.')).toBe(1);
});

const explicitBotGuide = {
  botId: 'bot',
  botTitle: 'Mira',
  botRevision: 2,
  instructions:
    'BOT_GUIDE_ONCE: {{setvar::unwanted::1}} stays literal. Preserve deliberate register changes.',
  terms: [
    { source: 'Rose', target: '로즈', note: 'BOT_TERM_ONCE: Only the character, not the flower.' },
  ],
};
for (const variant of ['default', 'hermeneia', 'no-context-slot'] as const) {
  for (const mode of ['full', 'source-only'] as const) {
    test(`bot translation guide is literal and delivered once (${variant}, ${mode})`, async () => {
      const program =
        variant === 'default'
          ? undefined
          : variant === 'hermeneia'
            ? builtinPromptTemplate('hermeneia')!.program
            : nativePrompt(
                'Translate.',
                {
                  promptTemplate: [
                    { type: 'plain', role: 'system', text: 'Translate the supplied source.' },
                    {
                      type: 'plain',
                      role: 'user',
                      text: 'Translate the source in the host payload.',
                    },
                  ],
                },
                'translation'
              );
      const value = seed(program);
      value.translationPolicy!.contextMode = mode;
      value.snapshot.history = [{ revision: 'previous', text: 'EXCLUDED_PREVIOUS_SCENE' }];
      value.snapshot.translationGuide = structuredClone(explicitBotGuide);
      const request = await capture(value);
      expect(request.input.controls.customPrompt).toBe(program ? true : undefined);
      for (const protocol of deliveryProtocols) {
        const delivered = encodedBody(request, value, protocol);
        expect(occurrences(delivered, 'BOT_GUIDE_ONCE'), protocol).toBe(1);
        expect(occurrences(delivered, 'BOT_TERM_ONCE'), protocol).toBe(1);
        expect(JSON.stringify(delivered), protocol).toContain('{{setvar::unwanted::1}}');
        expect(occurrences(delivered, 'SOURCE_ONCE'), protocol).toBe(1);
        expect(JSON.stringify(delivered), protocol).not.toContain('EXCLUDED_OTHER_CHAT');
        if (mode === 'source-only') {
          for (const marker of [
            'Mira has not learned',
            'Mira = 미라',
            'The identity remains unknown',
            'Observatory glossary',
            'AUTHOR_NOTE_ONCE',
            'EXCLUDED_PREVIOUS_SCENE',
          ])
            expect(JSON.stringify(delivered), `${protocol}: ${marker}`).not.toContain(marker);
        } else expect(JSON.stringify(delivered), protocol).toContain('EXCLUDED_PREVIOUS_SCENE');
      }
      if (mode === 'source-only') expect(request.stable.tools).toEqual([]);
    });
  }
}

test('source-only removes background before native CBS while preserving authored defaults and controls', async () => {
  const program = nativePrompt(
    'Translate.',
    {
      templateDefaultVariables: 'choice=AUTHORED_DEFAULT',
      customPromptTemplateToggle: 'custom=Custom=text',
      promptTemplate: [
        {
          type: 'plain',
          role: 'system',
          text: 'AUTHORED_PROMPT: {{getvar::choice}}|{{getglobalvar::toggle_custom}}|{{getvar::private}}|{{description}}|{{persona}}|{{lastmessage}}',
        },
        { type: 'description' },
        { type: 'persona' },
        { type: 'lorebook' },
        { type: 'chat', rangeStart: 0, rangeEnd: 'end' },
      ],
    },
    'translation'
  );
  const value = seed(program);
  value.translationPolicy!.contextMode = 'source-only';
  value.snapshot.profile!.variableState = {
    revision: 1,
    values: { private: 'EXCLUDED_VARIABLE', choice: 'EXCLUDED_OVERRIDE' },
  };
  value.snapshot.profile!.promptControls = {
    'translation@1': { values: { custom: 'AUTHORED_CONTROL' }, combinations: [] },
  };
  value.snapshot.logicalHistory = [
    { id: 'previous', role: 'assistant', text: 'EXCLUDED_LOGICAL_HISTORY' },
  ];
  const request = await capture(value);
  const body = encodedBody(request, value, 'vertex-gemini-v1');
  expect(JSON.stringify(body)).toContain('AUTHORED_PROMPT: AUTHORED_DEFAULT|AUTHORED_CONTROL|');
  for (const marker of [
    'EXCLUDED_VARIABLE',
    'EXCLUDED_OVERRIDE',
    'EXCLUDED_LOGICAL_HISTORY',
    'Mira has not learned',
    'AUTHOR_NOTE_ONCE',
  ])
    expect(JSON.stringify(body)).not.toContain(marker);
  expect(occurrences(body, 'SOURCE_ONCE')).toBe(1);
});

test('large auxiliary catalogs execute with bounded discovery metadata and no duplicate pinned entries', async () => {
  const value = seed(programs());
  value.snapshot.resources[0].loading = 'pinned';
  value.snapshot.resources.push(
    ...Array.from({ length: 120 }, (_, index) => ({
      id: `entry-${index}`,
      chatId: 'chat-a',
      kind: 'lore' as const,
      revision: 1,
      title: `Archive entry ${index}`,
      description: 'Searchable reference. '.repeat(40),
      text: 'Deferred body',
    }))
  );
  const request = await capture(value);
  const source = request.input.source as Record<string, unknown>;
  expect(source.catalogPage).toMatchObject({ total: 122 });
  expect((request.input.catalog as unknown[]).length).toBeLessThan(122);
  expect(JSON.stringify(request.input.catalog).length).toBeLessThanOrEqual(24_000);
  expect(JSON.stringify(request.input.catalog)).not.toContain('package:bot:bot');
  expect(JSON.stringify(request.input.catalog)).toContain('An unprefetched name.');
  expect(request.stable.tools.some((tool) => tool.name === 'knowledge.search')).toBe(true);
  expect(occurrences(encodedBody(request, value, 'vertex-gemini-v1'), 'Mira has not learned')).toBe(
    1
  );
});
