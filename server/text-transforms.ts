import { Worker } from 'node:worker_threads';
import {
  TextTransformError,
  validateTextTransformRule,
  type TextTransformRule,
  type TextTransformResult,
} from '../core/text-transform.js';
// One bounded worker for the entire batch. Authored patterns/replacements are data, never code.
const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const maximum = workerData.maxOutputChars;
const fail = (code, id) => { throw Object.assign(new Error(code), { code, id }); };
try {
  const results = []; let total = 0;
  for (const input of workerData.inputs) {
  let text = input.text;
  const applied = [];
  for (const rule of input.rules) {
    let regex;
    try { regex = new RegExp(rule.pattern, rule.flags); } catch { fail('TEXT_REGEX_INVALID', rule.id); }
    const original = text, pieces = []; let size = 0, cursor = 0, matched = false;
    const append = value => { size += value.length; if (size > maximum) fail('TEXT_TRANSFORM_OUTPUT_LIMIT', rule.id); pieces.push(value); };
    let match;
    while ((match = regex.exec(original)) !== null) {
      matched = true;
      append(original.slice(cursor, match.index));
      // ECMAScript replacement tokens, without evaluating JavaScript from package data.
      const replacement = rule.replacement.replace(/\$(\$|&|'|\x60|<[^>]*>|[0-9]{1,2})/g, (token, key) => {
        if (key === '$') return '$';
        if (key === '&') return match[0];
        if (key === '\x60') return original.slice(0, match.index);
        if (key === "'") return original.slice(match.index + match[0].length);
        if (key[0] === '<') return match.groups ? match.groups[key.slice(1, -1)] ?? '' : token;
        const n = Number(key);
        if (n > 0 && n < match.length) return match[n] ?? '';
        if (key.length === 2 && Number(key[0]) > 0 && Number(key[0]) < match.length) return (match[Number(key[0])] ?? '') + key[1];
        return token;
      });
      append(replacement); cursor = match.index + match[0].length;
      if (!regex.global) break;
      if (!match[0].length) {
        const position = regex.lastIndex;
        regex.lastIndex += regex.unicode && original.codePointAt(position) > 65535 ? 2 : 1;
      }
    }
    append(original.slice(cursor)); text = pieces.join(''); if (matched) applied.push(rule.id);
  }
  total += text.length; if (total > maximum) fail('TEXT_TRANSFORM_OUTPUT_LIMIT');
  results.push({ text, applied, changed: text !== input.text });
  }
  parentPort.postMessage({ ok: true, results });
} catch (error) { parentPort.postMessage({ ok: false, code: error.code || 'TEXT_TRANSFORM_FAILED', id: error.id }); }
`;
export async function applyTextTransformBatch(
  inputs: readonly { text: string; rules: readonly TextTransformRule[] }[],
  options: { timeoutMs?: number; maxOutputChars?: number } = {}
): Promise<TextTransformResult[]> {
  if (
    !Array.isArray(inputs) ||
    inputs.length > 2000 ||
    inputs.some((input) => typeof input.text !== 'string' || input.text.length > 1_000_000) ||
    inputs.reduce((size, input) => size + input.text.length, 0) > 2_000_000
  )
    throw new TextTransformError('TEXT_TRANSFORM_INPUT_LIMIT');
  if (inputs.some((input) => !Array.isArray(input.rules) || input.rules.length > 32))
    throw new TextTransformError('TEXT_TRANSFORM_RULE_LIMIT');
  const selected = inputs.map((input) => ({
    text: input.text,
    rules: input.rules.map(validateTextTransformRule),
  }));
  if (!selected.some((input) => input.rules.length))
    return inputs.map(({ text }) => ({ text, applied: [], changed: false }));
  const maxOutputChars = options.maxOutputChars ?? 2_000_000;
  if (!Number.isSafeInteger(maxOutputChars) || maxOutputChars < 1 || maxOutputChars > 2_000_000)
    throw new TextTransformError('TEXT_TRANSFORM_OUTPUT_LIMIT');
  const timeoutMs = options.timeoutMs ?? 1000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 10_000)
    throw new TextTransformError('TEXT_TRANSFORM_TIMEOUT_LIMIT');
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { inputs: selected, maxOutputChars },
      resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 2 },
    });
    let settled = false;
    const finish = (error?: TextTransformError, result?: TextTransformResult[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate().then(
        () => (error ? reject(error) : resolve(result!)),
        () => reject(error ?? new TextTransformError('TEXT_TRANSFORM_WORKER_FAILED'))
      );
    };
    const timer = setTimeout(
      () => finish(new TextTransformError('TEXT_TRANSFORM_TIMEOUT')),
      timeoutMs
    );
    worker.once('message', (message) =>
      message.ok
        ? finish(undefined, message.results)
        : finish(new TextTransformError(message.code, message.id))
    );
    worker.once('error', () => finish(new TextTransformError('TEXT_TRANSFORM_WORKER_FAILED')));
    worker.once('exit', () => {
      if (!settled) finish(new TextTransformError('TEXT_TRANSFORM_WORKER_EXIT'));
    });
  });
}
export async function applyTextTransforms(
  text: string,
  rules: readonly TextTransformRule[],
  options: { timeoutMs?: number; maxOutputChars?: number } = {}
) {
  return (await applyTextTransformBatch([{ text, rules }], options))[0]!;
}
