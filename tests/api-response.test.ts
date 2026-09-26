import { afterEach, expect, test, vi } from 'vitest';
import {
  api,
  apiBinary,
  ApiError,
  libraryChangedKey,
  maintenanceChangedEvent,
  sessionRequiredEvent,
} from '../web/api.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function browser() {
  const window = new EventTarget();
  const session = vi.fn();
  const maintenance = vi.fn();
  const workspace = vi.fn();
  const setItem = vi.fn();
  window.addEventListener(sessionRequiredEvent, session);
  window.addEventListener(maintenanceChangedEvent, maintenance);
  window.addEventListener('prompt-workspace-changed', workspace);
  vi.stubGlobal('window', window);
  vi.stubGlobal('dispatchEvent', window.dispatchEvent.bind(window));
  vi.stubGlobal('localStorage', { setItem });
  return { session, maintenance, workspace, setItem };
}
function respond(status: number, payload: unknown) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(JSON.stringify(payload), { status }));
}
function request(mode: 'json' | 'binary', path = '/synthetic') {
  return mode === 'json' ? api(path, {}) : apiBinary(path, new Blob(['synthetic']));
}

test.each(['json', 'binary'] as const)('%s reports session expiry exactly once', async (mode) => {
  const b = browser();
  respond(401, { error: 'private session detail' });
  await expect(request(mode)).rejects.toMatchObject({ name: 'ApiError', status: 401 });
  expect(b.session).toHaveBeenCalledTimes(1);
  expect(b.maintenance).not.toHaveBeenCalled();
  expect(b.setItem).not.toHaveBeenCalled();
});

test.each(['/session', '/session?refresh=1'])(
  'JSON session probe %s does not recursively request login',
  async (path) => {
    const b = browser();
    respond(401, {});
    await expect(api(path)).rejects.toBeInstanceOf(ApiError);
    expect(b.session).not.toHaveBeenCalled();
  }
);

test.each(['json', 'binary'] as const)(
  '%s reports maintenance only for its recognized status and code',
  async (mode) => {
    const b = browser();
    respond(503, { error: 'MAINTENANCE_CLOSED' });
    await expect(request(mode)).rejects.toMatchObject({
      status: 503,
      code: 'MAINTENANCE_CLOSED',
    });
    expect(b.maintenance).toHaveBeenCalledTimes(1);
    expect(b.session).not.toHaveBeenCalled();
    b.maintenance.mockClear();
    for (const [status, error] of [
      [409, 'MAINTENANCE_CLOSED'],
      [503, 'UNRELATED_FAILURE'],
    ] as const) {
      respond(status, { error });
      await expect(request(mode)).rejects.toMatchObject({ status });
      expect(b.maintenance).not.toHaveBeenCalled();
    }
  }
);

test.each(['json', 'binary'] as const)('%s tolerates a non-JSON error response', async (mode) => {
  browser();
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response('<html>private</html>', { status: 502 })
  );
  await expect(request(mode)).rejects.toMatchObject({
    name: 'ApiError',
    status: 502,
    code: null,
  });
});

test('binary uploads preserve the Blob and do not announce JSON mutations', async () => {
  const b = browser();
  const fetch = respond(200, { uploaded: true });
  const blob = new Blob(['한글 binary input']);
  await expect(apiBinary('/uploads', blob)).resolves.toEqual({ uploaded: true });
  expect(fetch).toHaveBeenCalledWith('/api/uploads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: blob,
  });
  expect(fetch.mock.calls[0][1]?.body).toBe(blob);
  expect(b.setItem).not.toHaveBeenCalled();
  expect(b.workspace).not.toHaveBeenCalled();
});

test('successful JSON provider edits retain cross-tab and workspace invalidation', async () => {
  const b = browser();
  respond(200, { saved: true });
  await expect(api('/connections/synthetic', {}, 'PUT')).resolves.toEqual({ saved: true });
  expect(b.setItem).toHaveBeenCalledWith(libraryChangedKey, expect.any(String));
  expect(b.workspace).toHaveBeenCalledTimes(1);
});

test('failed JSON edits do not announce a saved library change', async () => {
  const b = browser();
  respond(409, { error: 'Revision conflict' });
  await expect(api('/connections/synthetic', {}, 'PUT')).rejects.toBeInstanceOf(ApiError);
  expect(b.setItem).not.toHaveBeenCalled();
  expect(b.workspace).not.toHaveBeenCalled();
});

test.each(['json', 'binary'] as const)(
  '%s propagates transport failure without an HTTP error',
  async (mode) => {
    const b = browser();
    const failure = new TypeError('Synthetic network failure');
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(failure);
    await expect(request(mode)).rejects.toBe(failure);
    expect(b.session).not.toHaveBeenCalled();
    expect(b.maintenance).not.toHaveBeenCalled();
  }
);
