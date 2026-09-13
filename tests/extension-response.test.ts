import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { EXTENSION_PROGRAM_API, type ExtensionProgram } from '../core/extension-program.js';
import type { RuntimeValue } from '../core/prompt-values.js';
import { createResponseExtensionHost } from '../server/extension-response.js';

function program(capability = true): ExtensionProgram {
  return {
    api: EXTENSION_PROGRAM_API,
    ...(capability ? { capabilities: ['response.read.current' as const] } : {}),
    source: 'return {state: api.state, result: null};',
  };
}

async function read(
  host: ReturnType<typeof createResponseExtensionHost>,
  args: RuntimeValue = {},
  signal = new AbortController().signal
) {
  return host('response.read', args, signal) as Promise<Record<string, RuntimeValue>>;
}

describe('current response extension host', () => {
  it('pages one fixed UTF-16 response copy with bounded defaults and a stable hash', async () => {
    const text = '가'.repeat(8001) + '🙂끝';
    const assertCurrent = vi.fn();
    const host = createResponseExtensionHost(program(), text, assertCurrent);
    const first = await read(host);
    expect(first).toEqual({
      text: text.slice(0, 8000),
      offset: 0,
      nextOffset: 8000,
      totalChars: text.length,
      contentHash: createHash('sha256').update(text).digest('hex'),
    });
    expect(await read(host, { offset: 8000, limit: 16000 })).toEqual({
      text: text.slice(8000),
      offset: 8000,
      nextOffset: null,
      totalChars: text.length,
      contentHash: first.contentHash,
    });
    expect(assertCurrent).toHaveBeenCalledTimes(2);
  });

  it('rechecks cancellation and ownership for every disclosure', async () => {
    const controller = new AbortController();
    controller.abort();
    const before = vi.fn();
    await expect(
      read(createResponseExtensionHost(program(), 'text', before), {}, controller.signal)
    ).rejects.toThrow('BEHAVIOR_HOST_ABORTED');
    expect(before).not.toHaveBeenCalled();

    const during = new AbortController();
    const after = vi.fn(() => during.abort());
    await expect(
      read(createResponseExtensionHost(program(), 'text', after), {}, during.signal)
    ).rejects.toThrow('BEHAVIOR_HOST_ABORTED');

    const denied = vi.fn(() => {
      throw new Error('OWNER_STALE');
    });
    const host = createResponseExtensionHost(program(), 'text', denied);
    await expect(read(host)).rejects.toThrow('OWNER_STALE');
    await expect(read(host)).rejects.toThrow('OWNER_STALE');
    expect(denied).toHaveBeenCalledTimes(2);
  });

  it('denies missing capability and methods, and enforces exact bounded arguments', async () => {
    const current = vi.fn();
    await expect(
      read(createResponseExtensionHost(program(false), 'text', current))
    ).rejects.toThrow('BEHAVIOR_HOST_DENIED');
    expect(current).not.toHaveBeenCalled();
    const host = createResponseExtensionHost(program(), 'text', current);
    await expect(host('materials.read', {}, new AbortController().signal)).rejects.toThrow(
      'BEHAVIOR_HOST_DENIED'
    );
    for (const args of [
      { extra: true },
      { offset: -1 },
      { offset: 5 },
      { offset: 1.5 },
      { limit: 0 },
      { limit: 16001 },
      [],
      null,
    ])
      await expect(read(host, args as RuntimeValue)).rejects.toThrow('BEHAVIOR_HOST_ARGUMENTS');

    let accessed = 0;
    const accessor = Object.defineProperty({}, 'offset', {
      enumerable: true,
      get() {
        accessed++;
        return 0;
      },
    });
    await expect(read(host, accessor as RuntimeValue)).rejects.toThrow('BEHAVIOR_HOST_ARGUMENTS');
    expect(accessed).toBe(0);
  });
});
