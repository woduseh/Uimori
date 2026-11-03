import { afterEach, expect, test, vi } from 'vitest';
import { clearPendingHelperRequest, pendingHelperRequest } from '../web/helper-pending-request.js';

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}
afterEach(() => vi.unstubAllGlobals());

test('late cleanup retains a different request saved under the same key', () => {
  const local = storage();
  vi.stubGlobal('localStorage', local);
  vi.stubGlobal('sessionStorage', storage());
  const pending = pendingHelperRequest(
    'pending',
    () => ({ key: 'first' }),
    (value): value is { key: string } => !!value && typeof value === 'object' && 'key' in value
  );
  local.setItem('pending', JSON.stringify({ key: 'newer' }));
  clearPendingHelperRequest('pending', pending);
  expect(local.getItem('pending')).toBe(JSON.stringify({ key: 'newer' }));
});

test('missing data is not treated as a stored null, while stored null and false are valid', () => {
  const local = storage();
  const session = storage();
  vi.stubGlobal('localStorage', local);
  vi.stubGlobal('sessionStorage', session);
  const valid = (value: unknown): value is null | false => value === null || value === false;
  const first = pendingHelperRequest('pending', () => null as null | false, valid);
  expect(first.recovered).toBe(false);
  expect(local.getItem('pending')).toBe('null');
  clearPendingHelperRequest('pending', first);
  expect(local.getItem('pending')).toBeNull();
  session.setItem('pending', 'false');
  local.setItem('pending', 'null');
  const restored = pendingHelperRequest('pending', () => null as null | false, valid);
  expect(restored.request).toBe(false);
  expect(restored.recovered).toBe(true);
  clearPendingHelperRequest('pending', restored);
  expect(session.getItem('pending')).toBeNull();
  expect(local.getItem('pending')).toBe('null');
});
