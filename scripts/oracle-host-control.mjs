import { request as httpRequest } from 'node:http';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { readAccessEnv, runOracleSmoke } from './oracle-smoke.mjs';

/** Host-side HTTP control uses the production Host/Origin over loopback.
 * Credentials never enter command arguments, output, or a controller-side file.
 */
export async function localRequest({
  origin,
  pathname,
  method = 'GET',
  cookie,
  body,
  endpoint = 'http://127.0.0.1:4310',
  timeoutMs = 5000,
}) {
  return new Promise((resolveRequest, reject) => {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const request = httpRequest(
      new URL(pathname, endpoint),
      {
        method,
        agent: false,
        headers: {
          Host: new URL(origin).host,
          Origin: origin,
          ...(cookie ? { Cookie: cookie } : {}),
          ...(encoded
            ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(encoded) }
            : {}),
        },
      },
      (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          text += chunk;
          if (text.length > 65536) request.destroy(new Error('Host control response too large'));
        });
        response.on('error', reject);
        response.on('end', () => {
          clearTimeout(timer);
          try {
            resolveRequest({
              status: response.statusCode,
              headers: response.headers,
              body: JSON.parse(text),
            });
          } catch {
            reject(new Error('Host control returned invalid JSON'));
          }
        });
      }
    );
    const timer = setTimeout(
      () => request.destroy(new Error('Host control request timeout')),
      timeoutMs
    );
    request.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    request.end(encoded);
  });
}

export async function controlMaintenance({ action, origin, token, owner, request = localRequest }) {
  if (!['status', 'close', 'open'].includes(action)) throw new Error('Unknown maintenance action');
  const login = await request({
    origin,
    pathname: '/api/session',
    method: 'POST',
    body: { token },
  });
  if (login.status !== 200) throw new Error(`Host control login failed (${login.status})`);
  const cookie = login.headers['set-cookie']?.[0]?.split(';')[0];
  if (!cookie?.startsWith('uimori_session=')) throw new Error('Host control session missing');
  const send = async (pathname, body) => {
    const response = await request({
      origin,
      pathname,
      cookie,
      ...(body ? { method: 'POST', body } : {}),
    });
    if (response.status !== 200)
      throw new Error(`Host control ${pathname} HTTP ${response.status}`);
    return response.body;
  };
  const state = await send('/api/maintenance');
  if (
    !['open', 'closed'].includes(state.status) ||
    !Number.isInteger(state.activeWork) ||
    state.activeWork < 0
  )
    throw new Error('Incomplete maintenance status');
  if (action === 'status') return state;
  if (!owner || !owner.startsWith('oracle:')) throw new Error('Missing release maintenance owner');
  if (state.forcedClosed) throw new Error('Maintenance is forced by boot configuration');
  if (state.status === 'closed' && state.reason !== owner)
    throw new Error('Maintenance belongs to another operator');
  if (action === 'open' && state.status === 'open') return state;
  const changed = await send('/api/maintenance', {
    status: action === 'close' ? 'closed' : 'open',
    reason: owner,
  });
  if (changed.status !== (action === 'close' ? 'closed' : 'open'))
    throw new Error('Maintenance change was not confirmed');
  return changed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  // This CLI is staged on the host and runs in the pinned application image.
  const [action, envFile, owner, buildId, outputFile] = process.argv.slice(2);
  let access;
  try {
    access = await readAccessEnv(envFile);
    const result =
      action === 'smoke'
        ? await runOracleSmoke({ ...access, buildId, outputFile })
        : await controlMaintenance({ action, ...access, owner });
    console.log(JSON.stringify(result));
    if (action === 'smoke' && result.status !== 'PASS') process.exitCode = 1;
  } catch (error) {
    // Only local status/transport diagnostics are constructed above; never print env/response bodies.
    const message = access?.token
      ? String(error.message).split(access.token).join('[redacted]')
      : error.message;
    console.error(`Host control failed: ${message}`);
    process.exitCode = 1;
  }
}
