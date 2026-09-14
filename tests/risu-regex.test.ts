import { expect, test } from 'vitest';
import { importRisuDisplayRegex } from '../server/risu-regex.js';
import { applyPackageTransforms } from '../server/package-transforms.js';

test('display rules preserve default flags, captures, newline escapes and explicit ordering', async () => {
  const imported = importRisuDisplayRegex([
    { type: 'editdisplay', in: 'HP: (\\d+)', out: '**$1**$n', ableFlag: false, flag: 'i' },
    {
      type: 'editdisplay',
      in: '<hp>(\\d+)</hp>',
      out: 'HP: $1',
      ableFlag: true,
      flag: 'g<order 8>',
    },
    { type: 'disabled', in: '.', out: 'disabled' },
  ]);
  expect(imported.findings.some((item) => item.level === 'unsupported')).toBe(false);
  expect(imported.transforms.map((item) => item.id)).toEqual(['risu-display-1', 'risu-display-0']);
  const source = '<hp>3</hp> and <hp>5</hp>';
  expect((await applyPackageTransforms(source, imported.transforms, 'source')).text).toBe(
    '**3**\n and **5**\n'
  );
  expect(source).toBe('<hp>3</hp> and <hp>5</hp>');
  expect((await applyPackageTransforms(source, imported.transforms, 'translation')).text).toBe(
    source
  );
});

test('unsupported actions and HTML remain findings rather than executable display rules', () => {
  const examples = [
    { type: 'editinput', in: '.', out: 'changed input' },
    { type: 'editdisplay', in: '.', out: '{{setvar::count::1}}' },
    { type: 'editdisplay', in: '.', out: '@@inject' },
    { type: 'editdisplay', in: '.', out: '<div>panel</div>' },
    { type: 'editdisplay', in: '{{getvar::pattern}}', out: 'x', ableFlag: true, flag: 'g<cbs>' },
  ];
  const result = importRisuDisplayRegex(examples);
  expect(result.transforms).toEqual([]);
  expect(result.findings).toHaveLength(examples.length);
  expect(result.findings.every((item) => item.level === 'unsupported')).toBe(true);
});

test('send-time stages and the no_end_nl action stay out of the display-only import', () => {
  const result = importRisuDisplayRegex([
    { type: 'editprocess', in: '.', out: 'sent before the request' },
    { type: 'editdisplay', in: '.', out: 'trailing>', ableFlag: true, flag: 'g<no_end_nl>' },
  ]);
  expect(result.transforms).toEqual([]);
  expect(result.findings.map((item) => item.code)).toEqual([
    'regex-0-unsupported',
    'regex-1-unsupported',
  ]);
});
