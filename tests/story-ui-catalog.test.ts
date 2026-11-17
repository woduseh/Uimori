import { expect, test } from 'vitest';
import { basicCatalog } from '@a2ui/web_core/catalogs/basic/v1';
import basicSchema from '../third_party/a2ui/basic-catalog-v1.json' with { type: 'json' };
import { storyUiIcons } from '../web/story-ui-icons.js';

test('the browser-free basic schema matches the pinned SDK catalog', () => {
  expect(basicSchema).toEqual(basicCatalog.toJson());
});

test('every catalog icon name has a bundled glyph', () => {
  const names = basicSchema.components.Icon.properties.name.oneOf.find(
    (option) => 'enum' in option
  )!.enum;
  expect(Object.keys(storyUiIcons).sort()).toEqual([...names!].sort());
});
