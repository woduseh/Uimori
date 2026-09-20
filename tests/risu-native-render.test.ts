import { describe, expect, test } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RisuContentSource } from '../core/risu-native.js';
import { evaluateNativeRisuFields, evaluateRisuNativeCbs } from '../server/risu-native-cbs.js';
import { renderNativeRisuMessage } from '../server/risu-native-render.js';
import { cardZip } from '../server/character-card-file.js';
import { readEmbeddedRisuModule } from '../server/risu-module-file.js';

const native = (extra: Partial<RisuContentSource> = {}): RisuContentSource => ({
  version: 1,
  card: { name: 'Guide', first_mes: 'Choose', extensions: { risuai: {} } },
  assets: [],
  sourceHash: 'a'.repeat(64),
  ...extra,
});
test('native CBS preserves shared variable writes across fields and native button/condition markup', async () => {
  const input = native();
  const result = await evaluateNativeRisuFields({
    native: input,
    fields: {
      one: '{{setvar::route::2}}{{char}}',
      two: '{{#if {{equal::{{getvar::route}}::2}}}}{{button::Enter::go}}{{/if}}',
    },
    context: { variables: {}, userName: 'Reader' },
  });
  expect(result.fields.one).toBe('Guide');
  expect(result.fields.two).toContain('risu-trigger="go"');
  expect(result.variables.route).toBe('2');
});
test('runtime CBS evaluates in a worker and returns variable changes to the caller', async () => {
  const context = { native: native(), variables: {} as Record<string, string> };
  expect(await evaluateRisuNativeCbs('{{setvar::score::3}}{{? 2+3}}', context)).toBe('5');
  expect(context.variables.score).toBe('3');
});
test('native display follows CBS/regex/assets and keeps HTML CSS without mutating durable vars', async () => {
  const input = native({
    assets: [{ name: 'room', uri: 'embeded://room.png', imageId: 'room' }],
    module: {
      regex: [
        {
          in: '<selector>',
          out: '<style>.card {background:url({{raw::room}})}</style><div class="card">{{button::Go::enter}}</div>',
          type: 'editdisplay',
        },
      ],
    },
  });
  const variables = {};
  const result = await renderNativeRisuMessage({
    native: input,
    text: '{{setvar::local::1}}<selector>\n\n**Hello**',
    context: { variables, assetUrls: { room: '/api/package-image-blobs/abc' } },
  });
  expect(result.html).toContain('risu-trigger="enter"');
  expect(result.html).toContain('<style>');
  expect(result.html).toContain('/api/package-image-blobs/abc');
  expect(result.html).toContain('<strong>Hello</strong>');
  expect(variables).toEqual({});
});

test.each([
  ['scene_annyoed.webp', ['scene_annoyed.webp'], 0],
  [' SCENE - ANNOYED.PNG ', ['scene_annoyed.webp'], 0],
  ['portrait-1.webp', ['portrait_1.png', 'portrait-1.webp'], 1],
  ['portrait-3.webp', ['portrait_1.png', 'portrait_2.png'], 0],
  ['portrait-3.webp', ['portrait_2.png', 'portrait_1.png'], 0],
  ['abWXYZ.webp', ['abcdef.png'], 0],
  ['aVWXYZ.webp', ['abcdef.png'], -1],
  ['abc.webp', ['abcdefg.png'], 0],
  ['abcdefg.webp', ['abc.png'], 0],
] as const)(
  'native asset resolution matches Risu exact-first and bounded distance: %s / %j',
  async (query, names, selected) => {
    const input = native({
      assets: names.map((name, index) => ({
        name,
        uri: `embeded://${index}.png`,
        imageId: `${index}`,
      })),
    });
    const result = await renderNativeRisuMessage({
      native: input,
      text: `{{img::${query}}}`,
      context: {
        variables: {},
        assetUrls: Object.fromEntries(
          names.map((name, index) => [name, `/api/package-image-blobs/asset-${index}`])
        ),
      },
    });
    if (selected < 0) {
      expect(result.html).not.toContain('<img');
      expect(result.issues).toContain(`asset:${query.trim()}`);
    } else {
      expect(result.html).toContain(`src="/api/package-image-blobs/asset-${selected}"`);
      expect(result.issues).toEqual([]);
    }
  }
);

