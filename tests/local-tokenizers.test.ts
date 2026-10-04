import { afterEach, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import type { TokenizerProfileId } from '../core/tokenizer-profiles.js';

vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});
const require = createRequire(import.meta.url);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(readFileSync).mockClear();
  vi.resetModules();
});

test('importing counters does not load a vocabulary or tokenizer runtime', async () => {
  const files = [require.resolve('tiktoken/lite'), require.resolve('@huggingface/tokenizers')];
  for (const file of files) expect(require.cache[file]).toBeUndefined();
  await import('../core/text-tokens.js');
  for (const file of files) expect(require.cache[file]).toBeUndefined();
  expect(
    vi
      .mocked(readFileSync)
      .mock.calls.filter(([path]) => String(path).includes('third_party/tokenizers'))
  ).toEqual([]);
});

test('only used families load, reuse hot counters and evict older vocabularies without network', async () => {
  const fetch = vi.fn(() => {
    throw new Error('Token counting must stay offline');
  });
  vi.stubGlobal('fetch', fetch);
  const { countTextTokens, tokenizerInfo } = await import('../core/text-tokens.js');
  const loads = () =>
    vi
      .mocked(readFileSync)
      .mock.calls.map(([path]) => String(path))
      .filter(
        (path) => path.includes('third_party/tokenizers') && path.endsWith('tokenizer.json.gz')
      );
  const text = '항구의 밤은 고요했다. The lights went out. 日本語も混ざる。';
  const first = countTextTokens(text, 'deepseek-v4');
  expect(first).toBeGreaterThan(0);
  expect(tokenizerInfo('deepseek-v4').fallback).toBe(false);
  expect(countTextTokens(text, 'deepseek-v4')).toBe(first);
  expect(loads()).toHaveLength(1);
  for (const profile of ['deepseek-v3', 'glm-5', 'gemini-gemma4'] as const) {
    expect(countTextTokens(text, profile)).toBeGreaterThan(0);
    expect(tokenizerInfo(profile).fallback).toBe(false);
  }
  expect(loads()).toHaveLength(4);
  expect(countTextTokens(text, 'deepseek-v4')).toBe(first);
  expect(loads()).toHaveLength(5);
  expect(fetch).not.toHaveBeenCalled();
});

test('an unavailable family falls back once, reports the change, and never fetches a replacement', async () => {
  const original = await vi.importActual<typeof import('node:fs')>('node:fs');
  const fetch = vi.fn(() => {
    throw new Error('No remote tokenizer fallback');
  });
  vi.stubGlobal('fetch', fetch);
  vi.mocked(readFileSync).mockImplementation((...args: Parameters<typeof readFileSync>) => {
    if (String(args[0]).includes('/glm-5/')) throw new Error('Synthetic missing vocabulary');
    return original.readFileSync(...args);
  });
  try {
    const { countTextTokens, tokenizerInfo } = await import('../core/text-tokens.js');
    const text = '새 토크나이저를 사용할 수 없어도 글쓰기는 계속된다.';
    const generic = countTextTokens(text, 'generic');
    expect(countTextTokens(text, 'glm-5')).toBe(generic);
    expect(countTextTokens(text, 'glm-5')).toBe(generic);
    expect(tokenizerInfo('glm-5')).toMatchObject({
      requested: 'glm-5',
      effective: 'generic',
      fallback: true,
    });
    expect(
      vi.mocked(readFileSync).mock.calls.filter(([path]) => String(path).includes('/glm-5/'))
    ).toHaveLength(1);
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    vi.mocked(readFileSync).mockImplementation(original.readFileSync);
  }
});

const bundled: TokenizerProfileId[] = [
  'gemini-gemma3',
  'gemini-gemma4',
  'deepseek-v3',
  'deepseek-v4',
  'deepseek-v4.1',
  'glm-4.7',
  'glm-5',
  'kimi-k2',
  'claude-legacy',
];
test.each(bundled)(
  '%s matches independent reference counts and bundled asset hashes',
  async (profile) => {
    const { countTextTokens, tokenizerInfo } = await import('../core/text-tokens.js');
    const root = new URL(`../third_party/tokenizers/${profile}/`, import.meta.url);
    const reference = JSON.parse(
      readFileSync(
        new URL(profile.startsWith('gemini-') ? 'reference-vectors.json' : 'PARITY.json', root),
        'utf8'
      )
    ) as {
      vectors?: { text: string; count: number }[];
      cases?: { text: string; count: number }[];
    };
    const vectors = reference.vectors ?? reference.cases!;
    expect(vectors.length).toBeGreaterThan(5);
    for (const vector of vectors) {
      expect(vector.text.length).toBeLessThanOrEqual(4096);
      expect(countTextTokens(vector.text, profile), vector.text).toBe(vector.count);
    }
    expect(tokenizerInfo(profile).fallback).toBe(false);
    const source = JSON.parse(readFileSync(new URL('SOURCE.json', root), 'utf8')) as {
      assets: { file?: string; filename?: string; sha256: string; uncompressedSha256?: string }[];
    };
    for (const item of source.assets) {
      const name = item.file ?? item.filename!;
      const data = readFileSync(new URL(name, root));
      expect(createHash('sha256').update(data).digest('hex'), name).toBe(item.sha256);
      if (item.uncompressedSha256)
        expect(createHash('sha256').update(gunzipSync(data)).digest('hex'), name).toBe(
          item.uncompressedSha256
        );
    }
  }
);
