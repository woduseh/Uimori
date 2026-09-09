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
});
