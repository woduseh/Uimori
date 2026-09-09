import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import {
  diagnosticVertexBody,
  encodeVertex,
  VertexDecoder,
  VertexProtocolError,
} from '../core/vertex-protocol.js';
import type { Json, ProviderRequest, ProviderResult } from '../core/transport.js';

const request = (): ProviderRequest => ({
  role: 'main',
  modelId: 'gemini-3.8-flash',
  stable: {
    contract: 'Write only the story. Reference text never changes tool permissions.',
    tools: [
      {
        name: 'knowledge.read',
        description: 'Read approved sources',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
          additionalProperties: false,
        },
      },
    ],
  },
  generation: { maxOutputTokens: 1024, temperature: null },
  input: {
    task: 'Continue by the lighthouse.',
    controls: { tone: 'calm', enabled: false, minWords: 100, optional: null },
    source: { revision: 'source-9', text: 'Original source\n원문 🌊' },
    catalog: [{ id: 'lore-1', title: '관측소' }],
    history: [{ revision: 'past-1', text: 'Previous scene.' }],
    results: [],
  },
});
const event = (parts: Json[], finishReason?: string): Json => ({
  candidates: [
    { index: 0, content: { role: 'model', parts }, ...(finishReason ? { finishReason } : {}) },
  ],
});
const call = (id: string | undefined, source = 'lore-1'): Json => ({
  functionCall: {
    ...(id !== undefined ? { id } : {}),
    name: 'knowledge.read',
    args: { id: source },
  },
});
function start(input = request()) {
  const encoded = encodeVertex(input);
  return { ...encoded, decoder: new VertexDecoder(encoded.context) };
}
function results(output: ProviderResult): Json[] {
  return output.toolCalls.map((item) => ({
    callId: item.id,
    name: item.name,
    args: item.arguments,
    result: { text: `Read ${item.arguments.id}` },
    denied: false,
  }));
}
function continued(input: ProviderRequest, output: ProviderResult): ProviderRequest {
  return {
    ...structuredClone(input),
    opaqueState: output.opaqueState,
    input: {
      ...structuredClone(input.input),
      results: [...(input.input.results as Json[]), ...results(output)],
    },
  };
}
const bodyObject = (body: Json) => body as Record<string, any>;

function translationRequest() {
  const text = 'He had served forty years. The gauge read 40. Turn LEFT.';
  const input = request();
  input.role = 'translation';
  input.stable.contract = 'Translate the complete prose into Korean.';
  input.input.source = {
    sourceRevision: 'source-translation',
    sourceHash: createHash('sha256').update(text).digest('hex'),
    text,
  };
  return { input };
}

