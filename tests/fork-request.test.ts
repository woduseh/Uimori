import { afterEach, expect, test, vi } from 'vitest';
import { ApiError, definiteRejection } from '../web/api.js';
import { requestChatFork } from '../web/fork-request.js';

const key = 'fork-command:chat:source';
function storageFixture() {
  const values = new Map<string, string>();
  const storage = {
    getItem: vi.fn((name: string) => values.get(name) ?? null),
    setItem: vi.fn((name: string, value: string) => {
      values.set(name, value);
    }),
    removeItem: vi.fn((name: string) => {
      values.delete(name);
    }),
  };
  vi.stubGlobal('sessionStorage', storage);
  return { storage, values };
}
const accepted = () => new Response(JSON.stringify({ id: 'forked-chat' }), { status: 200 });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test.each(['getItem', 'setItem'] as const)(
  'storage %s failure sends nothing and a subsequent attempt can succeed',
  async (method) => {
    const { storage } = storageFixture();
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(accepted());
    storage[method].mockImplementationOnce(() => {
      throw new Error('Storage unavailable');
    });
    await expect(requestChatFork('chat', 'source')).rejects.toThrow('Storage unavailable');
    expect(fetch).not.toHaveBeenCalled();
    await expect(requestChatFork('chat', 'source')).resolves.toMatchObject({ id: 'forked-chat' });
    expect(fetch).toHaveBeenCalledTimes(1);
  }
);

test('an uncertain request retains its admission key for the next attempt', async () => {
  const { values } = storageFixture();
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockRejectedValueOnce(new TypeError('Connection lost'))
    .mockResolvedValueOnce(accepted());
  await expect(requestChatFork('chat', 'source')).rejects.toThrow('Connection lost');
  const pending = values.get(key);
  expect(pending).toBeTruthy();
  await expect(requestChatFork('chat', 'source')).resolves.toMatchObject({ id: 'forked-chat' });
  const bodies = fetch.mock.calls.map(([, options]) => JSON.parse(String(options?.body)));
  expect(bodies).toEqual([
    { fromRevision: 'source', idempotencyKey: pending },
    { fromRevision: 'source', idempotencyKey: pending },
  ]);
  expect(values.has(key)).toBe(false);
});

test.each([408, 500, 503])('HTTP %s retains the pending admission identity', async (status) => {
  const { values } = storageFixture();
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ error: 'Synthetic failure' }), { status })
  );
  await expect(requestChatFork('chat', 'source')).rejects.toBeInstanceOf(ApiError);
  expect(values.get(key)).toBeTruthy();
});

test('a definite rejection clears only its own pending identity', async () => {
  const { values } = storageFixture();
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ error: 'Revision conflict' }), { status: 409 })
  );
  await expect(requestChatFork('chat', 'source')).rejects.toMatchObject({ status: 409 });
  expect(values.has(key)).toBe(false);
});

test.each(['getItem', 'removeItem'] as const)(
  'accepted work remains successful when cleanup %s throws',
  async (method) => {
    const { storage, values } = storageFixture();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      storage[method].mockImplementation(() => {
        throw new Error('Cleanup unavailable');
      });
      return accepted();
    });
    await expect(requestChatFork('chat', 'source')).resolves.toMatchObject({ id: 'forked-chat' });
    expect(values.get(key)).toBeTruthy();
  }
);

test('cleanup cannot replace a definite request error with a storage exception', async () => {
  const { storage } = storageFixture();
  storage.removeItem.mockImplementation(() => {
    throw new Error('Cleanup unavailable');
  });
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ error: 'Revision conflict' }), { status: 409 })
  );
  await expect(requestChatFork('chat', 'source')).rejects.toMatchObject({ status: 409 });
});

test('completion does not remove an identity written by another operation', async () => {
  const { values } = storageFixture();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    values.set(key, 'other-operation');
    return accepted();
  });
  await requestChatFork('chat', 'source');
  expect(values.get(key)).toBe('other-operation');
});

test('different source scopes do not share pending fork identities', async () => {
  const { values } = storageFixture();
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Connection lost'));
  await expect(requestChatFork('chat', 'source')).rejects.toThrow();
  await expect(requestChatFork('chat', 'other')).rejects.toThrow();
  expect(values.size).toBe(2);
  expect(values.get(key)).not.toBe(values.get('fork-command:chat:other'));
});

test('admission rejection classification retains the existing contract', () => {
  for (const status of [400, 401, 403, 404, 409, 422, 429])
    expect(definiteRejection(new ApiError('Synthetic', status))).toBe(true);
  for (const status of [408, 500, 502, 503])
    expect(definiteRejection(new ApiError('Synthetic', status))).toBe(false);
  expect(definiteRejection(new Error('Network failure'))).toBe(false);
});
