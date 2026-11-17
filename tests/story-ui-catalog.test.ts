import { expect, test } from 'vitest';
import { basicCatalog } from '@a2ui/web_core/catalogs/basic/v1';
import basicSchema from '../third_party/a2ui/basic-catalog-v1.json' with { type: 'json' };

test('the browser-free basic schema matches the pinned SDK catalog', () => {
  expect(basicSchema).toEqual(basicCatalog.toJson());
});
