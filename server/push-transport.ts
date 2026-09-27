import { createHash, ECDH } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import { request } from 'node:https';
import ipaddr from 'ipaddr.js';
import webPush from 'web-push';
import type { PushEnvelope, PushSubscriptionData } from '../core/push.js';
import { fields, record, HttpError } from './request-validation.js';

export type VapidKeys = { publicKey: string; privateKey: string };
export type PushDelivery = { status: number; retryAfterSeconds?: number };
export type PushSender = (
  subscription: PushSubscriptionData,
  payload: PushEnvelope,
  keys: VapidKeys,
  origin: string,
  ttl: number,
  signal: AbortSignal
) => Promise<PushDelivery>;

export function pushEndpoint(value: unknown): URL {
  if (typeof value !== 'string' || value.length > 4096)
    throw new HttpError(400, '알림 주소를 확인해 주세요.');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(400, '알림 주소를 확인해 주세요.');
  }
  const host = url.hostname;
  const supported =
    host === 'fcm.googleapis.com' ||
    host === 'updates.push.services.mozilla.com' ||
    host.endsWith('.push.apple.com') ||
    host.endsWith('.notify.windows.com');
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    !supported
  )
    throw new HttpError(400, '지원하는 브라우저의 HTTPS Push 주소가 아니에요.');
  return url;
}
export function validatePushSubscription(value: unknown): PushSubscriptionData {
  const body = record(value);
  fields(body, ['endpoint', 'keys', 'expirationTime']);
  const endpoint = pushEndpoint(body.endpoint).href;
  const keys = record(body.keys);
  fields(keys, ['p256dh', 'auth']);
  const decode = (value: unknown, size: number) => {
    if (
      typeof value !== 'string' ||
      value.length > 100 ||
      !/^[a-z0-9_-]+={0,2}$/i.test(value) ||
      Buffer.from(value, 'base64url').length !== size
    )
      throw new HttpError(400, '브라우저 알림 암호화 키를 확인해 주세요.');
    return Buffer.from(value, 'base64url');
  };
  const publicKey = decode(keys.p256dh, 65);
  try {
    if (publicKey[0] !== 4) throw new Error();
    ECDH.convertKey(publicKey, 'prime256v1');
  } catch {
    throw new HttpError(400, '브라우저 알림 공개 키가 올바르지 않아요.');
  }
  return {
    endpoint,
    keys: {
      p256dh: publicKey.toString('base64url'),
      auth: decode(keys.auth, 16).toString('base64url'),
    },
  };
}
export function publicPushAddress(address: string): boolean {
  try {
    return ipaddr.process(address).range() === 'unicast';
  } catch {
    return false;
  }
}
async function destination(
  hostname: string,
  signal: AbortSignal
): Promise<{ address: string; family: 4 | 6 }> {
  signal.throwIfAborted();
  const resolver = new Resolver({ timeout: 2000, tries: 1 });
  const cancel = () => resolver.cancel();
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const answers = await Promise.allSettled([
      resolver.resolve4(hostname),
      resolver.resolve6(hostname),
    ]);
    signal.throwIfAborted();
    const addresses = answers.flatMap((answer, index) =>
      answer.status === 'fulfilled'
        ? answer.value.map((address) => ({ address, family: (index ? 6 : 4) as 4 | 6 }))
        : []
    );
    if (!addresses.length || addresses.some((item) => !publicPushAddress(item.address)))
      throw new Error('PUSH_DNS_UNAVAILABLE');
    return addresses[0];
  } finally {
    signal.removeEventListener('abort', cancel);
    resolver.cancel();
  }
}
export function encryptedPushRequest(
  subscription: PushSubscriptionData,
  payload: PushEnvelope,
  keys: VapidKeys,
  origin: string,
  ttl: number
) {
  pushEndpoint(subscription.endpoint);
  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized) > 3000) throw new Error('PUSH_PAYLOAD_TOO_LARGE');
  return webPush.generateRequestDetails(subscription, serialized, {
    vapidDetails: { subject: origin, ...keys },
    TTL: Math.max(1, Math.min(7200, Math.floor(ttl))),
    urgency: 'normal',
    topic: createHash('sha256').update(payload.tag).digest('base64url').slice(0, 32),
    contentEncoding: 'aes128gcm',
  });
}
/** Encrypt/sign with the maintained Web Push library, then use a pinned public DNS address,
 * normal TLS validation, no redirects, and an absolute cancellation/deadline owned by the caller. */
export const sendWebPush: PushSender = async (subscription, payload, keys, origin, ttl, signal) => {
  const url = pushEndpoint(subscription.endpoint);
  const pinned = await destination(url.hostname, signal);
  const details = encryptedPushRequest(subscription, payload, keys, origin, ttl);
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const failure = () => reject(new Error('PUSH_TRANSPORT_FAILED'));
    const req = request(
      url,
      {
        method: 'POST',
        headers: details.headers,
        signal,
        servername: url.hostname,
        family: pinned.family,
        lookup: (_host, _options, callback) => callback(null, pinned.address, pinned.family),
      },
      (response) => {
        let bytes = 0;
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 16 * 1024) req.destroy(new Error('PUSH_RESPONSE_TOO_LARGE'));
        });
        response.once('error', failure);
        response.once('end', () => {
          const raw = response.headers['retry-after'];
          const delay =
            typeof raw === 'string'
              ? /^\d+$/.test(raw)
                ? Number(raw)
                : (Date.parse(raw) - Date.now()) / 1000
              : NaN;
          resolve({
            status: response.statusCode ?? 0,
            ...(Number.isFinite(delay)
              ? { retryAfterSeconds: Math.max(1, Math.min(600, Math.ceil(delay))) }
              : {}),
          });
        });
      }
    );
    req.once('error', failure);
    req.end(details.body);
  });
};
