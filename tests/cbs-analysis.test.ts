import { afterEach, describe, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  analyzeCbs,
  cbsMatchingRanges,
  normalizeCbsFunctionName,
  type CbsAnalysis,
  type CbsDiagnosticCode,
} from '../core/cbs-analysis.js';
import { createNativeRisuCbs, nativeRisuCbsFunctionCatalog } from '../server/risu-native-cbs.js';
import { createApp, type App } from '../server/app.js';
import type { RisuContentSource } from '../core/risu-native.js';

const native: RisuContentSource = {
  version: 1,
  card: { name: 'Guide', first_mes: '', extensions: { risuai: {} } },
  assets: [],
  sourceHash: 'a'.repeat(64),
};
const catalog = nativeRisuCbsFunctionCatalog();
const slice = (text: string, range: { from: number; to: number }) =>
  text.slice(range.from, range.to);
const codes = (analysis: CbsAnalysis) => analysis.diagnostics.map((item) => item.code);

describe('tokens and calls', () => {
  test('nested calls keep their own braces, names and argument ranges', () => {
    const text = 'Hi {{setvar::mood::{{getvar::base}}}} end';
    const analysis = analyzeCbs(text);
    const [inner, outer] = [analysis.calls[1]!, analysis.calls[0]!];
    expect(outer.name).toBe('setvar');
    expect(outer.arguments.map((arg) => [slice(text, arg), arg.dynamic])).toEqual([
      ['mood', false],
      ['{{getvar::base}}', true],
    ]);
    expect(inner.parent).toBe(outer.id);
    expect(slice(text, outer)).toBe('{{setvar::mood::{{getvar::base}}}}');
    expect(analysis.tokens.map((token) => `${token.kind}:${slice(text, token)}`)).toEqual([
      'text:Hi ',
      'open:{{',
      'name:setvar',
      'separator:::',
      'text:mood',
      'separator:::',
      'open:{{',
      'name:getvar',
      'separator:::',
      'text:base',
      'close:}}',
      'close:}}',
      'text: end',
    ]);
    expect(analysis.diagnostics).toEqual([]);
  });

  test('a single colon splits arguments only when the first colon is not doubled', () => {
    const single = analyzeCbs('{{getvar:a::b}}');
    expect(single.calls[0]!.arguments.map((arg) => slice('{{getvar:a::b}}', arg))).toEqual([
      'a',
      '',
      'b',
    ]);
    const double = analyzeCbs('{{getvar::a:b}}');
    expect(double.calls[0]!.arguments.map((arg) => slice('{{getvar::a:b}}', arg))).toEqual(['a:b']);
  });

  test('block openers pair with the next closer whatever its name', () => {
    const text = '{{#when::x::is::1}}A{{:else}}B{{/if}}';
    const analysis = analyzeCbs(text);
    const block = analysis.blocks[0]!;
    expect(block.kind).toBe('when');
    expect(slice(text, analysis.calls[block.opener]!)).toBe('{{#when::x::is::1}}');
    expect(slice(text, analysis.calls[block.closer!]!)).toBe('{{/if}}');
    expect(block.elses).toEqual([1]);
    expect(cbsMatchingRanges(analysis, 4)?.ranges.map((range) => slice(text, range))).toEqual([
      '{{#when::x::is::1}}',
      '{{/if}}',
    ]);
    expect(analysis.diagnostics).toEqual([]);
  });

  test('comments are removed before parsing, as the native adapter does', () => {
    const text = 'a{{// note {{x}} }}b{{user}}';
    const analysis = analyzeCbs(text);
    expect(analysis.comments.map((range) => slice(text, range))).toEqual(['{{// note {{x}} }}']);
    expect(analysis.calls.map((call) => slice(text, call))).toEqual(['{{user}}']);
    expect(analysis.tokens[1]).toMatchObject({ kind: 'comment' });
  });

  test('pure bodies keep brace pairing but treat nested blocks as literal pairs', () => {
    const text = '{{#pure}}{{#if 1}}x{{/if}}{{/pure}}{{user}}';
    const analysis = analyzeCbs(text);
    expect(analysis.blocks.map((block) => [block.kind, block.keyword])).toEqual([
      ['pure', '#pure'],
      [null, '#if'],
    ]);
    expect(analysis.calls.at(-1)!.context).toBe('evaluated');
    expect(analysis.calls[1]!.context).toBe('inert');
    expect(analysis.diagnostics).toEqual([]);
  });

  test('legacy angle names and the hash closer follow the native parser', () => {
    const text = '<user> {#if 1\nyes#} {{a#}}';
    const analysis = analyzeCbs(text);
    expect(analysis.calls.map((call) => [call.kind, slice(text, call)])).toEqual([
      ['legacy-name', '<user>'],
      ['legacy-block', '{#if 1\nyes#}'],
      ['legacy-block', '{{a#}'],
    ]);
  });
});

