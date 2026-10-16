import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { encodeResponses, ResponsesDecoder } from '../core/openai-protocol.js';
import { encodeChat } from '../core/openai-chat-protocol.js';
import { encodeAnthropic } from '../core/anthropic-protocol.js';
import { encodeVertex } from '../core/vertex-protocol.js';
import {
  buildCodexDescriptor,
  buildCodexNativeRequest,
  prepareCodexNative,
} from '../core/codex-protocol.js';
import { estimateContextInput } from '../core/context-budget.js';
import {
  materializeProviderImages,
  providerImageReference,
  imageInputSupported,
} from '../core/provider-images.js';
import { redactDiagnosticJson } from '../core/provider-diagnostic-json.js';
import {
  executeProvider,
  type Json,
  type ProviderRequest,
  type WireRecord,
} from '../core/transport.js';
import type { RequestImage } from '../core/request-images.js';
import type { ProviderProtocol } from '../core/product.js';
import { CodexRuntime } from '../server/codex-runtime.js';

const bytes = Buffer.from('RIFF\x04\x00\x00\x00WEBP', 'binary');
const base64 = bytes.toString('base64');
const hash = createHash('sha256').update(bytes).digest('hex');
const image: RequestImage = {
  hash,
  mime: 'image/webp',
  name: 'reference.webp',
  width: 640,
  height: 480,
  input: { hash, width: 640, height: 480 },
};
const resolved = { mime: 'image/webp' as const, base64, width: 640, height: 480 };
const signal = () => new AbortController().signal;
function request(): ProviderRequest {
  return {
    role: 'main',
    modelId: 'custom-vision-model',
    stable: {
      contract: 'Describe the supplied reference.',
      tools: [
        { name: 'knowledge.read', description: 'Read a source', inputSchema: { type: 'object' } },
      ],
    },
    generation: { maxOutputTokens: 1024, temperature: null },
    input: { task: 'Use the current reference.', controls: {}, results: [] },
    prompt: {
      compilerVersion: 'risu-native-prompt-2',
      values: {},
      cachePlan: [],
      messages: [
        {
          id: 'old-user',
          role: 'user',
          completion: 'complete',
          provenance: { blockId: 'chat', origin: 'history', sourceMessageId: 'request:old' },
          content: [
            { type: 'text', text: 'Look at this reference.' },
            { type: 'image', image },
            { type: 'text', text: 'Keep its colors.' },
          ],
        },
        {
          id: 'old-assistant',
          role: 'assistant',
          completion: 'complete',
          provenance: { blockId: 'chat', origin: 'history' },
          content: [{ type: 'text', text: 'I see it.' }],
        },
        {
          id: 'current',
          role: 'user',
          completion: 'complete',
          provenance: { blockId: 'chat', origin: 'current' },
          content: [{ type: 'text', text: 'Use the current reference.' }],
        },
      ],
    },
  };
}

const variants = [
  ['openai-responses-v1', 'https://api.openai.com/v1'],
  ['openai-chat-v1', 'https://api.openai.com/v1'],
  ['vercel-chat-v1', 'https://ai-gateway.vercel.sh/v1'],
  ['anthropic-messages-v1', 'https://api.anthropic.com/v1'],
  ['google-gemini-v1', 'https://generativelanguage.googleapis.com/v1beta'],
  [
    'vertex-gemini-v1',
    'https://aiplatform.googleapis.com/v1/projects/synthetic/locations/global/publishers/google/models',
  ],
] as const;
function encoded(input: ProviderRequest, protocol: ProviderProtocol) {
  if (protocol === 'openai-responses-v1') return encodeResponses(input).body;
  if (protocol === 'anthropic-messages-v1') return encodeAnthropic(input).body;
  if (protocol === 'vertex-gemini-v1' || protocol === 'google-gemini-v1')
    return encodeVertex(input, protocol).body;
  return encodeChat(input, protocol as 'openai-chat-v1').body;
}

afterEach(() => vi.unstubAllGlobals());

