import { prepareNativeRisuRun } from '../server/risu-native-run.js';
import { nativeContent } from './fixtures/native-content.js';
import { describe, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { createDefaultRisuPrompt } from '../core/prompt-defaults.js';
import { defaultProfile, type ProviderProtocol } from '../core/product.js';
import { DEFAULT_MAIN_PROMPT, DEFAULT_TRANSLATION_PROMPT } from '../core/prompts.js';
import { compileTranslationPrompt, translationInput } from '../core/auxiliary.js';
import { sourceTimeContext } from '../server/product-auxiliary.js';
import { buildMainProviderRequest, encodeMainPreview } from '../server/main-request.js';
import { encodeVertex } from '../core/vertex-protocol.js';
import { encodeResponses } from '../core/openai-protocol.js';
import { encodeChat } from '../core/openai-chat-protocol.js';
import { encodeAnthropic } from '../core/anthropic-protocol.js';
import { planNativeMessages } from '../core/provider-messages.js';
import type { ProviderRequest } from '../core/transport.js';
import type { RunSnapshot } from '../core/types.js';

const protocols: ProviderProtocol[] = [
  'vertex-gemini-v1',
  'openai-responses-v1',
  'openai-chat-v1',
  'anthropic-messages-v1',
  'vercel-chat-v1',
];
function snapshot(protocol: ProviderProtocol): RunSnapshot {
  const modelId =
    protocol === 'vertex-gemini-v1'
      ? 'gemini-3.8-flash'
      : protocol === 'anthropic-messages-v1'
        ? 'claude-opus-5'
        : 'gpt-5.6';
  const target = {
    id: 'model',
    revision: 1,
    title: 'Synthetic',
    connectionId: 'connection',
    connectionRevision: 1,
    modelId,
    maxOutputTokens: 1024,
    temperature: null,
    connection: {
      id: 'connection',
      revision: 1,
      title: 'Synthetic',
      protocol,
      endpoint: 'https://synthetic.invalid',
      enabled: true,
      catalog: [],
      catalogError: null,
    },
  };
  return {
    chatId: 'default-prompt',
    parentRevision: null,
    settingsRevision: 1,
    settings: { preset: 'calm', mode: 'direct', translation: true, status: false, maxCalls: 3 },
    request: 'Continue.',
    history: [],
    resources: [],
    profile: {
      ...defaultProfile('default-prompt'),
      packageAttachments: [{ id: 'module', revision: 3, role: 'module' }],
      packages: [
        nativeContent(
          { name: 'Scope', description: 'Pinned module evidence.' },
          { id: 'module', revision: 3 },
          'module'
        ),
      ],
      models: { main: target, translation: target },
    },
  };
}
describe('single prompt program defaults at real native encoder boundaries', () => {
  test.each(protocols)(
    '%s keeps default main references and compiles explicit instructions through the same path',
    async (protocol) => {
      const seed = snapshot(protocol);
      for (const custom of [false, true]) {
        if (custom)
          seed.profile!.promptPresets = {
            main: {
              id: 'prompt',
              revision: 1,
              title: 'Simple',
              role: 'main',
              program: createDefaultRisuPrompt('Literal {{char}}'),
            },
          };
        const built = buildMainProviderRequest(await prepareNativeRisuRun(seed));
        const before = structuredClone(built.request.prompt);
        const preview = encodeMainPreview(built.request, seed.profile!.models.main!);
        expect(built.request.stable.contract).toBe('');
        expect(built.request.prompt!.messages[0].content[0].text).toBe(
          custom ? 'Literal Character' : DEFAULT_MAIN_PROMPT
        );
        expect(JSON.stringify(preview.body)).toContain('Pinned module evidence.');
        expect(JSON.stringify(preview.body).split('Pinned module evidence.')).toHaveLength(2);
        expect(JSON.stringify(preview.body)).toContain('package:module:module:body');
        expect(built.request.prompt).toEqual(before);
      }
    }
  );
  test.each(protocols)(
    '%s compiles default translation with exact source context/schema and no main history',
    (protocol) => {
      const seed = snapshot(protocol),
        source = {
          id: 'source',
          chatId: seed.chatId,
          text: 'Quiet harbor.',
          hash: createHash('sha256').update('Quiet harbor.').digest('hex'),
        };
      seed.history = [{ revision: 'main-history', text: 'MAIN HISTORY MUST NOT LEAK' }];
      const input = translationInput(source, sourceTimeContext(seed, 'translation'), seed);
      const compilation = compileTranslationPrompt(input, seed, 'Translate this chunk.')!;
      const request: ProviderRequest = {
        role: 'translation',
        modelId: seed.profile!.models.translation!.modelId,
        generation: { maxOutputTokens: 1024, temperature: null },
        stable: { contract: '', tools: [] },
        prompt: {
          compilerVersion: compilation.compilerVersion,
          messages: compilation.messages,
          cachePlan: compilation.cachePlan,
          values: compilation.values,
        },
        input: {
          task: 'Translate this chunk.',
          controls: {},
          source: {
            sourceRevision: source.id,
            sourceHash: source.hash,
            outputSchema: JSON.parse(JSON.stringify(input.outputSchema)),
          },
          results: [],
        },
      };
      const body =
        protocol === 'vertex-gemini-v1'
          ? encodeVertex(request).body
          : protocol === 'anthropic-messages-v1'
            ? encodeAnthropic(request).body
            : protocol === 'openai-responses-v1'
              ? encodeResponses(request).body
              : encodeChat(request).body;
      expect(compilation.messages[0].content[0].text).toBe(DEFAULT_TRANSLATION_PROMPT);
      expect(compilation.messages.filter((m) => m.provenance.origin === 'history')).toHaveLength(0);
      expect(compilation.messages.filter((m) => m.provenance.origin === 'current')).toHaveLength(1);
      expect(JSON.stringify(body)).toContain(source.hash);
      expect(compilation.messages.some((message) => message.id === 'outputSchema')).toBe(false);
      if (protocol === 'vertex-gemini-v1') {
        const mapped = planNativeMessages(request, protocol)!;
        expect(mapped.messages).toHaveLength(1);
        expect((mapped.messages[0] as { parts: unknown[] }).parts).toHaveLength(
          compilation.messages.filter((m) => m.role === 'user').length
        );
      }
    }
  );
});