describe('references', () => {
  test('variable functions, math and #when operators report literal and dynamic names', () => {
    const text = [
      '{{getvar::hp}}{{setvar::hp::1}}{{addvar::gold::2}}{{setdefaultvar::seen::0}}',
      '{{tempvar::t}}{{settempvar::t::1}}{{getglobalvar::toggle_rain}}',
      '{{? $hp + @level}}{{calc::$gold*2}}',
      '{{#when::toggle::rain}}{{/when}}{{#when::mood::vis::calm}}{{/when}}',
      '{{getvar::{{tempvar::key}}}}',
    ].join('');
    const refs = analyzeCbs(text).references.map((ref) => [ref.scope, ref.access, ref.name]);
    expect(refs).toEqual([
      ['chat', 'read', 'hp'],
      ['chat', 'write', 'hp'],
      ['chat', 'update', 'gold'],
      ['chat', 'update', 'seen'],
      ['temp', 'read', 't'],
      ['temp', 'write', 't'],
      ['global', 'read', 'toggle_rain'],
      ['chat', 'read', 'hp'],
      ['global', 'read', 'level'],
      ['chat', 'read', 'gold'],
      ['global', 'read', 'toggle_rain'],
      ['chat', 'read', 'mood'],
      ['temp', 'read', 'key'],
      ['chat', 'read', ''],
    ]);
    const dynamic = analyzeCbs(text).references.at(-1)!;
    expect(dynamic.dynamic).toBe(true);
    expect(slice(text, dynamic)).toBe('{{tempvar::key}}');
  });

  test('function names normalise like Risu while variable names stay exact', () => {
    expect(normalizeCbsFunctionName(' Get_Var ')).toBe('getvar');
    const analysis = analyzeCbs('{{ Get_Var :: My Name }}');
    expect(analysis.references[0]).toMatchObject({ name: ' My Name ', scope: 'chat' });
  });

});

describe('diagnostics', () => {
  const cases: [string, CbsDiagnosticCode[]][] = [
    ['{{user', ['cbs.unclosed-call']],
    ['{{#when 1}}open', ['cbs.unclosed-block']],
    ['text{{/when}}', ['cbs.stray-closer']],
    ['{{#if 1}}a{{:else}}b{{/if}}', ['cbs.else-outside-when']],
    ['{{#when 1}}{{#if 1}}{{:else}}{{/if}}{{/when}}', []],
    ['{{#pure}}{{#if 1}}{{/pure}}', ['cbs.unclosed-block']],
    ['{{nope::x}} {{img::a}} {{getvar::x}} {{call::f}}', ['cbs.unknown-function']],
    ['{{#puredisplay}}{{nope}}{{/puredisplay}}', []],
    ['{{#func greet}}{{arg::0}}{{/func}}{{#each [1] as v}}{{slot::v}}{{/each}}', []],
    ['{# not a call', []],
  ];
  test.each(cases)('%s', (text, expected) => {
    expect(codes(analyzeCbs(text, { catalog }))).toEqual(expected);
  });

  test('ranges point at the original text when comments come first', () => {
    const text = '{{// skip }}{{nope}}';
    const [diagnostic] = analyzeCbs(text, { catalog }).diagnostics;
    expect(slice(text, diagnostic!)).toBe('nope');
  });

  test('unknown names are only checked when a catalog is passed', () => {
    expect(analyzeCbs('{{nope}}').diagnostics).toEqual([]);
  });
});

