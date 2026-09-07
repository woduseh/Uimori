import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import { defaultProfile } from '../core/product.js';
import { splitSource } from '../core/auxiliary.js';
import { BUILTIN_ASSETS } from '../core/fixtures/presentation.js';
import { defaultEvaluationToolOptions } from '../core/evaluation-tool-config.js';
import {
  runAuxiliaryJob,
  type AuxiliaryBundle,
  type AuxiliaryOutcome,
  type AuxiliaryStoreBridge,
} from '../server/product-auxiliary.js';

test('image evaluation artifact passes source and asset validation without treating notice as a caption', async () => {
  const text = '그녀가 부두에서 미소 지었다.';
  const source = {
    id: 'source',
    chatId: 'chat',
    text,
    hash: createHash('sha256').update(text).digest('hex'),
  };
  const asset = {
    ...BUILTIN_ASSETS[0],
    ref: 'uploaded-smile',
    alt: '미소',
    uses: ['inline' as const],
    caption: '선택적 설명',
  };
  const connection = {
    id: 'codex',
    revision: 1,
    title: 'Synthetic',
    protocol: 'codex-app-server-v1' as const,
    endpoint: 'codex://local',
    enabled: true,
    catalog: [],
    catalogError: null,
  };
  const bundle: AuxiliaryBundle = {
    source,
    assets: [asset],
    job: {
      id: 'image',
      kind: 'image',
      status: 'queued',
      sourceRevision: source.id,
      sourceHash: source.hash,
    },
    snapshot: {
      chatId: source.chatId,
      parentRevision: null,
      settingsRevision: 1,
      settings: { preset: 'calm', mode: 'direct', translation: false, status: false, maxCalls: 4 },
      request: 'Continue.',
      history: [],
      resources: [],
      profile: {
        ...defaultProfile(source.chatId),
        contents: [],
        models: {
          image: {
            id: 'model',
            revision: 1,
            title: 'Synthetic image model',
            connectionId: connection.id,
            modelId: 'synthetic',
            capabilityProtocol: 'codex-app-server-v1',
            maxOutputTokens: 4000,
            temperature: null,
            evaluationTools: defaultEvaluationToolOptions(),
            connection,
          },
        },
      },
    },
  };
  for (const corruptHash of [false, true]) {
    let saved: AuxiliaryOutcome | undefined;
    const bridge: AuxiliaryStoreBridge = {
      load: () => structuredClone(bundle),
      claim: () => 1,
      beginChunk: () => {},
      completeChunk: () => {},
      failChunk: () => {},
      finish: (_id, generation, owner, outcome) => {
        expect([generation, owner]).toEqual([1, 'worker']);
        saved = outcome;
      },
    };
    const outcome = await runAuxiliaryJob(bridge, 'image', 'worker', {
      signal: new AbortController().signal,
      approvedOrigins: [],
      authorize: async (c) => c,
      onAttemptStart: () => 'attempt',
      onAttemptFinish: () => {},
      executeCodex: async (_connection, request) => {
        expect(request.role).toBe('image');
        expect(request.stable.tools.some((tool) => tool.name === 'eval_submit_artifact')).toBe(
          true
        );
        expect(JSON.stringify(request.input.catalog)).not.toContain('/api/');
        return {
          status: 'tool_calls',
          text: '',
          refusal: null,
          error: null,
          opaqueState: null,
          usage: {
            inputTokens: null,
            outputTokens: null,
            costUsd: null,
            raw: null,
            priceRevision: null,
          },
          toolCalls: [
            {
              id: 'submit',
              name: 'eval_submit_artifact',
              arguments: {
                content: JSON.stringify({
                  sourceRevision: source.id,
                  sourceHash: source.hash,
                  entries: [
                    {
                      blockAnchor: splitSource(source)[0].anchor,
                      assetRef: asset.ref,
                      assetRevision: asset.revision,
                      assetHash: corruptHash ? 'wrong' : asset.hash,
                      presentationIntent: 'inline',
                    },
                  ],
                }),
                userFacingNotice: 'PRIVATE_NOTICE',
              },
            },
          ],
        };
      },
    });
    expect(outcome).toEqual(saved);
    expect(outcome?.status, JSON.stringify(outcome)).toBe(corruptHash ? 'failed' : 'completed');
    if (!corruptHash)
      expect(outcome?.result?.annotations).toEqual([
        {
          blockAnchor: splitSource(source)[0].anchor,
          assetRef: asset.ref,
          assetRevision: asset.revision,
          assetHash: asset.hash,
          presentationIntent: 'inline',
          caption: asset.caption,
        },
      ]);
    expect(JSON.stringify(outcome)).not.toContain('PRIVATE_NOTICE');
    expect(source.text).toBe(text);
  }
});
