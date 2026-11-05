import { createHash } from 'node:crypto';
import { redactDiagnosticJson } from '../core/provider-diagnostic-json.js';
import type { Json } from '../core/transport.js';

const ARGUMENT_PREVIEW_CHARS = 1024;
const PREVIEW_TRUNCATION = '\n... [arguments truncated] ...\n';

/** Diagnostic text is bounded and never changes the arguments sent to a tool. */
export function helperArgumentDiagnostic(args: Json) {
  let original: string;
  try {
    original = JSON.stringify(args);
  } catch {
    return {
      argsPreview: '[argument preview unavailable]',
      argsChars: null,
      argsSha256: null,
      argsTruncated: true,
      argsRedacted: true,
    };
  }
  const identity = {
    argsChars: original.length,
    argsSha256: createHash('sha256').update(original).digest('hex'),
  };
  const redactText = (value: Json): Json => {
    if (typeof value === 'string')
      return value
        .replace(/\b(Bearer|Basic)\s+[^\s"'<>]+/giu, '$1 [REDACTED]')
        .replace(
          /\b(api[_-]?key|access[_-]?token|authorization|password|secret)(\s*[:=]\s*|\s+)(["']?)[^\s"';&]+\3/giu,
          '$1$2$3[REDACTED]$3'
        )
        .replace(/data:[^\s"'<>]*;base64,[A-Za-z0-9+/=]+/giu, '[attachment payload withheld]')
        .replace(/[A-Za-z0-9+/]{96,}={0,2}/gu, '[encoded payload withheld]');
    if (Array.isArray(value)) return value.map(redactText);
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          /^(base64|file_data)$/iu.test(key) ? '[attachment payload withheld]' : redactText(item),
        ])
      );
    return value;
  };
  let safe: string;
  try {
    safe = JSON.stringify(redactText(redactDiagnosticJson(args)));
  } catch {
    // A deeply nested valid argument must not fail its tool solely in diagnostics.
    return {
      ...identity,
      argsPreview: '[argument preview unavailable]',
      argsTruncated: true,
      argsRedacted: true,
    };
  }
  let preview = safe;
  if (safe.length > ARGUMENT_PREVIEW_CHARS) {
    let headEnd = 768;
    if (/[\uD800-\uDBFF]/u.test(safe[headEnd - 1]!)) headEnd--;
    let tailStart = safe.length - (ARGUMENT_PREVIEW_CHARS - PREVIEW_TRUNCATION.length - headEnd);
    if (/[\uDC00-\uDFFF]/u.test(safe[tailStart]!)) tailStart++;
    preview = safe.slice(0, headEnd) + PREVIEW_TRUNCATION + safe.slice(tailStart);
  }
  return {
    argsPreview: preview,
    ...identity,
    argsTruncated: original.length > ARGUMENT_PREVIEW_CHARS || safe.length > ARGUMENT_PREVIEW_CHARS,
    argsRedacted: safe !== original,
  };
}

/** Keep outcome metadata, never result text or arbitrary error messages. */
export function helperResultDiagnostic(name: string, output: unknown) {
  const value =
    output && typeof output === 'object' && !Array.isArray(output)
      ? (output as Record<string, unknown>)
      : {};
  const error =
    value.error && typeof value.error === 'object' && !Array.isArray(value.error)
      ? (value.error as Record<string, unknown>).code
      : value.error;
  const code = typeof value.code === 'string' ? value.code : error;
  const errorCode =
    typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,95}$/u.test(code) ? code : undefined;
  if (name !== 'data.exec') return { ...(errorCode ? { errorCode } : {}) };
  const shell = {
    ...(value.exitCode === null || Number.isSafeInteger(value.exitCode)
      ? { exitCode: value.exitCode }
      : {}),
    ...(value.signal === null ||
    (typeof value.signal === 'string' && /^SIG[A-Z0-9]{1,16}$/u.test(value.signal))
      ? { signal: value.signal }
      : {}),
    ...(typeof value.timedOut === 'boolean' ? { timedOut: value.timedOut } : {}),
    ...(Number.isSafeInteger(value.outputBytes) && Number(value.outputBytes) >= 0
      ? { outputBytes: value.outputBytes }
      : {}),
    ...(typeof value.truncated === 'boolean' ? { truncated: value.truncated } : {}),
  };
  return {
    ...(errorCode ? { errorCode } : {}),
    ...(Object.keys(shell).length ? { shell } : {}),
  };
}
