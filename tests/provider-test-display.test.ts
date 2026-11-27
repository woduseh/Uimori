import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import type { ModelPreset } from '../core/product.js';
import type { ProviderConnectionTest } from '../core/provider-connection-test.js';
import { ProviderModelTest, testKey } from '../web/ProviderModelTest.js';

const model = { id: 'model-1', revision: 1, title: 'Test model' } as ModelPreset;
const shown = (error: string, location?: string) => {
  const result = {
    status: 'error',
    error,
    rejection: null,
    latencyMs: null,
  } as unknown as ProviderConnectionTest;
  return renderToStaticMarkup(
    createElement(ProviderModelTest, {
      model,
      records: { [testKey(model, location)]: { pending: false, idempotencyKey: 'key', result } },
      vertexLocation: location,
      available: true,
      busy: false,
      onStart: async () => {},
      onCancel: () => {},
      onDismiss: () => {},
      onChangeLocation: () => {},
    })
  );
};

test('a stored connection test code is worded by its failure family and kept under the error details', () => {
  const markup = shown('HTTP_401');
  expect(markup).toContain('프로바이더가 인증을 거부했어요.');
  expect(markup).toMatch(/<details>.*HTTP_401.*<\/details>/su);
});

test('a compared location with an unlisted stored code shows its family message, not the code', () => {
  const markup = shown('TRANSPORT_ERROR', 'us-central1');
  expect(markup).toMatch(/provider-location-outcome">프로바이더에 연결하지 못했어요\./u);
});

test('a failure whose family adds nothing to the status line is not repeated under it', () => {
  const markup = shown('CONNECTION_TEST_FAILED');
  expect(markup).toContain('응답에 실패했어요.');
  expect(markup).not.toContain('응답을 만들지 못했어요.');
  expect(markup).toMatch(/<details>.*CONNECTION_TEST_FAILED.*<\/details>/su);
});
