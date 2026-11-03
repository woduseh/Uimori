import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import { api, ApiError } from '../web/api.js';
import { cloneWithReceipt } from '../web/resource-create-retry.js';

vi.mock('../web/api.js', async (original) => ({
  ...(await original<typeof import('../web/api.js')>()),
  api: vi.fn(),
}));

const input = {
  kind: 'content' as const,
  sourceId: 'bot-original',
  expectedSourceRevision: 2,
  title: 'Bot copy',
};
const key = 'resource-clone:content:bot-original';
let persisted: Map<string, string>;

beforeEach(() => {
  vi.mocked(api).mockReset();
  persisted = new Map();
  vi.stubGlobal('sessionStorage', {
    getItem: (name: string) => persisted.get(name) ?? null,
    setItem: (name: string, data: string) => {
      persisted.set(name, data);
    },
    removeItem: (name: string) => {
      persisted.delete(name);
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

test('an uncertain clone replays the exact request across the next click, then allows a fresh clone', async () => {
  vi.mocked(api).mockRejectedValueOnce(new Error('Connection lost'));
  await expect(cloneWithReceipt(key, input)).rejects.toThrow('Connection lost');
  const original = JSON.parse(persisted.get(key)!);
  expect(original).toMatchObject({ ...input, idempotencyKey: expect.any(String) });
  vi.mocked(api).mockResolvedValueOnce({ created: false, saved: { id: 'copy-once' } });
  await expect(
    cloneWithReceipt(key, { ...input, expectedSourceRevision: 3 })
  ).resolves.toMatchObject({
    saved: { id: 'copy-once' },
  });
  expect(api).toHaveBeenLastCalledWith('/resources/clone', original);
  expect(persisted.has(key)).toBe(false);
  vi.mocked(api).mockResolvedValueOnce({ created: true, saved: { id: 'copy-twice' } });
  await cloneWithReceipt(key, input);
  expect(vi.mocked(api).mock.lastCall?.[1]).toMatchObject({
    ...input,
    idempotencyKey: expect.not.stringMatching(original.idempotencyKey),
  });
});

test('a definite validation rejection permits a corrected request, but a rate limit keeps the receipt', async () => {
  vi.mocked(api).mockRejectedValueOnce(new ApiError('Invalid source', 409));
  await expect(cloneWithReceipt(key, input)).rejects.toThrow('Invalid source');
  expect(persisted.has(key)).toBe(false);

  vi.mocked(api).mockRejectedValueOnce(new ApiError('Try again', 429));
  await expect(cloneWithReceipt(key, input)).rejects.toThrow('Try again');
  expect(persisted.has(key)).toBe(true);
  vi.mocked(api).mockResolvedValueOnce({ saved: { id: 'copy' } });
  await cloneWithReceipt(key, input);
  expect(persisted.has(key)).toBe(false);
});

test('invalid retained clone input fails closed without issuing a new mutation', async () => {
  persisted.set(key, JSON.stringify({ ...input, sourceId: 'another' }));
  await expect(cloneWithReceipt(key, input)).rejects.toThrow('복제 요청 기록');
  expect(api).not.toHaveBeenCalled();
});
