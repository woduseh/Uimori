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

  test('defaults direct providers and follows Vercel model-family prefixes without overriding a manual choice', () => {
    const openai = {
      ...connection,
      id: 'openai',
      protocol: 'openai-responses-v1' as const,
      endpoint: 'https://api.openai.com/v1',
    };
    expect(selectModelConnection(initialModel(), openai).modelFamily).toBe('openai');

    const gateway = selectModelConnection(initialModel(), vercelConnection);
    expect(gateway.modelFamily).toBe('');
    const inferred = updateModelId(gateway, vercelConnection, 'anthropic/claude-opus-5.5');
    expect(inferred.modelFamily).toBe('anthropic');
    const manual = selectModelFamily(inferred, 'google');
    expect(updateModelId(manual, vercelConnection, 'openai/gpt-6-sol').modelFamily).toBe('google');
  });

  test('requires a family for an unknown gateway model and persists an explicit family and display order', () => {
    const unknown = { ...initialModel(), modelId: 'future-lab/model-1' };
    expect(modelDraftError(unknown, vercelConnection)).toBe('모델 계열을 선택해 주세요.');
    const configured = { ...unknown, modelFamily: 'xai' as const, displayOrder: 200 };
    expect(modelDraftError(configured, vercelConnection)).toBe('');
    expect(modelPayload(configured, vercelConnection)).toMatchObject({
      modelFamily: 'xai',
      displayOrder: 200,
    });
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
