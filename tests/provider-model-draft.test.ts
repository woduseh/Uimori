import { describe, expect, test } from 'vitest';
import type { Connection, ModelPreset } from '../core/product.js';
import {
  initialModel,
  modelDraft,
  modelDraftError,
  modelPayload,
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
