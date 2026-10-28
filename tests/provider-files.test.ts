import { createHash } from 'node:crypto';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { encodeResponses, ResponsesDecoder } from '../core/openai-protocol.js';
import { estimateContextInput } from '../core/context-budget.js';
import { buildCodexTurn } from '../core/codex-protocol.js';
import { redactDiagnosticJson } from '../core/provider-diagnostic-json.js';
import {
  assertProviderFileSupport,
  materializeProviderFiles,
  providerFilePart,
  providerFileReference,
} from '../core/provider-files.js';
import {
  classifyRequestFile,
  fileInputSupported,
  requestFileAccept,
  validateRequestFile,
  type RequestFile,
} from '../core/request-files.js';
import {
  executeProvider,
  type Json,
  type ProviderRequest,
  type WireRecord,
} from '../core/transport.js';

const bytes = Buffer.from('%PDF-1.7\nSynthetic provider-contract fixture.\n%%EOF');
const base64 = bytes.toString('base64');
const file: RequestFile = {
  hash: createHash('sha256').update(bytes).digest('hex'),
  name: 'reference.pdf',
  mime: 'application/pdf',
  bytes: bytes.length,
  kind: 'document',
};
const resolved = { mime: file.mime, base64 };
function request(attachment = file): ProviderRequest {
  return {
    role: 'helper',
    modelId: 'custom-file-model',
    stable: { contract: 'Read the attachment.', tools: [] },
    generation: { maxOutputTokens: 1024, temperature: null },
    input: { task: '', controls: {}, results: [] },
    prompt: {
      compilerVersion: 'risu-native-prompt-2',
      values: {},
      cachePlan: [],
      messages: [
        {
          id: 'reference',
          role: 'user',
          completion: 'complete',
          provenance: { blockId: 'chat', origin: 'current' },
          content: [
            { type: 'text', text: 'Read this file.' },
            { type: 'file', file: attachment },
          ],
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
afterEach(() => vi.unstubAllGlobals());

describe('native file attachment transmission', () => {
  test('file picker extensions match the selected protocol and model capability', () => {
    const responses = requestFileAccept('openai-responses-v1', 'custom-model').split(',');
    expect(responses).toEqual(expect.arrayContaining(['.pdf', '.docx', '.txt', '.md']));
    expect(responses).not.toContain('.mp3');
    const gemini = requestFileAccept('google-gemini-v1', 'gemini-custom').split(',');
    expect(gemini).toEqual(expect.arrayContaining(['.pdf', '.md', '.mp3', '.mp4']));
    expect(gemini).not.toContain('.docx');
    expect(requestFileAccept('openai-chat-v1', 'custom-model')).toBe('.pdf');
    expect(requestFileAccept('codex-app-server-v1', 'gpt-6')).toBe('');
    expect(requestFileAccept('openai-responses-v1', 'deepseek-chat')).toBe('');
  });
  test('Claude text documents send decoded UTF-8 while retaining the original MIME and hash', async () => {
    const source = '# 원문\nA quoted "reference".\n';
    const content = Buffer.from(source);
    const textFile: RequestFile = {
      ...file,
      name: 'source.md',
      mime: 'text/plain',
      kind: 'text',
      bytes: content.length,
      hash: createHash('sha256').update(content).digest('hex'),
    };
    const part = providerFilePart(textFile, 'anthropic-messages-v1');
    const wire = await materializeProviderFiles(
      part,
      request(textFile),
      { resolveFile: () => ({ mime: textFile.mime, base64: content.toString('base64') }) },
      'anthropic-messages-v1'
    );
    expect(wire).toEqual({
      type: 'document',
      source: { type: 'text', media_type: 'text/plain', data: source },
      title: 'source.md',
    });
    expect(JSON.stringify(part)).toContain('uimori-file://');
  });

  test('signed continuation retains file references and binds their admitted identity', async () => {
    const input = request();
    input.stable.tools = [
      { name: 'read', description: 'Read source', inputSchema: { type: 'object' } },
    ];
    const prepared = encodeResponses(input);
    const decoder = new ResponsesDecoder(prepared.context);
    decoder.accept({
      type: 'response.completed',
      response: {
        id: 'file-response',
        status: 'completed',
        output: [
          {
            type: 'function_call',
            id: 'fn-1',
            call_id: 'call-1',
            name: 'tool_0_read',
            arguments: '{}',
            status: 'completed',
          },
        ],
      },
    });
    const result = decoder.finish();
    const continued: ProviderRequest = {
      ...input,
      opaqueState: result.opaqueState,
      input: {
        ...input.input,
        results: [
          { callId: 'call-1', name: 'read', args: {}, result: { text: 'source' }, denied: false },
        ],
      },
    };
    const body = encodeResponses(continued).body;
    expect(JSON.stringify(result.opaqueState)).toContain(providerFileReference(file));
    expect(JSON.stringify(result.opaqueState)).not.toContain(base64);
    const wire = await materializeProviderFiles(
      body,
      continued,
      { resolveFile: () => resolved },
      'openai-responses-v1'
    );
    expect(JSON.stringify(wire).split(base64)).toHaveLength(2);
    const changed = structuredClone(continued);
    const part = changed.prompt!.messages[0].content[1];
    if (part.type !== 'file') throw new Error('Missing file fixture');
    part.file.hash = 'f'.repeat(64);
    expect(() => encodeResponses(changed)).toThrow('OPENAI_CONTINUATION_MISMATCH');
  });

  test.each(variants)(
    '%s sends a PDF in its own user turn and retains references in diagnostics',
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
      const resolveFile = vi.fn(() => resolved);
      const result = await executeProvider(
        { id: 'files', protocol, endpoint, credentialRef: 'SYNTHETIC' },
        input,
        {
          signal: new AbortController().signal,
          resolveCredential: () => 'synthetic',
          resolveFile,
          onWire: (wire) => {
            wires.push(wire);
          },
        }
      );
      expect(result.error?.code).toBe('HTTP_400');
      expect(resolveFile).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(sent)).toContain(base64);
      expect(JSON.stringify(sent)).not.toContain('uimori-file://');
      expect(JSON.stringify(input)).not.toContain(base64);
      expect(JSON.stringify(wires)).not.toContain(base64);
      expect(JSON.stringify(wires)).toContain(providerFileReference(file));
      const turns = sent.input ?? sent.messages ?? sent.contents;
      const turn = turns.find((item: unknown) => JSON.stringify(item).includes(base64));
      expect(turn.role).toBe('user');
      expect(JSON.stringify(turn)).toContain('Read this file.');
      if (protocol === 'openai-responses-v1')
        expect(turn.content[1]).toEqual({
          type: 'input_file',
          filename: 'reference.pdf',
          file_data: `data:application/pdf;base64,${base64}`,
        });
      else if (protocol.includes('chat'))
        expect(turn.content[1]).toEqual({
          type: 'file',
          file: { filename: 'reference.pdf', file_data: `data:application/pdf;base64,${base64}` },
        });
      else if (protocol === 'anthropic-messages-v1')
        expect(turn.content[1]).toEqual({
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: base64 },
          title: 'reference.pdf',
        });
      else
        expect(turn.parts[1]).toEqual({
          inlineData: { mimeType: 'application/pdf', data: base64 },
        });
    }
  );

  test('supports protocol-native categories without rejecting unknown routed models', () => {
    const office = { ...file, ...classifyRequestFile('source.docx')!, name: 'source.docx' };
    const audio = { ...file, ...classifyRequestFile('source.mp3')!, name: 'source.mp3' };
    const video = { ...file, ...classifyRequestFile('source.mp4')!, name: 'source.mp4' };
    const text = { ...file, ...classifyRequestFile('source.md')!, name: 'source.md' };
    expect(fileInputSupported('openai-responses-v1', 'custom/future-model', office)).toBe(true);
    for (const name of [
      'reference.pages',
      'slides.key',
      'template.dot',
      'sheet.xlt',
      'subtitle.vtt',
      'source.lua',
      'build.gradle',
    ]) {
      expect(
        fileInputSupported('openai-responses-v1', 'gpt-6-astra', classifyRequestFile(name)!)
      ).toBe(true);
    }
    for (const name of ['recording.l16', 'recording.alaw', 'recording.mulaw', 'recording.weba']) {
      expect(
        fileInputSupported('google-gemini-v1', 'gemini-4-argon', classifyRequestFile(name)!)
      ).toBe(true);
    }
    expect(fileInputSupported('openai-chat-v1', 'custom/future-model', office)).toBe(false);
    expect(fileInputSupported('anthropic-messages-v1', 'custom/future-model', office)).toBe(false);
    expect(fileInputSupported('google-gemini-v1', 'gemini-custom', office)).toBe(false);
    expect(fileInputSupported('anthropic-messages-v1', 'custom/future-model', text)).toBe(true);
    expect(providerFilePart(text, 'anthropic-messages-v1')).toMatchObject({
      source: { media_type: 'text/plain' },
    });
    for (const media of [audio, video]) {
      expect(fileInputSupported('google-gemini-v1', 'gemini-custom', media)).toBe(true);
      expect(fileInputSupported('vertex-gemini-v1', 'gemini-custom', media)).toBe(true);
      expect(fileInputSupported('openai-responses-v1', 'gpt-6', media)).toBe(false);
      expect(fileInputSupported('anthropic-messages-v1', 'claude-custom', media)).toBe(false);
    }
    expect(() => buildCodexTurn(request())).toThrow('FILE_INPUT_UNSUPPORTED_PROTOCOL');
    expect(() =>
      assertProviderFileSupport(request({ ...file, bytes: 50_000_000 }), 'openai-responses-v1')
    ).toThrow('FILE_INPUT_TOO_LARGE');
    expect(() => validateRequestFile({ ...file, bytes: 0 })).toThrow('REQUEST_FILES_INVALID');
  });

  test('applies the Claude serialized payload bound to image-only requests too', async () => {
    const input = request();
    input.prompt!.messages[0].content = [
      {
        type: 'image',
        image: {
          hash: 'a'.repeat(64),
          mime: 'image/webp',
          name: 'image.webp',
          width: 1,
          height: 1,
          input: { hash: 'a'.repeat(64), width: 1, height: 1 },
        },
      },
    ];
    await expect(
      materializeProviderFiles({ text: 'é'.repeat(16_000_000) }, input, {}, 'anthropic-messages-v1')
    ).rejects.toThrow('FILE_REQUEST_TOO_LARGE');
  });

  test('validates content identity and resolves only native user-message slots', async () => {
    const input = request();
    const part = providerFilePart(file, 'google-gemini-v1');
    const body: Json = {
      contents: [
        { role: 'user', parts: [part] },
        {
          role: 'tool',
          parts: [{ functionResponse: { name: 'lookup', response: { untrusted: part } } }],
        },
      ],
      context: part,
      text: providerFileReference(file),
    };
    const resolver = vi.fn(() => resolved);
    const wire = await materializeProviderFiles(
      body,
      input,
      { resolveFile: resolver },
      'google-gemini-v1'
    );
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(wire)).toContain(base64);
    expect(JSON.stringify(wire)).toContain(providerFileReference(file));
    expect(JSON.stringify(body)).not.toContain(base64);
    await expect(
      materializeProviderFiles(
        part,
        input,
        {
          resolveFile: () => ({
            mime: file.mime,
            base64: Buffer.alloc(file.bytes, 1).toString('base64'),
          }),
        },
        'google-gemini-v1'
      )
    ).rejects.toThrow('FILE_INPUT_INVALID');
    await expect(
      materializeProviderFiles(
        {
          type: 'input_file',
          file_data: `uimori-file://${'f'.repeat(64)}/${file.bytes}/document/unknown`,
        },
        input,
        { resolveFile: resolver },
        'openai-responses-v1'
      )
    ).rejects.toThrow('FILE_INPUT_UNAVAILABLE');
  });

  test('reports media costs as unknown while counting available extracted-text estimates', () => {
    const unknown = estimateContextInput(encodeResponses(request()).body);
    expect(unknown).toMatchObject({
      fileCount: 1,
      unknownFileCount: 1,
      fileTokens: null,
      fileTokensUnknown: true,
      fileEstimate: 'unknown',
    });
    const known = estimateContextInput(
      encodeResponses(request({ ...file, tokenEstimate: 100 })).body
    );
    expect(known).toMatchObject({
      fileCount: 1,
      unknownFileCount: 0,
      fileTokens: 110,
      fileTokensUnknown: false,
    });
    expect(known.totalTokens).toBe(known.textTokens + known.imageTokens + known.knownFileTokens);
  });

  test('redacts materialized file payloads while keeping reference diagnostics intact', () => {
    const body: Json = [
      { type: 'input_file', file_data: `data:application/pdf;base64,${base64}` },
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
      { inlineData: { mimeType: 'application/pdf', data: base64 } },
    ];
    expect(JSON.stringify(redactDiagnosticJson(body))).not.toContain(base64);
    expect(redactDiagnosticJson(providerFilePart(file, 'anthropic-messages-v1'))).toEqual(
      providerFilePart(file, 'anthropic-messages-v1')
    );
  });
});