function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function matcherName(dat: string) {
  const colon = dat.indexOf(':');
  const parts = colon !== -1 && dat[colon + 1] === ':' ? dat.split('::') : dat.split(':');
  return normalizeCbsFunctionName(parts[0]!);
}

function generateSnippet(next: () => number, noisy: boolean) {
  let counter = 0;
  let dropped = false;
  const pick = <T>(items: T[]) => items[Math.floor(next() * items.length)]!;
  const maybeDrop = (part: string) => {
    if (!noisy || dropped || next() > 0.08) return part;
    dropped = true;
    return '';
  };
  const openers = [
    ['{{#when 1}}', '{{/when}}'],
    ['{{#when::0}}', '{{/when}}'],
    ['{{#if 1}}', '{{/if}}'],
    ['{{#if 0}}', '{{/if}}'],
    ['{{#pure}}', '{{/pure}}'],
    ['{{#puredisplay}}', '{{/puredisplay}}'],
    ['{{#escape}}', '{{/escape}}'],
    ['{{#code}}', '{{/code}}'],
  ] as const;
  const sequence = (depth: number): string => {
    let out = '';
    const count = 1 + Math.floor(next() * 3);
    for (let i = 0; i < count; i++) {
      const roll = next();
      if (roll < 0.3 || depth > 3) {
        out += noisy ? pick(['a', ' ', '\n', ':', '::', '{', '}', '#', '/', 'b c']) : 'w';
      } else if (roll < 0.65) {
        out += `{{f${counter++}`;
        if (next() < 0.6) out += `::${sequence(depth + 1)}`;
        out += maybeDrop('}}');
      } else {
        const [open, close] = pick([...openers]);
        const when = open.startsWith('{{#when');
        out += maybeDrop(open) + sequence(depth + 1);
        if (when && next() < 0.4) out += `{{:else}}${sequence(depth + 1)}`;
        out += maybeDrop(close);
      }
    }
    return out;
  };
  return { text: sequence(0), dropped };
}

