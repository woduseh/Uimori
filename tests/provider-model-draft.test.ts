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
  updateModelId,
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
    const draft = { ...initialModel(), maxOutputTokens: '4096', evaluationToolsEnabled: true };
    draft.evaluationTools.maximumToolRounds = '0';
    expect(modelDraftError(draft, connection)).toBe('');
    const payload = modelPayload(draft, connection);
    expect(payload.maxOutputTokens).toBe(4096);
    expect(payload.evaluationTools?.maximumToolRounds).toBe(0);
    const restored = modelDraft({ ...payload, id: 'model', revision: 1 } as ModelPreset);
    expect(restored.maxOutputTokens).toBe('4096');
    expect(restored.evaluationTools.maximumToolRounds).toBe('0');
  });

  test.each(['', ' ', '-1', '0.5', 'NaN', '33'])(
    'does not treat an invalid evaluation round draft %j as a valid zero',
    (maximumToolRounds) => {
      const draft = initialModel();
      draft.evaluationToolsEnabled = true;
      draft.evaluationTools.maximumToolRounds = maximumToolRounds;
      expect(modelDraftError(draft, connection)).not.toBe('');
    }
  );

  test('automatic defaults never overwrite an explicit family, including a choice matching the old prefix', () => {
    const direct = { ...connection, protocol: 'openai-responses-v1' as const };
    const draft = selectModelConnection(initialModel(), direct);
    expect(draft.modelFamily).toBe('');
    expect(effectiveModelFamily(direct.protocol, draft.modelId, draft.modelFamily)).toBe('openai');
    const automatic = updateModelId(initialModel(), 'anthropic/future-model');
    expect(automatic.modelFamily).toBe('');
    expect(effectiveModelFamily(vercelConnection.protocol, automatic.modelId)).toBe('anthropic');
    const manual = selectModelFamily(automatic, 'anthropic', vercelConnection);
    expect(updateModelId(manual, 'openai/future-model').modelFamily).toBe('anthropic');
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