test('native asset fallback admits only imported assets with local URLs', async () => {
  const input = native({
    assets: [{ name: 'portrait.png', uri: 'embeded://portrait.png', imageId: 'portrait' }],
  });
  for (const url of [
    'https://example.test/portrait.png',
    'data:image/png;base64,AAAA',
    '/api/package-image-blobs/x?redirect=1',
  ]) {
    const result = await renderNativeRisuMessage({
      native: input,
      text: '{{img::portriat.png}}{{img::unlisted.png}}',
      context: {
        variables: {},
        assetUrls: { 'portrait.png': url, 'unlisted.png': '/api/package-image-blobs/unlisted' },
      },
    });
    expect(result.html).not.toContain('<img');
    expect(result.issues).toEqual(['asset:portriat.png', 'asset:unlisted.png']);
  }
});

test('native regex rule count is not limited to the legacy 32-rule conversion', async () => {
  const input = native({
    module: {
      regex: Array.from({ length: 40 }, (_, index) => ({
        in: `step${index}(?![0-9])`,
        out: `step${index + 1}`,
        type: 'editdisplay',
      })),
    },
  });
  expect(
    (await renderNativeRisuMessage({ native: input, text: 'step0', context: { variables: {} } }))
      .html
  ).toContain('step40');
});

test('indented native selector HTML stays interactive while explicit Markdown fences stay code', async () => {
  const result = await renderNativeRisuMessage({
    native: native(),
    text: '    <div class="selector">\n        <button risu-trigger="choose">Choose</button>\n    </div>\n\n```html\n<button risu-trigger="example">Example</button>\n```',
    context: { variables: {} },
  });
  expect(result.html).toContain('<button risu-trigger="choose">Choose</button>');
  expect(result.html).not.toContain('risu-trigger=&quot;choose&quot;');
  expect(result.html).toContain(
    '<pre><code class="language-html">&lt;button risu-trigger=&quot;example&quot;'
  );
});
test('catastrophic native regex is terminated without blocking the host', async () => {
  const input = native({ module: { regex: [{ in: '^(a+)+$', out: 'x', type: 'editdisplay' }] } });
  let hostTick = false;
  const timer = setTimeout(() => {
    hostTick = true;
  }, 30);
  await expect(
    renderNativeRisuMessage({
      native: input,
      text: `${'a'.repeat(100_000)}!`,
      context: { variables: {} },
      timeoutMs: 300,
    })
  ).rejects.toThrow('RISU_NATIVE_TIMEOUT');
  clearTimeout(timer);
  expect(hostTick).toBe(true);
});

const sampleRoot = process.env.UIMORI_NATIVE_CARD_ROOT;
const cases = [
  ['Cheongwon High School', 'Reference/Cheongwon High School.charx'],
  ['Harper', 'Reference/Harper.charx'],
  ['Fujimiya Hinano', 'Fujimiya Hinano/Fujimiya Hinano_v2.4.3-test.charx'],
] as const;
describe('local native CHARX display evidence (optional private fixtures)', () => {
  for (const [title, path] of cases)
    test.skipIf(!sampleRoot || !existsSync(join(sampleRoot, path)))(title, async () => {
      const zip = cardZip(readFileSync(join(sampleRoot!, path)));
      const document = JSON.parse(zip.get('card.json')!().toString('utf8'));
      const card = document.data ?? document;
      const module = zip.has('module.risum')
        ? readEmbeddedRisuModule(zip.get('module.risum')!()).module
        : undefined;
      const input = native({ card, module });
      const result = await renderNativeRisuMessage({
        native: input,
        text: card.first_mes,
        context: { variables: {}, userName: 'Reader' },
        timeoutMs: 10000,
      });
      expect(result.html.length).toBeGreaterThan(200);
      expect(result.html).toMatch(/<[^>]+\srisu-(?:trigger|btn)=["'][^"']+["']/u);
      expect(result.html).not.toContain('<hinano-selector>');
      expect(result.issues.filter((issue) => issue.startsWith('regex:'))).toEqual([]);
    });
});