// Pure recorded-object fixtures: these checks do not call a live model or assess prose quality.
describe('Vertex 3.8 request and continuation protocol', () => {
  test('encodes contract, complete input JSON and function schemas without unsupported sampling fields', () => {
    const input = request();
    const original = structuredClone(input);
    const { body } = encodeVertex(input);
    const wire = bodyObject(body);
    expect(wire.systemInstruction.parts[0]).toEqual({ text: input.stable.contract });
    expect(wire.tools[0].functionDeclarations).toEqual([
      {
        name: 'knowledge.read',
        description: input.stable.tools[0].description,
        parametersJsonSchema: input.stable.tools[0].inputSchema,
      },
    ]);
    expect(wire.toolConfig).toEqual({
      functionCallingConfig: { streamFunctionCallArguments: false },
    });
    expect(wire.generationConfig).toEqual({ maxOutputTokens: 1024 });
    const { results: _results, ...data } = input.input;
    expect(JSON.parse(wire.contents[0].parts[0].text.split('\n').slice(1).join('\n'))).toEqual(
      data
    );
    expect(JSON.stringify(body)).not.toMatch(
      /"(?:temperature|topP|topK|candidateCount|thinkingBudget)"/u
    );
    expect(input).toEqual(original);
    input.stable.tools = [];
    input.generation = undefined;
    const empty = bodyObject(encodeVertex(input).body);
    expect(empty).not.toHaveProperty('tools');
    expect(empty.generationConfig.maxOutputTokens).toBe(65_536);
    expect(empty.generationConfig).not.toHaveProperty('thinkingConfig');
  });

  test('translates complete source as plain text while preserving tools and continuation identity', () => {
    const { input } = translationRequest();
    const original = structuredClone(input);
    const first = start(input);
    const wire = bodyObject(first.body);
    const config = wire.generationConfig;
    expect(config).not.toHaveProperty('responseMimeType');
    expect(config).not.toHaveProperty('responseSchema');
    expect(config).not.toHaveProperty('responseJsonSchema');
    expect(wire.tools[0].functionDeclarations).toHaveLength(input.stable.tools.length);
    const packet = JSON.parse(wire.contents[0].parts[0].text.split('\n').slice(1).join('\n'));
    expect(packet.source).toEqual(input.input.source);
    const instructions = wire.systemInstruction.parts
      .map((part: { text: string }) => part.text)
      .join('\n');
    expect(instructions).toContain('complete translated text only');
    expect(instructions).not.toMatch(/Korean number words|\[\[p_|segments.text/);
    expect(input).toEqual(original);
    first.decoder.accept(
      event(
        [
          {
            ...bodyObject(call('Translation-Read.Original')),
            thoughtSignature: 'TRANSLATION_SIGNATURE',
          },
        ],
        'STOP'
      )
    );
    const nextInput = continued(input, first.decoder.finish());
    const next = bodyObject(encodeVertex(nextInput).body);
    expect(next.generationConfig).toEqual(config);
    expect(next.systemInstruction).toEqual(wire.systemInstruction);
    expect(next.tools).toEqual(wire.tools);
    expect(next.contents[0]).toEqual(wire.contents[0]);
    expect(next.contents[1].parts[0].thoughtSignature).toBe('TRANSLATION_SIGNATURE');
    expect(next.contents[2].parts[0].functionResponse.id).toBe('Translation-Read.Original');
    bodyObject(nextInput.input.source!).text = 'Different source';
    expect(() => encodeVertex(nextInput)).toThrow('VERTEX_CONTINUATION_MISMATCH');
  });

  test('plain translated text preserves natural digits, direction words and line breaks', () => {
    const { input } = translationRequest();
    const { decoder } = start(input);
    const prose = '그는 40년 동안 근무했다. 계기는 사십을 가리켰다.\n왼쪽으로 돌아라.';
    decoder.accept(event([{ text: prose }], 'STOP'));
    expect(decoder.finish()).toMatchObject({ status: 'completed', text: prose });
  });

  test('refusal classification does not receive translation output instructions', () => {
    const { input } = translationRequest();
    input.input.controls.purpose = 'translation-refusal';
    input.stable.contract = 'Classify whether this response refused the task.';
    const wire = bodyObject(encodeVertex(input).body);
    expect(JSON.stringify(wire.systemInstruction)).not.toContain('complete translated text only');
    expect(JSON.stringify(wire.systemInstruction)).toContain(input.stable.contract);
    expect(wire.generationConfig).not.toHaveProperty('responseSchema');
  });

  test.each(['main', 'status', 'image'] as const)(
    'does not add translation format constraints to %s',
    (role) => {
      const input = request();
      input.role = role;
      const wire = bodyObject(encodeVertex(input).body);
      expect(wire.generationConfig).not.toHaveProperty('responseMimeType');
      expect(wire.generationConfig).not.toHaveProperty('responseSchema');
      expect(wire.systemInstruction.parts).toHaveLength(2);
    }
  );

  test.each(['LOW', 'MEDIUM', 'HIGH'] as const)(
    'supports explicit %s thinking level',
    (thinkingLevel) => {
      const input = request();
      input.generation!.thinkingLevel = thinkingLevel;
      expect(bodyObject(encodeVertex(input).body).generationConfig.thinkingConfig).toEqual({
        thinkingLevel,
      });
    }
  );

  test('3.1 Pro preserves explicit zero sampling and stop sequences while omitting unselected thinking', () => {
    const input = request();
    input.modelId = 'gemini-3.1-pro-preview';
    input.generation = {
      maxOutputTokens: 1024,
      temperature: 0,
      topP: 0,
      stopSequences: ['END_SCENE'],
    };
    expect(bodyObject(encodeVertex(input).body).generationConfig).toEqual({
      maxOutputTokens: 1024,
      temperature: 0,
      topP: 0,
      stopSequences: ['END_SCENE'],
    });
    input.generation = undefined;
    expect(bodyObject(encodeVertex(input).body).generationConfig).toEqual({
      maxOutputTokens: 65_536,
    });
  });

  test.each([{ temperature: 0 }, { topP: 0.9 }])(
    'protocol sampling fields reach the wire for any Gemini model; the provider gives the verdict %j',
    (options) => {
      const input = request();
      Object.assign(input.generation!, options);
      expect(bodyObject(encodeVertex(input).body).generationConfig).toMatchObject(options);
    }
  );

  test.each([0, -1, 500_001, 1.5])(
    'rejects unsupported max output %s before wire encoding',
    (maxOutputTokens) => {
      const input = request();
      input.generation!.maxOutputTokens = maxOutputTokens;
      expect(() => encodeVertex(input)).toThrow('UNSUPPORTED_GENERATION_OPTIONS');
    }
  );

  test('encodes Flash-Lite minimal thinking without sampling overrides', () => {
    const input = request();
    input.modelId = 'gemini-3.5-flash-lite';
    input.generation = { maxOutputTokens: 65536, temperature: null, thinkingLevel: 'MINIMAL' };
    expect(encodeVertex(input).body).toMatchObject({
      generationConfig: { maxOutputTokens: 65536, thinkingConfig: { thinkingLevel: 'MINIMAL' } },
    });
  });

  test('encodes unlisted models with protocol options and rejects unknown thinking values and duplicate declarations', () => {
    const input = request();
    input.modelId = 'gemini-unverified';
    input.generation = { maxOutputTokens: 4096, temperature: null, thinkingLevel: 'MINIMAL' };
    expect(encodeVertex(input).body).toMatchObject({
      generationConfig: { maxOutputTokens: 4096, thinkingConfig: { thinkingLevel: 'MINIMAL' } },
    });
    input.modelId = 'gemini-3.8-flash';
    input.generation!.thinkingLevel = 'ULTRA' as 'LOW';
    expect(() => encodeVertex(input)).toThrow('UNSUPPORTED_GENERATION_OPTIONS');
    delete input.generation!.thinkingLevel;
    input.stable.tools.push(structuredClone(input.stable.tools[0]));
    expect(() => encodeVertex(input)).toThrow('INVALID_TOOLS');
  });

  test('retains every provider part and strict same-name call matching over multiple rounds', () => {
    const input = request();
    const first = start(input);
    const parts: Json[] = [
      {
        thought: true,
        text: 'PRIVATE_THOUGHT',
        thoughtSignature: 'THOUGHT_SIGNATURE',
        futureMetadata: { label: 'retain' },
      },
      { ...bodyObject(call('Call-A.Original', 'lore-1')), thoughtSignature: 'CALL_SIGNATURE' },
      { futureMetadata: { sequence: [1, 2, 3] } },
      { text: 'Visible before tools. ' },
      call('Call-B.Original', 'lore-2'),
      { text: '', thoughtSignature: 'SIGNATURE_ONLY', futureMetadata: true },
    ];
    first.decoder.accept(event(parts.slice(0, 3)));
    first.decoder.accept(event(parts.slice(3), 'STOP'));
    const output = first.decoder.finish();
    expect(output).toMatchObject({
      status: 'tool_calls',
      text: 'Visible before tools.' + ' ',
      toolCalls: [
        { id: 'Call-A.Original', name: 'knowledge.read' },
        { id: 'Call-B.Original', name: 'knowledge.read' },
      ],
    });
    const secondInput = continued(input, output);
    (secondInput.input.results as Json[]).reverse(); // Match by exact host ID, never by function name or result order.
    const second = start(secondInput);
    const secondBody = bodyObject(second.body);
    expect(secondBody.contents[1]).toEqual({ role: 'model', parts });
    expect(secondBody.contents[2].parts).toEqual([
      {
        functionResponse: {
          id: 'Call-A.Original',
          name: 'knowledge.read',
          response: { text: 'Read lore-1' },
        },
      },
      {
        functionResponse: {
          id: 'Call-B.Original',
          name: 'knowledge.read',
          response: { text: 'Read lore-2' },
        },
      },
    ]);
    second.decoder.accept(
      event([call('Call-C', 'lore-3'), { thoughtSignature: 'AFTER_CALL_SIGNATURE' }], 'STOP')
    );
    const secondOutput = second.decoder.finish();
    const thirdInput = continued(secondInput, secondOutput);
    const third = start(thirdInput);
    expect(bodyObject(third.body).contents.slice(0, 3)).toEqual(secondBody.contents);
    expect(bodyObject(third.body).contents.map((content: any) => content.role)).toEqual([
      'user',
      'model',
      'user',
      'model',
      'user',
    ]);
    third.decoder.accept(event([{ text: 'Final story.' }], 'STOP'));
    expect(third.decoder.finish()).toMatchObject({ status: 'completed', text: 'Final story.' });
    const changedPrefix = structuredClone(thirdInput);
    bodyObject((changedPrefix.input.results as Json[])[0]).result.text = 'Rewritten old result';
    expect(() => encodeVertex(changedPrefix)).toThrow('TOOL_RESULT_MISMATCH');
  });

  test.each([
    ['skills.list', undefined],
    ['skills.list', false],
    ['knowledge.search', undefined],
    ['knowledge.search', false],
  ] as const)(
    'supports omitted args for no-argument %s with willContinue=%s while preserving signed parts',
    (name, willContinue) => {
      const input = request();
      input.stable.tools = [
        {
          name,
          description: 'List approved scope without required arguments',
          inputSchema: {
            type: 'object',
            properties: { query: { type: 'string' } },
            additionalProperties: false,
          },
        },
      ];
      const first = start(input);
      const id = `No-Args-${name}.Original`;
      const signedPart: Record<string, Json> = {
        functionCall: { id, name, ...(willContinue === false ? { willContinue } : {}) },
        thoughtSignature: 'UNCHANGED_NO_ARGS_SIGNATURE',
      };
      first.decoder.accept(event([signedPart], 'STOP'));
      const output = first.decoder.finish();
      expect(output).toMatchObject({
        status: 'tool_calls',
        toolCalls: [{ id, name, arguments: {} }],
      });
      const next: ProviderRequest = {
        ...input,
        opaqueState: output.opaqueState,
        input: {
          ...input.input,
          results: [{ callId: id, name, args: {}, result: { items: [] }, denied: false }],
        },
      };
      const second = start(next);
      const wire = bodyObject(second.body);
      expect(wire.contents[1].parts).toEqual([signedPart]);
      expect(wire.contents[1].parts[0].functionCall).not.toHaveProperty('args');
      expect(wire.contents[2].parts).toEqual([
        { functionResponse: { id, name, response: { items: [] } } },
      ]);
      second.decoder.accept(event([{ text: 'No matching references.' }], 'STOP'));
      expect(second.decoder.finish()).toMatchObject({
        status: 'completed',
        text: 'No matching references.',
      });
      expect(signedPart.functionCall).not.toHaveProperty('args');
    }
  );

  test('accepts completed arguments with willContinue false and returns the original signed part', () => {
    const input = request();
    const first = start(input);
    const part = {
      functionCall: {
        id: 'Complete-Args.Original',
        name: 'knowledge.read',
        args: { id: 'lore-1' },
        willContinue: false,
      },
      thoughtSignature: 'UNCHANGED_COMPLETE_SIGNATURE',
    };
    first.decoder.accept(event([part], 'STOP'));
    const output = first.decoder.finish();
    expect(output).toMatchObject({
      status: 'tool_calls',
      toolCalls: [
        { id: 'Complete-Args.Original', name: 'knowledge.read', arguments: { id: 'lore-1' } },
      ],
    });
    const second = start(continued(input, output));
    expect(bodyObject(second.body).contents[1].parts).toEqual([part]);
    expect(bodyObject(second.body).contents[2].parts[0].functionResponse).toMatchObject({
      id: 'Complete-Args.Original',
      name: 'knowledge.read',
      response: { text: 'Read lore-1' },
    });
  });

  test('uses independent host IDs for absent provider IDs without inserting them into returned parts or responses', () => {
    const input = request();
    const first = start(input);
    const parts = [call(undefined, 'lore-1'), call(undefined, 'lore-2')];
    first.decoder.accept(event(parts, 'STOP'));
    const output = first.decoder.finish();
    expect(new Set(output.toolCalls.map((item) => item.id)).size).toBe(2);
    const second = start(continued(input, output));
    const wire = bodyObject(second.body);
    expect(wire.contents[1].parts).toEqual(parts);
    expect(wire.contents[2].parts).toEqual([
      { functionResponse: { name: 'knowledge.read', response: { text: 'Read lore-1' } } },
      { functionResponse: { name: 'knowledge.read', response: { text: 'Read lore-2' } } },
    ]);
    expect(JSON.stringify(second.body)).not.toContain('vertex-host-');
    second.decoder.accept(event([call(undefined, 'lore-3')], 'STOP'));
    expect(output.toolCalls.map((item) => item.id)).not.toContain(
      second.decoder.finish().toolCalls[0].id
    );
  });

  test.each(['missing', 'extra', 'duplicate', 'wrong-id', 'wrong-name'] as const)(
    'rejects %s tool results',
    (mode) => {
      const input = request();
      const first = start(input);
      first.decoder.accept(event([call('native-A'), call('native-B')], 'STOP'));
      const next = continued(input, first.decoder.finish());
      const items = next.input.results as Json[];
      if (mode === 'missing') items.pop();
      if (mode === 'extra') items.push(structuredClone(items[0]));
      if (mode === 'duplicate') items[1] = structuredClone(items[0]);
      if (mode === 'wrong-id') bodyObject(items[0]).callId = 'unknown';
      if (mode === 'wrong-name') bodyObject(items[0]).name = 'skills.load';
      expect(() => encodeVertex(next)).toThrow('TOOL_RESULT_MISMATCH');
    }
  );

  test.each(['task', 'controls', 'source', 'catalog', 'history', 'stable', 'generation'] as const)(
    'binds continuation to unchanged %s',
    (field) => {
      const input = request();
      const first = start(input);
      first.decoder.accept(event([call('native-A')], 'STOP'));
      const next = continued(input, first.decoder.finish());
      if (field === 'stable') next.stable.contract += ' changed';
      else if (field === 'generation') next.generation!.maxOutputTokens++;
      else if (field === 'task') next.input.task += ' changed';
      else if (field === 'controls') next.input.controls.extra = true;
      else next.input[field] = { changed: true };
      expect(() => encodeVertex(next)).toThrow('VERTEX_CONTINUATION_MISMATCH');
    }
  );

  test('rejects missing, corrupted and unfinished continuation while diagnostic redaction preserves actual body', () => {
    const input = request();
    const first = start(input);
    first.decoder.accept(
      event([
        { thought: true, text: 'PRIVATE_THOUGHT', thoughtSignature: 'PRIVATE_SIGNATURE' },
        call('native-A'),
      ])
    );
    const partial = first.decoder.snapshot();
    expect(() => encodeVertex(continued(input, partial))).toThrow('TOOL_RESULT_MISMATCH');
    first.decoder.accept(
      event(
        [{ thoughtSignature: 'LATE_SIGNATURE', metadata: { signature: 'NESTED_SIGNATURE' } }],
        'STOP'
      )
    );
    const next = continued(input, first.decoder.finish());
    const body = encodeVertex(next).body;
    const originalBody = structuredClone(body);
    const diagnostic = diagnosticVertexBody(body);
    expect(JSON.stringify(diagnostic)).not.toMatch(
      /PRIVATE_THOUGHT|PRIVATE_SIGNATURE|LATE_SIGNATURE|NESTED_SIGNATURE/u
    );
    expect(JSON.stringify(diagnostic)).toContain('provider thought withheld');
    expect(body).toEqual(originalBody);
    expect(JSON.stringify(body)).toContain('PRIVATE_SIGNATURE');
    const damaged = structuredClone(next);
    bodyObject(damaged.opaqueState!).bindingHash = 'other';
    expect(() => encodeVertex(damaged)).toThrow('INVALID_VERTEX_CONTINUATION');
    delete next.opaqueState;
    expect(() => encodeVertex(next)).toThrow('VERTEX_CONTINUATION_REQUIRED');
  });
});

describe('Vertex streamed response decoder', () => {
  test('appends visible text only, preserves trailing usage verbatim and counts response plus thoughts', () => {
    const { decoder } = start();
    decoder.accept(event([{ thought: true, text: 'hidden' }, { text: '등대 🌊' }]));
    decoder.accept({
      usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, thoughtsTokenCount: 1 },
    });
    decoder.accept(event([{ text: ' is lit.' }], 'STOP'));
    const raw = {
      promptTokenCount: 11,
      candidatesTokenCount: 7,
      thoughtsTokenCount: 5,
      totalTokenCount: 23,
      cachedContentTokenCount: 4,
      customUsage: { opaqueCounter: 91 },
      costUsd: 0.9,
    };
    decoder.accept({
      usageMetadata: raw,
      modelVersion: 'gemini-3.8-flash',
      responseId: 'response-7',
    });
    const result = decoder.finish();
    expect(result).toMatchObject({
      status: 'completed',
      text: '등대 🌊 is lit.',
      usage: { inputTokens: 11, outputTokens: 12, costUsd: null, priceRevision: null, raw },
    });
    raw.promptTokenCount = 99;
    expect(decoder.snapshot().usage.inputTokens).toBe(11);
    expect(result.text).not.toContain('hidden');
  });

  test('keeps entirely missing usage unknown and retains observed thought tokens without inventing missing raw fields', () => {
    const { decoder } = start();
    decoder.accept(event([{ text: 'Story.' }], 'STOP'));
    expect(decoder.finish().usage).toEqual({
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
      priceRevision: null,
      raw: null,
    });
    decoder.accept({ usageMetadata: { promptTokenCount: 3, thoughtsTokenCount: 9 } });
    expect(decoder.finish().usage).toEqual({
      inputTokens: 3,
      outputTokens: 9,
      costUsd: null,
      priceRevision: null,
      raw: { promptTokenCount: 3, thoughtsTokenCount: 9 },
    });
  });

  test.each(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'MODEL_ARMOR'])(
    'returns explicit %s refusal and preserves later usage',
    (reason) => {
      const { decoder } = start();
      decoder.accept(event([{ text: 'Observed pre-block text.' }], reason));
      decoder.accept({ usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 2 } });
      expect(decoder.finish()).toMatchObject({
        status: 'refused',
        refusal: reason,
        usage: { inputTokens: 8, outputTokens: 2, costUsd: null },
      });
    }
  );

  test('treats explicit prompt blocking as terminal without a generated candidate', () => {
    const { decoder } = start();
    decoder.accept({
      promptFeedback: { blockReason: 'SAFETY', blockReasonMessage: 'Private provider details' },
      candidates: [],
    });
    expect(decoder.finish()).toMatchObject({
      status: 'refused',
      refusal: 'SAFETY',
      text: '',
      toolCalls: [],
    });
    expect(JSON.stringify(decoder.finish())).not.toContain('Private provider details');
  });

  test('MAX_TOKENS remains partial even with a complete-looking tool object', () => {
    const { decoder } = start();
    decoder.accept(event([{ text: 'Partial.' }, call('native-A')], 'MAX_TOKENS'));
    expect(decoder.finish()).toMatchObject({
      status: 'partial',
      text: 'Partial.',
      error: { code: 'MAX_TOKENS' },
    });
  });

  test.each(['MALFORMED_FUNCTION_CALL', 'UNEXPECTED_TOOL_CALL', 'OTHER'])(
    'reports %s as a terminal error',
    (reason) => {
      const { decoder } = start();
      decoder.accept(event([{ text: 'Retained.' }], reason));
      expect(decoder.finish()).toMatchObject({
        status: 'error',
        text: 'Retained.',
        error: { code: reason },
      });
    }
  );

  test('requires a terminal signal at EOF and never promotes empty or thought-only completion', () => {
    const { decoder } = start();
    decoder.accept(event([{ text: 'Unfinished.' }]));
    expect(() => decoder.finish()).toThrow('UNEXPECTED_EOF');
    expect(decoder.snapshot()).toMatchObject({
      status: 'partial',
      text: 'Unfinished.',
      error: { code: 'UNEXPECTED_EOF' },
    });
    for (const parts of [[], [{ thought: true, text: 'hidden', thoughtSignature: 'signature' }]]) {
      const other = start().decoder;
      other.accept(event(parts, 'STOP'));
      expect(other.finish()).toMatchObject({
        status: 'error',
        text: '',
        error: { code: 'EMPTY_COMPLETION' },
      });
    }
  });

  test.each([
    {
      functionCall: {
        name: 'knowledge.read',
        partialArgs: [{ jsonPath: '$.id', stringValue: 'lore-1' }],
        willContinue: true,
      },
    },
    { functionCall: { name: 'knowledge.read', args: { id: 'lore-1' }, willContinue: true } },
    { functionCall: { name: 'knowledge.read', args: { id: 'lore-1' }, willContinue: 'false' } },
    { functionCall: { name: 'knowledge.read', args: { id: 'lore-1' }, partialArgs: [] } },
  ])('refuses unexpected streamed argument representation %#', (part) => {
    const { decoder } = start();
    expect(() =>
      decoder.accept({ candidates: [{ content: { role: 'model', parts: [part] } }] })
    ).toThrow('VERTEX_STREAMED_TOOL_ARGUMENTS_UNSUPPORTED');
    expect(decoder.snapshot().toolCalls).toEqual([]);
    expect(decoder.snapshot().status).not.toBe('tool_calls');
  });

  test('rejects duplicate call IDs within a response and across provider turns', () => {
    const input = request();
    const first = start(input);
    expect(() =>
      first.decoder.accept(event([call('duplicate'), call('duplicate')], 'STOP'))
    ).toThrow('DUPLICATE_TOOL_ID');
    expect(first.decoder.snapshot().status).not.toBe('tool_calls');
    const valid = start(input);
    valid.decoder.accept(event([call('native-A')], 'STOP'));
    const second = start(continued(input, valid.decoder.finish()));
    expect(() => second.decoder.accept(event([call('native-A')], 'STOP'))).toThrow(
      'DUPLICATE_TOOL_ID'
    );
  });

  test.each([
    { value: { candidates: [{ index: 0 }, { index: 0 }] }, code: 'VERTEX_MULTIPLE_CANDIDATES' },
    { value: { candidates: [{ index: 1 }] }, code: 'VERTEX_MULTIPLE_CANDIDATES' },
    { value: event([], 'FUTURE_UNKNOWN_REASON'), code: 'VERTEX_UNKNOWN_FINISH_REASON' },
    {
      value: event([{ functionCall: { name: 'knowledge.read', args: '{"id":"lore-1"}' } }]),
      code: 'INVALID_TOOL_ARGUMENTS',
    },
    {
      value: event([{ functionCall: { name: 'knowledge.read', args: null } }]),
      code: 'INVALID_TOOL_ARGUMENTS',
    },
    {
      value: event([
        { text: 'Ambiguous union', functionCall: { name: 'knowledge.read', args: {} } },
      ]),
      code: 'INVALID_VERTEX_PART',
    },
    { value: { usageMetadata: { promptTokenCount: -1 } }, code: 'INVALID_USAGE' },
    { value: { usageMetadata: { candidatesTokenCount: 0.5 } }, code: 'INVALID_USAGE' },
    {
      value: {
        error: { message: 'PRIVATE_REMOTE_DETAILS' },
        usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 1 },
      },
      code: 'VERTEX_PROVIDER_ERROR',
    },
  ])('fails explicitly on malformed response %#', ({ value, code }) => {
    const { decoder } = start();
    expect(() => decoder.accept(value)).toThrow(code);
    expect(decoder.snapshot().error?.code).toBe(code);
    expect(() => decoder.finish()).toThrow(VertexProtocolError);
    expect(JSON.stringify(decoder.snapshot())).not.toContain('PRIVATE_REMOTE_DETAILS');
    if (code === 'VERTEX_PROVIDER_ERROR') expect(decoder.snapshot().usage.inputTokens).toBe(4);
  });

  test('allows trailing metadata, rejects new parts and duplicate terminals after completion', () => {
    const first = start().decoder;
    first.accept(event([{ text: 'Done.' }], 'STOP'));
    first.accept({
      usageMetadata: {
        promptTokenCount: 0,
        candidatesTokenCount: 0,
        thoughtsTokenCount: 0,
        totalTokenCount: 0,
      },
    });
    expect(first.finish().usage.outputTokens).toBe(0);
    expect(() => first.accept(event([{ text: 'Unexpected.' }]))).toThrow(
      'VERTEX_EVENT_AFTER_FINISH'
    );
    const second = start().decoder;
    second.accept(event([{ text: 'Done.' }], 'STOP'));
    expect(() => second.accept(event([], 'STOP'))).toThrow('VERTEX_DUPLICATE_TERMINAL');
  });
});
