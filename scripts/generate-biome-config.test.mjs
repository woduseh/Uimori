import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatBiomeConfig } from './generate-biome-config.mjs';

const formatter = { indentStyle: 'space', indentWidth: 2, lineEnding: 'lf' };
const sample = { items: ['aaaa', 'bbbb', 'cccc', 'dddd'] };

test('the generated file is formatted by its own settings, not by the biome.json on disk', () => {
  const narrow = formatBiomeConfig({ formatter: { ...formatter, lineWidth: 20 }, ...sample });
  const wide = formatBiomeConfig({ formatter: { ...formatter, lineWidth: 100 }, ...sample });
  assert.match(narrow, /"items": \[\n\s+"aaaa",\n/u);
  assert.match(wide, /"items": \["aaaa", "bbbb", "cccc", "dddd"\]/u);
});
