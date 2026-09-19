import { expect, test } from 'vitest';
import { renderPromptTemplate } from '../core/prompt-program.js';
import { RisuCbs } from './fixtures/legacy-risu/risu-cbs.js';
import { importRisuVariableDefaults } from '../server/risu-variable-defaults.js';
import { importRisuPresetProgram } from '../server/risu-preset-program.js';

test('Risu defaults preserve first duplicates, whitespace and first equals pair without creating state', () => {
  expect(
    importRisuVariableDefaults('a=b=c\na=later\n a = value \nempty=\n=missing\ncr=x\r\n0=0')
  ).toEqual({
    a: 'b',
    ' a ': ' value ',
    cr: 'x\r',
    '0': '0',
  });
  expect(importRisuVariableDefaults(undefined)).toBeUndefined();
  expect(() => importRisuVariableDefaults('__proto__=unsafe')).toThrow();
  expect(() => importRisuVariableDefaults({ a: 'x' })).toThrow();
  const imported = importRisuPresetProgram({
    templateDefaultVariables: 'a=b\na=later',
    promptTemplate: [{ type: 'plain', text: '{{getvar::a}}', role: 'system' }],
  });
  expect(imported.program.variableDefaults).toEqual({ a: 'b' });
  expect(imported.program.blocks[0].enabled).not.toBe(false);
});

test('one CBS parser reads names and defaults with strict truth and nested comparisons', () => {
  const cbs = new RisuCbs(new Map(), { names: 'context' });
  const template = cbs.template(
    '{{char}}/{{user}}:{{getvar::missing}}|{{getvar::empty}}|{{#when::var::flag}}on{{:else}}off{{/when}}|{{#when::mode::vis::0}}zero{{/when}}|{{#when::mode::visnot::1}}other{{/when}}|{{#if {{equal::{{getvar::flag}}::true}}}}\n  yes\n{{/if}}|{{#if_pure 1}}\n  raw\n{{/if}}|{{getvar::{{equal::1::1}}}}'
  );
  const render = (flag: string) =>
    renderPromptTemplate(
      template,
      {},
      {},
      {
        runtime: {
          bot: { name: 'Bot' },
          user: { name: 'User' },
          variables: { flag, mode: '0', empty: '', '1': 'computed key' },
        },
      }
    );
  expect(render('true')).toBe('Bot/User:null||on|zero|other|yes|\n  raw\n|computed key');
  expect(render('arbitrary')).toBe('Bot/User:null||off|zero|other||\n  raw\n|computed key');
  expect(renderPromptTemplate(cbs.template('{{getvar::missing}}'), {}, {})).toBe('null');
  for (const source of [
    '{{setvar::x::1}}',
    '{{addvar::x::1}}',
    '{{getvar::__proto__}}',
    '{{chatindex}}',
  ])
    expect(() => cbs.template(source)).toThrow();
  expect(
    renderPromptTemplate(
      cbs.template('{{getvar::literal}}'),
      {},
      {},
      { runtime: { variables: { literal: '{{setvar::x::1}}' } } }
    )
  ).toBe('{{setvar::x::1}}');
});

test('a comment renders as nothing and never fails the field it sits in', () => {
  const cbs = new RisuCbs(new Map(), { names: 'context' });
  const name = [{ kind: 'value', expression: { context: ['bot', 'name'] } }];
  expect(cbs.template('{{// note}}{{char}}')).toEqual(name);
  expect(cbs.template('{{comment::note}}{{char}}')).toEqual(name);
  expect(cbs.expression('{{equal::{{// note}}::{{comment::note}}}}')).toEqual({
    op: 'equal',
    args: ['', ''],
  });
});

test('invalid native preset defaults are rejected without unsafe declarations', () => {
  expect(() =>
    importRisuPresetProgram({
      templateDefaultVariables: 'constructor=bad',
      promptTemplate: [{ type: 'plain', text: '{{getvar::safe}}', role: 'system' }],
    })
  ).toThrow();
});
