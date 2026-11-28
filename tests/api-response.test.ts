import { afterEach, expect, test, vi } from 'vitest';
import { deletionEndpoints, libraryEndpoints, promptEndpoints } from '#contracts';
import {
  api,
  apiBinary,
  ApiError,
  callEndpoint,
  libraryChangedKey,
  maintenanceChangedEvent,
  sessionRequiredEvent,
} from '../web/api.js';

const announced = vi.hoisted(() => vi.fn());
vi.mock('../web/live-stream.js', () => ({ announceLocalChange: announced }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function browser() {
  const window = new EventTarget();
  const session = vi.fn();
  const maintenance = vi.fn();
  const workspace = announced;
  workspace.mockClear();
  const setItem = vi.fn();
  window.addEventListener(sessionRequiredEvent, session);
  window.addEventListener(maintenanceChangedEvent, maintenance);
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

test('JSON and binary requests report session expiry exactly once', async () => {
  for (const mode of ['json', 'binary'] as const) {
    const b = browser();
    respond(401, { error: 'private session detail' });
    await expect(request(mode)).rejects.toMatchObject({ name: 'ApiError', status: 401 });
    expect(b.session).toHaveBeenCalledTimes(1);
    expect(b.maintenance).not.toHaveBeenCalled();
    expect(b.setItem).not.toHaveBeenCalled();
  }
});

test('JSON session probe does not recursively request login', async () => {
  const b = browser();
  respond(401, {});
  await expect(api('/session?refresh=1')).rejects.toBeInstanceOf(ApiError);
  expect(b.session).not.toHaveBeenCalled();
});

test('JSON and binary requests report maintenance only for its recognized status and code', async () => {
  for (const mode of ['json', 'binary'] as const) {
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
});

test('JSON and binary requests tolerate non-JSON errors and propagate transport failure', async () => {
  for (const mode of ['json', 'binary'] as const) {
    const b = browser();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<html>private</html>', { status: 502 })
    );
    await expect(request(mode)).rejects.toMatchObject({
      name: 'ApiError',
      status: 502,
      code: null,
    });
    const failure = new TypeError('Synthetic network failure');
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(failure);
    await expect(request(mode)).rejects.toBe(failure);
    expect(b.session).not.toHaveBeenCalled();
    expect(b.maintenance).not.toHaveBeenCalled();
  }
});

test('a typed endpoint tells other tabs about the changes its tag names, and a read tells nobody', async () => {
  const b = browser();
  respond(200, { revision: 2 });
  await callEndpoint(promptEndpoints.applyPreset, {
    expectedRevision: 1,
    role: 'main',
    presetId: 'p1',
  });
  expect(b.setItem).toHaveBeenCalledWith(libraryChangedKey, expect.any(String));
  expect(b.workspace).toHaveBeenLastCalledWith(expect.anything(), { echoed: true });
  b.setItem.mockClear();
  b.workspace.mockClear();
  respond(200, { deleted: true, id: 'c1' });
  await callEndpoint(deletionEndpoints.deleteConnection, { id: 'c1', expectedRevision: 1 });
  expect(b.setItem).toHaveBeenCalledTimes(1);
  expect(b.workspace).toHaveBeenLastCalledWith(expect.anything(), { echoed: false });
  b.setItem.mockClear();
  b.workspace.mockClear();
  respond(200, { revision: 1, folders: [], items: [] });
  await callEndpoint(libraryEndpoints.readOrganization);
  respond(200, { deleted: true, id: 'b1' });
  await callEndpoint(deletionEndpoints.deleteContent, { id: 'b1', expectedRevision: 1 });
  expect(b.setItem).toHaveBeenCalledTimes(1);
  expect(b.workspace).not.toHaveBeenCalled();
});

test('a typed endpoint flagged preferMinimal asks for the minimal answer, and others do not', async () => {
  browser();
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async () => new Response(JSON.stringify({ id: 'r1' })));
  const admission = { operation: 'test.run', method: 'POST', path: '/runs/:id/retry' } as const;
  await callEndpoint({ ...admission, preferMinimal: true }, { id: 'r1' } as never);
  await callEndpoint(admission, { id: 'r1' } as never);
  const sent = fetch.mock.calls.map(([, init]) => new Headers(init?.headers).get('prefer'));
  expect(sent).toEqual(['return=minimal', null]);
});

test('a legacy write tells other tabs only for the library and provider writes still on api()', async () => {
  const b = browser();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}'));
  await api('/content/c1/risu-preview', { revision: 1 });
  expect(b.setItem).not.toHaveBeenCalled();
  for (const path of ['/prompt-presets', '/prompt-combinations']) {
    b.setItem.mockClear();
    await api(path, {});
    expect(b.setItem, path).toHaveBeenCalledWith(libraryChangedKey, expect.any(String));
  }
  for (const path of ['/connections/c1/move', '/model-presets/m1/move', '/connections/c1']) {
    b.setItem.mockClear();
    b.workspace.mockClear();
    await api(path, {});
    expect(b.setItem, path).toHaveBeenCalledTimes(1);
    expect(b.workspace, path).toHaveBeenLastCalledWith(expect.anything(), { echoed: false });
  }
});
