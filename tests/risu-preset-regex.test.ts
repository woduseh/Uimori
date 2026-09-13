import { expect, test } from 'vitest';
import { renderPromptTemplate, type PromptControl } from '../core/prompt-program.js';
import { importRisuPresetRegex } from '../server/risu-preset-regex.js';

const rule = (out: string, extra: Record<string, unknown> = {}) => ({
  type: 'editprocess',
  in: '^command$',
  out,
  ...extra,
});
const render = (
  out: string,
  index: number,
  lastIndex: number,
  controls: PromptControl[] = [],
  values = {}
) => {
  const converted = importRisuPresetRegex([rule(out)], controls);
  expect(converted.findings.filter((finding) => finding.level === 'unsupported')).toEqual([]);
  return renderPromptTemplate(
    converted.transforms[0].replacementTemplate!,
    values,
    { char: 'Name', slot: '' },
    { runtime: { message: { index, lastIndex } } }
  );
};

test('current and historical messages use nested generic index comparisons with exact if whitespace', () => {
  const template =
    '{{#if {{equal::{{chat_index}}::{{lastmessageid}}}}}}\n   Continue\n  now  \n{{/if}}{{#if {{not_equal::{{chatindex}}::{{lastmessageindex}}}}}}Past{{/if}}';
  expect(render(template, 4, 4)).toBe('Continue\nnow');
  expect(render(template, 0, 4)).toBe('Past');
  expect(
    render('{{#if_pure {{equal::{{chatindex}}::{{lastmessageid}}}}}}\n  retained \n{{/if}}', 2, 2)
  ).toBe('\n  retained \n');
});

test('conditions reuse preset controls and preserve nested branches', () => {
  const controls: PromptControl[] = [{ id: 'mode', label: 'Mode', type: 'text', default: null }];
  const template =
    '{{#when::{{getglobalvar::toggle_mode}}::is::active}}{{#if {{greater_equal::{{chatindex}}::{{lastmessageid}}}}}}New {{char}}{{/if}}{{:else}}Off{{/when}}';
  expect(render(template, 1, 1, controls, { mode: 'active' })).toBe('New Name');
  expect(render(template, 1, 1, controls, { mode: 'other' })).toBe('Off');
});

test('stages, flags, captures, markup text and stable priority survive conversion', () => {
  const result = importRisuPresetRegex(
    [
      rule('$1$n$&', { ableFlag: false, flag: 'i' }),
      rule('</annotation>', {
        type: 'editdisplay',
        ableFlag: true,
        flag: 'igdg<order 9,no_end_nl>',
      }),
      rule('later', { ableFlag: true, flag: 'g<order 9>' }),
      rule('off', { type: 'disabled' }),
    ],
    []
  );
  expect(result.findings.filter((item) => item.level === 'unsupported')).toEqual([]);
  expect(result.transforms.map((item) => item.id)).toEqual([
    'risu-regex-2',
    'risu-regex-3',
    'risu-regex-1',
  ]);
  expect(result.transforms[0]).toMatchObject({
    stage: 'display',
    flags: 'ig',
    replacement: '</annotation>',
  });
  expect(result.transforms[2]).toMatchObject({ stage: 'input', flags: 'g', replacement: '$1\n$&' });
  expect(result.transforms[2]).not.toHaveProperty('replacementTemplate');
  expect(importRisuPresetRegex([rule('</annotation>')], []).transforms[0].replacement).toBe(
    '</annotation>\n'
  );
});

test('unsupported stages, side effects and ambiguous CBS evaluation are isolated findings', () => {
  const unsupported = [
    rule('x', { type: 'editoutput' }),
    rule('@@inject'),
    rule('x', { ableFlag: true, flag: 'g<inject>' }),
    rule('x', { ableFlag: true, flag: 'g<cbs>' }),
    rule('x', { ableFlag: true, flag: 'v' }),
    rule('{{setvar::count::1}}'),
    rule('{{unknown}}'),
    rule('{{data}}'),
    rule('{{#if 1}}$1{{/if}}'),
    rule('{{#if 1}}wrong close{{/when}}'),
    rule('{{#if 1}}open'),
  ];
  const result = importRisuPresetRegex([...unsupported, rule('supported')], []);
  expect(result.transforms).toHaveLength(1);
  expect(result.findings.filter((item) => item.level === 'unsupported')).toHaveLength(
    unsupported.length
  );
  expect(result.transforms[0].replacement).toBe('supported');
});

test('over-limit rule sets stay intact in the original instead of truncating ordered execution', () => {
  const result = importRisuPresetRegex(
    Array.from({ length: 33 }, () => rule('replacement')),
    []
  );
  expect(result.transforms).toEqual([]);
  expect(result.findings).toEqual([
    expect.objectContaining({ code: 'RISU_PRESET_REGEX_LIMIT', level: 'unsupported' }),
  ]);
});