describe('agreement with the vendored parser', () => {
  test('evaluated calls are the names the native evaluator reports, in closing order', () => {
    const next = random(20261125);
    let compared = 0;
    for (let round = 0; round < 1500; round++) {
      const { text } = generateSnippet(next, true);
      const analysis = analyzeCbs(text);
      const evaluated = analysis.calls.filter(
        (call) =>
          call.context === 'evaluated' &&
          call.close &&
          (call.kind === 'call' || (call.kind === 'block-close' && call.block === null))
      );
      const dats = evaluated.map((call) => text.slice(call.open.to, call.close!.from));
      if (dats.some((dat) => /\{[{#]/.test(dat.split(':')[0]!))) continue;
      const expected = [
        ...new Set(
          evaluated
            .map((call, index) => ({ at: call.to, name: matcherName(dats[index]!) }))
            .sort((a, b) => a.at - b.at)
            .map((item) => item.name)
        ),
      ];
      const cbs = createNativeRisuCbs({ native, variables: {} });
      cbs.parse(text);
      expect(cbs.issues, JSON.stringify(text)).toEqual(expected);
      compared++;
    }
    expect(compared).toBeGreaterThan(1200);
  });

  test('a fixed corpus agrees on which calls the evaluator reaches', () => {
    const corpus = [
      '{{a1}}{{#pure}}{{a2}}{{/pure}}{{a3}}',
      '{{#if 0}}{{b1}}{{/if}}{{#if 1}}{{b2}}{{/if}}',
      '{{c1::{{c2}}::{{#when 1}}{{c3}}{{/when}}}}',
      '{{#pure}}{{#x}}{{/pure}}{{d1}}',
      '{{e1}}}{{{e2}}}{e3}}',
      '{{f1#}}{{f2}}',
      '{{/stray}}{{g1}}',
    ];
    for (const text of corpus) {
      const analysis = analyzeCbs(text);
      const reached = analysis.calls
        .filter(
          (call) =>
            call.context === 'evaluated' &&
            call.close &&
            (call.kind === 'call' || (call.kind === 'block-close' && call.block === null))
        )
        .sort((a, b) => a.to - b.to)
        .map((call) => call.normalizedName);
      const cbs = createNativeRisuCbs({ native, variables: {} });
      cbs.parse(text);
      expect(cbs.issues, text).toEqual(reached);
    }
  });

  test('#when references are the variables the evaluator reads', () => {
    const recorder = () => {
      const reads = new Set<string>();
      const target = new Proxy({} as Record<string, string>, {
        getOwnPropertyDescriptor: (_target, key) => {
          if (typeof key === 'string') reads.add(key);
          return undefined;
        },
      });
      return { reads, target };
    };
    const evaluatorReads = (text: string) => {
      const chat = recorder();
      const global = recorder();
      createNativeRisuCbs({
        native,
        variables: chat.target,
        globalVariables: global.target,
      }).parse(text);
      return [...chat.reads, ...global.reads].sort();
    };
    const analysisReads = (text: string) =>
      analyzeCbs(text)
        .references.filter((ref) => !ref.dynamic)
        .map((ref) => ref.name)
        .sort();
    const exact = [
      '{{#when::toggle::rain}}a{{/when}}',
      '{{#when::mood::vis::calm}}a{{/when}}',
      '{{#when::{{getvar::kind}}::is::toggle::and::var::flag}}a{{/when}}',
      '{{#when::not::var::ready}}a{{/when}}',
      '{{#when::var::is::var}}a{{/when}}',
      '{{#when::season::tis::on::or::hp::visnot::0}}a{{/when}}',
      '{{#when::keep::toggle::rain}}a{{/when}}',
      '{{#when::level::>::3::and::toggle::hard}}a{{/when}}',
      '{{#when::toggle::is::vis}}a{{/when}}',
      '{{#when::legacy::var::seen}}a{{/when}}',
    ];
    for (const text of exact) expect(analysisReads(text), text).toEqual(evaluatorReads(text));
    expect(analysisReads('{{#when::toggle::is::vis}}a{{/when}}')).toEqual([]);
    const ambiguous = '{{#when::var::{{getvar::op}}::name}}a{{/when}}';
    expect(analysisReads(ambiguous)).toEqual(['op']);
    expect(evaluatorReads(ambiguous)).toContain('op');
  });

  test('block pairing is balanced exactly when the generator closed everything', () => {
    const next = random(7);
    for (let round = 0; round < 1500; round++) {
      const { text, dropped } = generateSnippet(next, false);
      const structural = analyzeCbs(text).diagnostics.filter(
        (item) => item.code !== 'cbs.else-outside-when'
      );
      expect(structural.length > 0, JSON.stringify(text)).toBe(dropped);
    }
  });
});

describe('function catalog', () => {
  const apps: { app: App; directory: string }[] = [];
  afterEach(async () => {
    for (const item of apps.splice(0)) {
      await item.app.close();
      await rm(item.directory, { recursive: true, force: true });
    }
  });

  test('comes from the vendored registry with aliases and flags', () => {
    const byName = new Map(catalog.functions.map((entry) => [entry.name, entry]));
    expect(byName.get('getvar')?.description).toContain('{{getvar::variableName}}');
    expect(byName.get('previouscharchat')?.aliases).toEqual(['lastcharmessage']);
    expect(byName.get('img')?.documentationOnly).toBe(true);
    expect(byName.get('__')?.internal).toBe(true);
    expect(byName.get('#if')?.deprecated?.replacement).toBe('#when');
    expect(catalog.functions.filter((entry) => entry.name === 'time')).toHaveLength(1);
  });

  test('is served behind the API session', async () => {
    for (const accessToken of [undefined, 'synthetic-token-for-catalog']) {
      const directory = await mkdtemp(join(tmpdir(), 'uimori-cbs-catalog-'));
      const app = await createApp({
        dbPath: join(directory, 'app.sqlite'),
        buildId: 'cbs-catalog',
        accessToken,
      });
      apps.push({ app, directory });
      const response = await app.inject({ method: 'GET', url: '/api/risu/cbs-functions' });
      if (accessToken) expect(response.statusCode).toBe(401);
      else expect(response.json()).toEqual(JSON.parse(JSON.stringify(catalog)));
    }
  });
});