describe('authored reference image transmission', () => {
  test.each(variants)(
    '%s resolves only at transmission and preserves its original turn',
    async (protocol, endpoint) => {
      const input = request();
      if (protocol.includes('gemini')) input.modelId = 'gemini-custom';
      let sent: Record<string, any> = {};
      const wires: WireRecord[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url, options) => {
          sent = JSON.parse(options.body);
          return new Response('{"error":{"message":"synthetic rejection"}}', {
            status: 400,
            headers: { 'content-type': 'application/json' },
          });
        })
      );
      const resolveImage = vi.fn(() => resolved);
      const result = await executeProvider(
        { id: 'image-test', protocol, endpoint, credentialRef: 'SYNTHETIC_KEY' },
        input,
        {
          signal: signal(),
          resolveCredential: () => 'synthetic',
          resolveImage,
          onWire: (wire) => {
            wires.push(wire);
          },
        }
      );
      expect(result.error?.code).toBe('HTTP_400');
      expect(resolveImage).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(sent)).toContain(base64);
      expect(JSON.stringify(sent)).not.toContain('uimori-image://');
      expect(JSON.stringify(input)).not.toContain(base64);
      expect(JSON.stringify(wires)).not.toContain(base64);
      expect(JSON.stringify(wires)).toContain(providerImageReference(image));
      const turns = sent.input ?? sent.messages ?? sent.contents;
      const containing = turns.find((turn: unknown) => JSON.stringify(turn).includes(base64));
      expect(JSON.stringify(containing)).toContain('Look at this reference.');
      expect(JSON.stringify(containing)).toContain('Keep its colors.');
      expect(JSON.stringify(containing)).not.toContain('Use the current reference.');
      if (protocol === 'openai-responses-v1')
        expect(containing.content[1]).toEqual({
          type: 'input_image',
          image_url: `data:image/webp;base64,${base64}`,
          detail: 'auto',
        });
      else if (protocol.includes('chat'))
        expect(containing.content[1]).toEqual({
          type: 'image_url',
          image_url: { url: `data:image/webp;base64,${base64}`, detail: 'auto' },
        });
      else if (protocol === 'anthropic-messages-v1')
        expect(containing.content[1]).toEqual({
          type: 'image',
          source: { type: 'base64', media_type: 'image/webp', data: base64 },
        });
      else
        expect(containing.parts[1]).toEqual({
          inlineData: { mimeType: 'image/webp', data: base64 },
        });
    }
  );

  test('signed tool continuation retains references and rejects changed image identity', async () => {
    const input = request();
    const prepared = encodeResponses(input);
    const decoder = new ResponsesDecoder(prepared.context);
    decoder.accept({
      type: 'response.completed',
      response: {
        id: 'image-response',
        status: 'completed',
        output: [
          {
            type: 'function_call',
            id: 'fn-1',
            call_id: 'call-1',
            name: 'tool_0_knowledge_read',
            arguments: '{}',
            status: 'completed',
          },
        ],
      },
    });
    const result = decoder.finish();
    const continued = {
      ...input,
      opaqueState: result.opaqueState,
      input: {
        ...input.input,
        results: [
          {
            callId: 'call-1',
            name: 'knowledge.read',
            args: {},
            result: { text: 'source' },
            denied: false,
          },
        ],
      },
    };
    const body = encodeResponses(continued).body;
    expect(JSON.stringify(result.opaqueState)).toContain(providerImageReference(image));
    expect(JSON.stringify(result.opaqueState)).not.toContain(base64);
    const wire = await materializeProviderImages(
      body,
      continued,
      { resolveImage: () => resolved },
      signal()
    );
    expect(JSON.stringify(wire).split(base64)).toHaveLength(2);
    const changed = structuredClone(continued);
    const part = changed.prompt!.messages[0].content[1];
    if (part.type !== 'image') throw new Error('missing fixture image');
    part.image.input.hash = 'f'.repeat(64);
    expect(() => encodeResponses(changed)).toThrow('OPENAI_CONTINUATION_MISMATCH');
  });

  test('resolves frozen native slots only and validates the exact admitted bytes', async () => {
    const input = request();
    const resolveImage = vi.fn(() => resolved);
    expect(
      await materializeProviderImages(
        { text: providerImageReference(image) },
        input,
        { resolveImage },
        signal()
      )
    ).toEqual({ text: providerImageReference(image) });
    expect(resolveImage).not.toHaveBeenCalled();
    await expect(
      materializeProviderImages(
        encoded(input, 'openai-responses-v1'),
        input,
        {
          resolveImage: () => ({
            ...resolved,
            base64: Buffer.from('different').toString('base64'),
          }),
        },
        signal()
      )
    ).rejects.toThrow('IMAGE_INPUT_INVALID');
    const foreign = `uimori-image://${'f'.repeat(64)}/640/480`;
    await expect(
      materializeProviderImages(
        { type: 'input_image', image_url: foreign },
        input,
        { resolveImage },
        signal()
      )
    ).rejects.toThrow('IMAGE_INPUT_UNAVAILABLE');
  });

  test('counts image allowance separately without charging hash/base64 as text', () => {
    const body = encoded(request(), 'openai-responses-v1');
    const estimate = estimateContextInput(body);
    expect(estimate).toMatchObject({
      imageCount: 1,
      imageTokens: 4096,
      imageEstimate: 'conservative-dimensions-v1',
    });
    expect(estimate.totalTokens).toBe(estimate.textTokens + estimate.imageTokens);
    const other = JSON.parse(JSON.stringify(body).replaceAll(hash, 'f'.repeat(64)));
    expect(estimateContextInput(other)).toEqual(estimate);
  });

  test('known text-only models reject images while unknown custom models remain available', () => {
    expect(() => encoded(request(), 'deepseek-chat-v1')).toThrow('IMAGE_INPUT_UNSUPPORTED_MODEL');
    expect(imageInputSupported('vercel-chat-v1', 'deepseek/deepseek-chat')).toBe(false);
    expect(imageInputSupported('vercel-chat-v1', 'custom/deepseek-future-vision')).toBeNull();
  });

  test('Codex descriptor and native loop preserve each turn and image position', async () => {
    const input = request();
    for (const descriptor of [
      buildCodexDescriptor(input),
      prepareCodexNative(buildCodexNativeRequest(input)).descriptor,
    ]) {
      const wire = (await materializeProviderImages(
        descriptor,
        input,
        { resolveImage: () => resolved },
        signal()
      )) as { input: Json[] };
      const parts = wire.input as Record<string, any>[];
      const index = parts.findIndex((part) => part.type === 'image');
      expect(parts[index]).toEqual({ type: 'image', url: `data:image/webp;base64,${base64}` });
      expect(parts[index - 1].text).toContain('Look at this reference.');
      expect(parts[index + 1].text).toContain('Keep its colors.');
      expect(JSON.stringify(parts.slice(index + 1))).toContain('Use the current reference.');
      expect(JSON.stringify(descriptor)).not.toContain(base64);
    }
  });

  test('diagnostics withhold native data URLs and raw inline image payloads', () => {
    const body: Json = {
      content: [
        { type: 'input_image', image_url: `data:image/webp;base64,${base64}` },
        { type: 'image', source: { type: 'base64', media_type: 'image/webp', data: base64 } },
        { inlineData: { mimeType: 'image/webp', data: base64 } },
      ],
    };
    expect(JSON.stringify(redactDiagnosticJson(body))).not.toContain(base64);
    expect(JSON.stringify(body)).toContain(base64);
  });

  test.each([false, true])(
    'Codex native=%s sends image input with generation disabled',
    async (native) => {
      const directory = mkdtempSync(join(tmpdir(), 'uimori-image-input-'));
      const log = join(directory, 'requests.jsonl');
      const runtime = new CodexRuntime(join(directory, 'test.sqlite'), {
        enabled: true,
        launch: {
          command: process.execPath,
          args: [resolve('tests/fixtures/codex-app-server.mjs')],
          env: {
            UIMORI_CODEX_FIXTURE_LOG: log,
            UIMORI_CODEX_FIXTURE_OUTPUT: native
              ? 'Reference understood.'
              : JSON.stringify({ kind: 'final', text: 'Reference understood.', toolCalls: [] }),
          },
        },
      });
      try {
        const wires: WireRecord[] = [];
        const options = {
          signal: signal(),
          resolveImage: () => resolved,
          onWire: (wire: WireRecord) => {
            wires.push(wire);
          },
        };
        const connection = {
          id: 'codex-images',
          protocol: 'codex-app-server-v1' as const,
          endpoint: 'codex://local',
        };
        const input = request();
        const result = native
          ? await runtime.executeAgent(connection, buildCodexNativeRequest(input), {
              ...options,
              onToolCall: async () => ({ success: false, text: 'unused' }),
            })
          : await runtime.execute(connection, input, options);
        expect(result).toMatchObject({ status: 'completed', text: 'Reference understood.' });
        const records = readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        const parts = records.find((entry) => entry.method === 'turn/start').params.input;
        const index = parts.findIndex((part: any) => part.type === 'image');
        expect(parts[index]).toEqual({ type: 'image', url: `data:image/webp;base64,${base64}` });
        expect(parts[index - 1].text).toContain('Look at this reference.');
        expect(parts[index + 1].text).toContain('Keep its colors.');
        expect(
          records.find((entry) => entry.method === 'thread/start').params.config[
            'features.image_generation'
          ]
        ).toBe(false);
        expect(JSON.stringify(wires)).not.toContain(base64);
        expect(JSON.stringify(input)).not.toContain(base64);
      } finally {
        await runtime.close();
        await rm(directory, { recursive: true, force: true });
      }
    }
  );
});
