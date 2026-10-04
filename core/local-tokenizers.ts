import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import type { Tiktoken } from 'tiktoken/lite';
import type { Tokenizer } from '@huggingface/tokenizers';
import { TOKENIZER_PROFILES, type TokenizerProfileId } from './tokenizer-profiles.js';

const require = createRequire(import.meta.url);
type Counter = { count: (text: string) => number; dispose?: () => void };
type TiktokenData = { bpe_ranks: string; special_tokens: Record<string, number>; pat_str: string };
const counters = new Map<TokenizerProfileId, Counter>();
const unavailable = new Set<TokenizerProfileId>();
// A writer, helper and summarizer can share their hot counters without loading every vocabulary.
const MAX_LOADED_TOKENIZERS = 3;

function asset(profile: TokenizerProfileId, name: string): unknown {
  const source = new URL('../third_party/tokenizers/', import.meta.url);
  const root = existsSync(source)
    ? source
    : new URL('../../third_party/tokenizers/', import.meta.url);
  return JSON.parse(
    gunzipSync(readFileSync(new URL(`${profile}/${name}.gz`, root))).toString('utf8')
  );
}

function load(profile: TokenizerProfileId): Counter {
  if (['openai-o200k', 'openai-cl100k', 'kimi-k2', 'claude-legacy'].includes(profile)) {
    // Requiring the lite module here also defers WebAssembly compilation until first use.
    const { Tiktoken: Encoding } = require('tiktoken/lite') as typeof import('tiktoken/lite');
    const data = (
      profile === 'openai-o200k'
        ? require('tiktoken/encoders/o200k_base.json')
        : profile === 'openai-cl100k'
          ? require('tiktoken/encoders/cl100k_base.json')
          : asset(profile, 'tiktoken.json')
    ) as TiktokenData;
    const encoding: Tiktoken = new Encoding(data.bpe_ranks, data.special_tokens, data.pat_str);
    return {
      count: (text) =>
        profile === 'claude-legacy' || profile === 'kimi-k2'
          ? encoding.encode(profile === 'claude-legacy' ? text.normalize('NFKC') : text, 'all', [])
              .length
          : encoding.encode_ordinary(text).length,
      dispose: () => encoding.free(),
    };
  }
  const { Tokenizer: Encoding } =
    require('@huggingface/tokenizers') as typeof import('@huggingface/tokenizers');
  const encoding: Tokenizer = new Encoding(
    asset(profile, 'tokenizer.json'),
    asset(profile, 'tokenizer_config.json')
  );
  return { count: (text) => encoding.encode(text, { add_special_tokens: false }).ids.length };
}

function counter(profile: TokenizerProfileId): Counter | undefined {
  if (unavailable.has(profile)) return undefined;
  let selected = counters.get(profile);
  if (selected) counters.delete(profile);
  else {
    try {
      selected = load(profile);
    } catch {
      // A broken optional vocabulary cannot turn token counting into a network request.
      unavailable.add(profile);
      return undefined;
    }
  }
  counters.set(profile, selected);
  if (counters.size > MAX_LOADED_TOKENIZERS) {
    const oldest = counters.keys().next().value!;
    counters.get(oldest)?.dispose?.();
    counters.delete(oldest);
  }
  return selected;
}

export type TokenizerInfo = {
  requested: TokenizerProfileId;
  effective: TokenizerProfileId;
  kind: 'local' | 'approximate';
  fallback: boolean;
};

/** Returns a short-lived counter; callers must not retain it across loading another family. */
export function localTokenizer(profile: TokenizerProfileId): {
  count: Counter['count'];
  info: TokenizerInfo;
} {
  const family = profile === 'generic' || profile === 'grok-estimate' ? 'openai-o200k' : profile;
  const selected = counter(family);
  if (selected)
    return {
      count: selected.count,
      info: {
        requested: profile,
        effective: profile,
        kind: TOKENIZER_PROFILES.find((item) => item.id === profile)!.kind,
        fallback: false,
      },
    };
  const fallback = family === 'openai-o200k' ? undefined : counter('openai-o200k');
  return {
    count: fallback?.count ?? ((text) => Math.ceil(Buffer.byteLength(text, 'utf8') / 3)),
    info: { requested: profile, effective: 'generic', kind: 'approximate', fallback: true },
  };
}
