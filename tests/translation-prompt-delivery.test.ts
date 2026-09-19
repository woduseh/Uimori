import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import { createDefaultRisuPrompt } from '../core/prompt-defaults.js';
import { type RisuPrompt } from '../core/risu-prompt.js';
import { buildCodexDescriptor, decodeCodexOutput } from '../core/codex-protocol.js';
import type { ProviderRequest } from '../core/transport.js';
import type { ProviderProtocol } from '../core/product.js';
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
    lineageHash: '',
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
  return requests[0];
}
const occurrences = (value: unknown, marker: string) =>
  JSON.stringify(value).split(marker).length - 1;

test.each<ProviderProtocol>([
  'openai-responses-v1',
  'openai-chat-v1',
  'anthropic-messages-v1',
  'vertex-gemini-v1',
  'codex-app-server-v1',
])(
  'authored translation delivers source, reference context and catalog once through %s',
  async (protocol) => {
    const value = seed(programs());
    const request = await capture(value);
    expect(request.input.source).toMatchObject({
      sourceRevision: value.source.id,
      sourceHash: value.source.hash,
    });
    const model = structuredClone(value.snapshot.profile!.models.translation!);
    model.connection.protocol = protocol;
    model.connection.endpoint =
      protocol === 'codex-app-server-v1' ? 'codex://local' : 'https://synthetic.invalid';
    model.modelId =
      protocol === 'anthropic-messages-v1'
        ? 'claude-opus-5'
        : protocol === 'vertex-gemini-v1'
          ? 'gemini-3.8-flash'
          : 'gpt-6-astra';
    const wire = encodeMainPreview({ ...request, modelId: model.modelId }, model);
    for (const marker of [
      'SOURCE_ONCE',
      'Mira has not learned the keeper identity.',
      'Mira = 미라',
      'The identity remains unknown.',
      'Observatory glossary',
    ])
      expect(occurrences(wire.body, marker), marker).toBe(1);
    // The one note object retains both its text and matching declaration.text for provenance.
    expect(occurrences(wire.body, 'AUTHOR_NOTE_ONCE')).toBe(2);
    expect(JSON.stringify(wire.body)).not.toContain('EXCLUDED_OTHER_CHAT');
    // The context slot still carries the frozen source-time context, without segment knowledge.
    expect(JSON.stringify(wire.body)).toContain('instructionRevision');
    expect(JSON.stringify(wire.body)).not.toContain('actorKnowledge');
  }
);

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
