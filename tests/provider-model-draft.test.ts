import { pricingDraft, pricingPayload } from '../web/provider-model-draft.js';
import { effectiveModelFamily } from '../core/model-family.js';
import { describe, expect, test } from 'vitest';
import type { Connection, ModelPreset } from '../core/product.js';
import {
  initialModel,
  modelDraft,
  modelDraftError,
  modelPayload,
  selectModelConnection,
  selectModelFamily,
} from '../web/provider-model-draft.js';

const connection: Connection = {
  id: 'synthetic',
  revision: 1,
  title: 'Synthetic',
  protocol: 'fixture-sse-v1',
  endpoint: 'http://127.0.0.1:9/turn',
  enabled: true,
  catalog: [],
  catalogError: null,
};
const anthropicConnection: Connection = {
  ...connection,
  id: 'anthropic',
  title: 'Anthropic',
  protocol: 'anthropic-messages-v1',
  endpoint: 'https://api.anthropic.com/v1',
};
const vercelConnection: Connection = {
  ...connection,
  id: 'vercel',
  title: 'Vercel AI Gateway',
  protocol: 'vercel-chat-v1',
  endpoint: 'https://ai-gateway.vercel.sh/v1',
};

describe('model numeric drafts', () => {
  test('AI Studio presets ignore the server Vertex tier restriction', () => {
    const studio: Connection = { ...connection, protocol: 'google-gemini-v1' };
    expect(
      modelDraftError({ ...initialModel(), modelId: 'gemini-3.1-pro-preview' }, studio, 'flex')
    ).toBe('');
  });

  test('keeps manual tokenizers through model and connection changes and omits automatic selection', () => {
    const manual = { ...initialModel(), tokenizer: 'glm-5' as const };
    const changed = selectModelConnection(
      { ...manual, modelId: 'future-lab/new-model' },
      anthropicConnection
    );
    expect(changed.tokenizer).toBe('glm-5');
    const payload = modelPayload(changed, anthropicConnection);
    expect(payload.tokenizer).toBe('glm-5');
    const restored = modelDraft({ ...payload, id: 'model', revision: 1 } as ModelPreset);
    expect(restored.tokenizer).toBe('glm-5');
    const automatic = modelPayload({ ...restored, tokenizer: '' }, anthropicConnection);
    expect(automatic).not.toHaveProperty('tokenizer');
    expect(modelDraft({ ...automatic, id: 'model', revision: 2 } as ModelPreset).tokenizer).toBe(
      ''
    );
  });

  test('Gemini filter drafts round-trip, omit defaults and clear on unsupported connections', () => {
    const vertex: Connection = { ...connection, protocol: 'vertex-gemini-v1' };
    const studio: Connection = { ...connection, protocol: 'google-gemini-v1' };
    const defaults = initialModel();
    expect(modelPayload(defaults, studio)).not.toHaveProperty('safetySettings');
    const selected = {
      ...defaults,
      modelId: 'gemini-3.8-flash',
      safetySettings: {
        HARM_CATEGORY_HARASSMENT: 'OFF' as const,
        HARM_CATEGORY_SEXUALLY_EXPLICIT: 'BLOCK_NONE' as const,
      },
    };
    for (const gemini of [vertex, studio]) {
      expect(modelDraftError(selected, gemini)).toBe('');
      const saved = modelPayload(selected, gemini);
      const restored = modelDraft({ ...saved, id: 'model', revision: 1 } as ModelPreset);
      expect(restored.safetySettings).toEqual(selected.safetySettings);
      expect(restored.safetySettings).not.toBe(selected.safetySettings);
    }
    expect(modelDraftError(selected, anthropicConnection)).not.toBe('');
    const changed = selectModelConnection(selected, anthropicConnection);
    expect(changed.safetySettings).toEqual({});
    expect(modelPayload(changed, anthropicConnection)).not.toHaveProperty('safetySettings');
  });

  test('uses a 600-second response timeout for new models', () => {
    expect(initialModel().timeoutSeconds).toBe('600');
    expect(modelPayload(initialModel(), connection).timeoutMs).toBe(600_000);
  });

  test('keeps Anthropic Batch as host execution mode and resets it on another connection', () => {
    const batch = { ...initialModel(), modelId: 'claude-opus-5', executionMode: 'batch' as const };
    expect(modelPayload(batch, anthropicConnection)).toMatchObject({ executionMode: 'batch' });
    expect(modelPayload(batch, connection)).not.toHaveProperty('executionMode');
    expect(selectModelConnection(batch, connection).executionMode).toBe('realtime');
    expect(
      modelDraft({
        ...modelPayload(batch, anthropicConnection),
        id: 'model',
        revision: 1,
      } as ModelPreset).executionMode
    ).toBe('batch');
  });

  test.each(['', ' ', '0', '-1', '1.5', 'NaN', 'Infinity', '500001'])(
    'rejects invalid required output tokens %j before saving',
    (maxOutputTokens) => {
      expect(modelDraftError({ ...initialModel(), maxOutputTokens }, connection)).not.toBe('');
    }
  );

  test('converts edited numeric strings on save and restores numeric presets as text', () => {
    const draft = { ...initialModel(), maxOutputTokens: '4096' };
    expect(modelDraftError(draft, connection)).toBe('');
    const payload = modelPayload(draft, connection);
    expect(payload.maxOutputTokens).toBe(4096);
    const restored = modelDraft({ ...payload, id: 'model', revision: 1 } as ModelPreset);
    expect(restored.maxOutputTokens).toBe('4096');
  });

  test.each(['openai', 'anthropic', 'deepmind', 'neutral'] as const)(
    'keeps the manual %s evaluation profile across context modes and connection changes',
    (metadataProfile) => {
      for (const contextMode of ['model-selected', 'preloaded'] as const) {
        const draft = {
          ...initialModel(),
          evaluationToolsEnabled: true,
          evaluationTools: {
            contextMode,
            approvalReasoningMode: 'economized' as const,
            metadataProfile,
          },
        };
        const changed = selectModelConnection(draft, anthropicConnection);
        expect(modelDraftError(changed, anthropicConnection)).toBe('');
        const payload = modelPayload(changed, anthropicConnection);
        expect(payload.evaluationTools).toEqual({
          contextMode,
          approvalReasoningMode: 'economized',
          metadataProfile,
        });
        expect(payload.evaluationTools).not.toBe(changed.evaluationTools);
        const restored = modelDraft({ ...payload, id: 'model', revision: 1 } as ModelPreset);
        expect(restored.evaluationTools).toEqual(payload.evaluationTools);
        expect(
          modelPayload({ ...restored, evaluationToolsEnabled: false }, anthropicConnection)
        ).not.toHaveProperty('evaluationTools');
      }
    }
  );

  test('opens a retired source-bound preset with evaluation disabled and omits it on save', () => {
    const preset = {
      ...modelPayload(initialModel(), connection),
      id: 'legacy-model',
      revision: 1,
      evaluationTools: {
        contextMode: 'source-bound',
        approvalReasoningMode: 'configured',
        metadataProfile: 'deepmind',
        maximumToolRounds: 8,
        terminalLateCorrections: true,
      },
    } as unknown as ModelPreset;
    const draft = modelDraft(preset);
    expect(draft.evaluationToolsEnabled).toBe(false);
    expect(draft.evaluationTools.contextMode).toBe('model-selected');
    expect(modelDraftError(draft, connection)).toBe('');
    expect(modelPayload(draft, connection)).not.toHaveProperty('evaluationTools');
  });

  test.each(['model-selected', 'preloaded'] as const)(
    'keeps legacy %s evaluation choices while dropping retired settings from the next save',
    (contextMode) => {
      const preset = {
        ...modelPayload(initialModel(), connection),
        id: 'legacy-model',
        revision: 1,
        evaluationTools: {
          contextMode,
          approvalReasoningMode: 'economized',
          metadataProfile: 'anthropic',
          maximumToolRounds: 3,
          terminalLateCorrections: true,
          outputRecovery: true,
        },
      } as unknown as ModelPreset;
      const draft = modelDraft(preset);
      expect(draft.evaluationToolsEnabled).toBe(true);
      expect(modelDraftError(draft, connection)).toBe('');
      expect(modelPayload(draft, connection).evaluationTools).toEqual({
        contextMode,
        approvalReasoningMode: 'economized',
        metadataProfile: 'anthropic',
      });
    }
  );

  test('automatic defaults never overwrite an explicit family, including a choice matching the old prefix', () => {
    const direct = { ...connection, protocol: 'openai-responses-v1' as const };
    const draft = selectModelConnection(initialModel(), direct);
    expect(draft.modelFamily).toBe('');
    expect(effectiveModelFamily(direct.protocol, draft.modelId, draft.modelFamily)).toBe('openai');
    const automatic = { ...initialModel(), modelId: 'anthropic/future-model' };
    expect(automatic.modelFamily).toBe('');
    expect(effectiveModelFamily(vercelConnection.protocol, automatic.modelId)).toBe('anthropic');
    const manual = selectModelFamily(automatic, 'anthropic', vercelConnection);
    expect(
      modelPayload({ ...manual, modelId: 'openai/future-model' }, vercelConnection)
    ).toMatchObject({ modelId: 'openai/future-model', modelFamily: 'anthropic' });
    expect(selectModelFamily(manual, '', vercelConnection).modelFamily).toBe('');
  });

  test('an unknown gateway family can save common options without impersonating a known maker', () => {
    const unknown = { ...initialModel(), modelId: 'future-lab/model-1', topP: '0.8' };
    expect(modelDraftError(unknown, vercelConnection)).toBe('');
    expect(modelPayload(unknown, vercelConnection)).toMatchObject({ topP: 0.8 });
    expect(modelPayload(unknown, vercelConnection)).not.toHaveProperty('modelFamily');
    expect(modelPayload({ ...unknown, modelFamily: 'xai' }, vercelConnection)).toHaveProperty(
      'modelFamily',
      'xai'
    );
  });

  test('changing family clears unavailable generation fields but keeps shared values', () => {
    const before = {
      ...initialModel(),
      modelFamily: 'openai' as const,
      modelId: 'custom',
      maxOutputTokens: '16000',
      temperature: '0.3',
      topP: '0.7',
      reasoningEffort: 'high',
      reasoningMode: 'standard',
      reasoningContext: 'auto',
      verbosity: 'low',
      cacheMode: 'automatic',
      cacheTtl: '30m',
    };
    const after = selectModelFamily(before, 'google', vercelConnection);
    expect(after).toMatchObject({
      modelFamily: 'google',
      maxOutputTokens: '16000',
      temperature: '0.3',
      topP: '0.7',
      reasoningEffort: '',
      reasoningMode: '',
      reasoningContext: '',
      verbosity: '',
      cacheMode: '',
      cacheTtl: '',
    });
    expect(modelDraftError(after, vercelConnection)).toBe('');
    const same = selectModelFamily(
      { ...initialModel(), reasoningEffort: 'high' },
      'openai',
      vercelConnection
    );
    expect(same.reasoningEffort).toBe('high');
  });

  test('keeps Vercel providerOptions as JSON and leaves it out of other protocols', () => {
    const draft = {
      ...initialModel(),
      modelId: 'openai/gpt-5.6-sol',
      providerOptions: '{\n  "gateway": {\n    "only": ["openai"]\n  }\n}',
    };
    expect(modelDraftError(draft, vercelConnection)).toBe('');
    expect(modelPayload(draft, vercelConnection).providerOptions).toEqual({
      gateway: { only: ['openai'] },
    });
    expect(modelPayload(draft, connection)).not.toHaveProperty('providerOptions');
    const restored = modelDraft({
      ...modelPayload(draft, vercelConnection),
      id: 'model',
      revision: 1,
    } as ModelPreset);
    expect(JSON.parse(restored.providerOptions)).toEqual({ gateway: { only: ['openai'] } });
  });

  test.each(['{', '{"gateway":{"apiKey":"secret"}}'])(
    'reports invalid Vercel providerOptions %s without saving',
    (providerOptions) => {
      expect(
        modelDraftError(
          { ...initialModel(), modelId: 'openai/gpt-5.6-sol', providerOptions },
          vercelConnection
        )
      ).toMatch(/providerOptions/);
    }
  );
});

test('manual pricing editor round-trips source metadata and independent Flex, Batch and long-context rates', () => {
  const pricing = {
    mode: 'manual' as const,
    rates: { input: 2, cacheRead: 0, cacheWrite: null, output: 8 },
    flexRates: { input: 1, cacheRead: null, cacheWrite: null, output: 3 },
    batchRates: { input: 1.5, cacheRead: 0, cacheWrite: 2, cacheWrite1h: 4, output: 7 },
    longContext: {
      aboveInputTokens: 200000,
      rates: { input: 4, cacheRead: 0, cacheWrite: null, output: 12 },
    },
    flexLongContext: {
      aboveInputTokens: 200000,
      rates: { input: 3, cacheRead: null, cacheWrite: null, output: 6 },
    },
    batchLongContext: {
      aboveInputTokens: 200000,
      rates: { input: 5, cacheRead: 0, cacheWrite: 6, output: 10 },
    },
    sourceUrl: 'https://example.com/pricing',
    checkedAt: '2026-10-18',
  };
  const draft = pricingDraft(pricing);
  expect(pricingPayload(draft)).toEqual(pricing);
  expect(draft.rates.cacheRead).toBe('0');
  expect(draft.rates.cacheWrite).toBe('');
});
