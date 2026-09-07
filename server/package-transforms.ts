import { Worker } from 'node:worker_threads';
import {
  ContentPackageError,
  validatePackageTransform,
  type PackageTransform,
} from '../core/content-package.js';

// Constant trusted worker code only. Patterns and replacements are data in workerData.
const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const maximum = 2000000;
const fail = (code, id) => { throw Object.assign(new Error(code), { code, id }); };
try {
  let text = workerData.text;
  const applied = [];
  for (const rule of workerData.rules) {
    let regex;
    try { regex = new RegExp(rule.pattern, rule.flags); } catch { fail('PACKAGE_REGEX_INVALID', rule.id); }
    const original = text, pieces = []; let size = 0, cursor = 0, matched = false;
    const append = value => { size += value.length; if (size > maximum) fail('PACKAGE_TRANSFORM_OUTPUT_LIMIT', rule.id); pieces.push(value); };
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
  parentPort.postMessage({ ok: true, text, applied, changed: text !== workerData.text });
} catch (error) { parentPort.postMessage({ ok: false, code: error.code || 'PACKAGE_TRANSFORM_FAILED', id: error.id }); }
`;
export type PackageTransformResult = { text: string; applied: string[]; changed: boolean };
/** Presentation-only result. Caller must never replace source text/hash with this projection. */
export async function applyPackageTransforms(
  text: string,
  rules: readonly PackageTransform[],
  target: 'source' | 'translation',
  options: { timeoutMs?: number } = {}
): Promise<PackageTransformResult> {
  if (typeof text !== 'string' || text.length > 1_000_000)
    throw new ContentPackageError('PACKAGE_TRANSFORM_INPUT_LIMIT');
  if (!Array.isArray(rules) || rules.length > 32)
    throw new ContentPackageError('PACKAGE_TRANSFORM_RULE_LIMIT');
  if (target !== 'source' && target !== 'translation')
    throw new ContentPackageError('PACKAGE_TRANSFORM_TARGET');
  const selected = rules.map(validatePackageTransform).filter((r) => r.target === target);
  if (!selected.length) return { text, applied: [], changed: false };
  const timeoutMs = options.timeoutMs ?? 1000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 10_000)
    throw new ContentPackageError('PACKAGE_TRANSFORM_TIMEOUT_LIMIT');
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { text, rules: selected },
      resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 2 },
    });
    let settled = false;
    const finish = (error?: ContentPackageError, result?: PackageTransformResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate().then(
        () => (error ? reject(error) : resolve(result!)),
        () => reject(error ?? new ContentPackageError('PACKAGE_TRANSFORM_WORKER_FAILED'))
      );
    };
    const timer = setTimeout(
      () => finish(new ContentPackageError('PACKAGE_TRANSFORM_TIMEOUT')),
      timeoutMs
    );
    worker.once('message', (message) =>
      message.ok
        ? finish(undefined, {
            text: message.text,
            applied: message.applied,
            changed: message.changed,
          })
        : finish(new ContentPackageError(message.code, message.id))
    );
    worker.once('error', () => finish(new ContentPackageError('PACKAGE_TRANSFORM_WORKER_FAILED')));
    worker.once('exit', () => {
      if (!settled) finish(new ContentPackageError('PACKAGE_TRANSFORM_WORKER_FAILED'));
    });
  });
}
