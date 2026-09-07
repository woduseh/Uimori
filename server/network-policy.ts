import { isIP } from 'node:net';

export type NetworkPolicy = { publicOrigin?: string; publicHost?: string };
const loopbackNames = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** One configured browser origin, independent of untrusted forwarding headers. */
export function networkPolicy(options: {
  publicOrigin?: string;
  accessToken?: string;
  testMode?: boolean;
}): NetworkPolicy {
  if (options.publicOrigin === undefined) return {};
  let url: URL;
  try {
    url = new URL(options.publicOrigin);
  } catch {
    throw new Error('NR_PUBLIC_ORIGIN must be one HTTPS origin.');
  }
  if (
    !/^https:\/\/[^/?#\\\s]+\/?$/iu.test(options.publicOrigin) ||
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    !url.hostname ||
    url.port === '0'
  ) {
    throw new Error(
      'NR_PUBLIC_ORIGIN must be one HTTPS origin without credentials, path, query or fragment.'
    );
  }
  const token = options.accessToken;
  if (!token || token.length < 32 || token.length > 1000 || /\s/u.test(token)) {
    throw new Error(
      'Self-host mode requires NR_ACCESS_TOKEN with 32–1000 non-whitespace characters.'
    );
  }
  if (options.testMode) throw new Error('NR_TEST_MODE is unavailable in self-host mode.');
  return { publicOrigin: url.origin, publicHost: url.host };
}

export function listenAddress(
  env: NodeJS.ProcessEnv,
  policy: NetworkPolicy
): { host: string; port: number } {
  const host = env.NR_HOST ?? '127.0.0.1';
  if (host !== 'localhost' && !isIP(host))
    throw new Error('NR_HOST must be an IP address or localhost.');
  if (!policy.publicOrigin && !['127.0.0.1', '::1', 'localhost'].includes(host)) {
    throw new Error(
      'A non-loopback NR_HOST requires self-host mode with NR_PUBLIC_ORIGIN and NR_ACCESS_TOKEN.'
    );
  }
  const raw = env.NR_PORT ?? '4310';
  const port = Number(raw);
  if (!/^\d+$/u.test(raw) || !Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error('Invalid NR_PORT');
  return { host, port };
}

export type BrowserRequest = {
  method: string;
  headers: { host?: string; origin?: string; 'sec-fetch-site'?: string };
};

/** Return a fixed, non-sensitive error; the app converts it to HTTP 403. */
export function deniedBrowserRequest(
  policy: NetworkPolicy,
  request: BrowserRequest
): string | undefined {
  const host = request.headers.host;
  if (!host || /[\s\\/@?#%,]/u.test(host)) return 'Invalid request host';
  let url: URL;
  try {
    url = new URL(`${policy.publicOrigin ? 'https' : 'http'}://${host}`);
  } catch {
    return 'Invalid request host';
  }
  if (policy.publicOrigin ? url.host !== policy.publicHost : !loopbackNames.has(url.hostname)) {
    return 'Request host denied';
  }
  const origin = request.headers.origin;
  const expected = policy.publicOrigin ?? `http://${host}`;
  if (origin !== undefined && origin !== expected) return 'Cross-origin access denied';
  if (policy.publicOrigin) {
    if (request.headers['sec-fetch-site'] === 'cross-site') return 'Cross-site access denied';
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && origin !== expected)
      return 'Request origin required';
  }
}
