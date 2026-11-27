import { basename } from 'node:path';

export function failureLabel(error: unknown): string {
  if (!(error instanceof Error)) return 'NON_ERROR';
  if (/^[A-Z][A-Z0-9_]{2,100}$/u.test(error.message)) return error.message;
  const code = (error as { code?: unknown }).code;
  const named =
    typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,80}$/u.test(code)
      ? `${error.name}(${code})`
      : error.name;
  const frame = /\(([^()]+):(\d+):\d+\)/u.exec(error.stack ?? '');
  return frame ? `${named} at ${basename(frame[1])}:${frame[2]}` : named;
}
