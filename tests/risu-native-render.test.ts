import { createHash } from 'node:crypto';
import { splitSource } from '../core/auxiliary.js';
import { describe, expect, test } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RisuContentSource } from '../core/risu-native.js';
import { createNativeRisuCbsSession, evaluateNativeRisuFields } from '../server/risu-native-cbs.js';
import { processNativeRisuText, renderNativeRisuMessage } from '../server/risu-native-render.js';
import { cardZip } from '../server/character-card-file.js';
import { readEmbeddedRisuModule } from '../server/risu-module-file.js';

const native = (extra: Partial<RisuContentSource> = {}): RisuContentSource => ({
  version: 1,
  card: { name: 'Guide', first_mes: 'Choose', extensions: { risuai: {} } },
  assets: [],
  sourceHash: 'a'.repeat(64),
  ...extra,
});
test('viewport CBS aliases drive authored responsive CSS and remain unsupported without a browser', async () => {
  const input = native({
    card: {
      name: 'Guide',
      extensions: {
        risuai: {
          backgroundHTML:
            '<style>.panel { {{#if {{? {{screen_width}} > 768 }} }}width:33%;right:-33%;{{/if}}{{#if {{? {{screen_width}} <= 768 }} }}width:100%;right:-100%;{{/if}} }</style>',
        },
      },
    },
  });
  const text = '{{screenwidth}}|{{screen_width}}|{{screenheight}}|{{screen_height}}';
  for (const [viewport, expected, closed] of [
    [{ width: 1845, height: 1194 }, '1845|1845|1194|1194', 'right:-33%'],
    [{ width: 412, height: 915 }, '412|412|915|915', 'right:-100%'],
  ] as const) {
    const result = await renderNativeRisuMessage({
      native: input,
      text,
      context: { variables: {}, viewport, displaying: true },
    });
    expect(result.html).toContain(expected);
    expect(result.html).toContain(closed);
    expect(result.issues).toEqual([]);
  }
  const withoutBrowser = await renderNativeRisuMessage({
    native: input,
    text,
    context: { variables: {} },
  });
  expect(withoutBrowser.issues).toEqual(['screenwidth', 'screenheight']);
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
test('explicit preset field roles override the indexed conversation role', async () => {
  const result = await evaluateNativeRisuFields({
    native: native(),
    fields: { system: '{{role}}', user: '{{role}}', assistant: '{{role}}' },
    fieldRoles: { system: 'system', user: 'user', assistant: 'assistant' },
    context: {
      variables: {},
      messageIndex: 0,
      messages: [
        { role: 'user', data: 'Earlier request' },
        { role: 'char', data: 'Later scene' },
      ],
    },
  });
  expect(result.fields).toEqual({ system: 'system', user: 'user', assistant: 'char' });
});

test('CBS sessions propagate variable writes while each call uses its latest context', async () => {
  const session = createNativeRisuCbsSession();
  const context = {
    native: native(),
    variables: {} as Record<string, string>,
    globalVariables: { route: 'first' },
    now: 1000,
    charName: 'First',
  };
  const expression = '{{getvar::score}}|{{getglobalvar::route}}|{{unixtime}}|{{char}}';
  try {
    expect(await session.evaluate('{{setvar::score::3}}' + expression, context)).toBe(
      '3|first|1|First'
    );
    context.globalVariables.route = 'next';
    context.now = 2000;
    context.charName = 'Next';
    expect(await session.evaluate(expression, context)).toBe('3|next|2|Next');
    expect(await session.evaluate(expression, { ...context, variables: {} })).toBe(
      'null|next|2|Next'
    );
    expect(context.variables).toEqual({ score: '3' });
  } finally {
    await session.close();
  }
});
test('overlapping CBS calls do not terminate the active evaluation', async () => {
  const session = createNativeRisuCbsSession();
  const context = { native: native(), variables: {} };
  try {
    const first = session.evaluate('{{char}}', context);
    await expect(session.evaluate('{{user}}', context)).rejects.toThrow('RISU_NATIVE_WORKER_BUSY');
    expect(await first).toBe('Guide');
    expect(await session.evaluate('{{char}}', context)).toBe('Guide');
  } finally {
    await session.close();
  }
});
test.each(['closed', 'cancelled'] as const)(
  'a failed CBS evaluation cannot restart after its owner is %s',
  async (state) => {
    const controller = new AbortController();
    const session = createNativeRisuCbsSession(controller.signal);
    const context = { native: native(), variables: {} };
    try {
      await expect(session.evaluate('{{cbr::40000000}}x', context)).rejects.toThrow(
        'RISU_CBS_OUTPUT_LIMIT'
      );
      if (state === 'closed') await session.close();
      else controller.abort();
      await expect(session.evaluate('{{char}}', context)).rejects.toThrow(
        state === 'closed' ? 'RISU_NATIVE_WORKER_CLOSED' : 'CANCELLED'
      );
    } finally {
      await session.close();
    }
  }
);
test.each([
  ['editinput', 1, 'user'],
  ['editoutput', 1, 'char'],
  ['editprocess', 0, 'char'],
  ['editprocess', 1, 'user'],
  ['editdisplay', 0, 'char'],
  ['editprocess', -1, 'char'],
] as const)(
  '%s evaluates initial text and regex CBS with message %i role %s',
  async (mode, messageIndex, expectedRole) => {
    const input = native({
      module: {
        regex: [
          {
            type: mode,
            in: 'MARKER_{{role}}',
            out: 'AFTER_{{role}}',
            ableFlag: true,
            flag: 'g<cbs>',
          },
        ],
      },
    });
    const result = await processNativeRisuText({
      native: input,
      mode,
      text:
        '{{#if {{equal::{{role}}::' + expectedRole + '}}}}INITIAL{{/if}}|MARKER_' + expectedRole,
      context: {
        variables: {},
        messageIndex,
        messages:
          mode === 'editinput'
            ? [{ role: 'char', data: 'Previous scene' }]
            : [
                { role: 'char', data: 'Previous scene' },
                { role: 'user', data: 'Current input' },
              ],
      },
    });
    expect(result.text).toBe(`INITIAL|AFTER_${expectedRole}`);
    expect(result.issues).toEqual([]);
  }
);

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

test.each(['\n', '\r\n'])(
  'Markdown block boundaries survive styles, rules, lists and tables (%j)',
  async (newline) => {
    const text = [
      '**Mira** opened the window.',
      '---',
      '# Lanterns',
      '> A quiet voice.',
      '- One\n- Two',
      '| A | B |\n| - | - |\n| 1 | 2 |',
      '```txt\nA\n\nB\n```',
      '<style>p { letter-spacing: .01em; }</style>',
      'Yuna took her hand. 🌙',
    ]
      .join('\n\n')
      .replaceAll('\n', newline);
    const source = {
      id: 'scene',
      chatId: 'chat',
      text,
      hash: createHash('sha256').update(text).digest('hex'),
    };
    const blocks = splitSource(source);
    const input = {
      native: native({
        card: {
          name: 'Guide',
          extensions: { risuai: { backgroundHTML: '<style>p { font-family: serif; }</style>' } },
        },
      }),
      text,
      context: { variables: {}, userName: 'Reader' },
    };
    const before = await renderNativeRisuMessage(input);
    const result = await renderNativeRisuMessage({ ...input, illustrationBlocks: blocks });
    expect(
      [...result.html.matchAll(/data-uimori-illustration-after="([^"]+)"/g)].map(
        (match) => match[1]
      )
    ).toEqual(
      blocks.filter((block) => !block.text.startsWith('<style>')).map((block) => block.anchor)
    );
    expect(result.html.replace(/ data-uimori-illustration-after="[^"]+"/g, '')).toBe(before.html);
    expect(result.html).toContain('<style>p { font-family: serif; }</style>');
  }
);

test('a native text rewrite does not claim stale canonical positions', async () => {
  const text = '{{char}} opened the window.';
  const source = {
    id: 'scene',
    chatId: 'chat',
    text,
    hash: createHash('sha256').update(text).digest('hex'),
  };
  const rendered = await renderNativeRisuMessage({
    native: native(),
    text,
    context: { variables: {} },
    illustrationBlocks: splitSource(source),
  });
  expect(rendered.html).not.toContain('data-uimori-illustration-after');
});
