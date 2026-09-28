import { createHash, ECDH } from 'node:crypto';
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
/** Web Push owns encryption/signing; the standard HTTP client owns DNS, TLS and sockets.
 * The caller's absolute AbortSignal also cancels DNS/connection setup, unlike an idle timeout. */
export const sendWebPush: PushSender = async (subscription, payload, keys, origin, ttl, signal) => {
  signal.throwIfAborted();
  const details = encryptedPushRequest(subscription, payload, keys, origin, ttl);
  const response = await fetch(details.endpoint, {
    method: 'POST',
    headers: Object.fromEntries(
      Object.entries(details.headers).map(([key, value]) => [key, String(value)])
    ),
    body: details.body ? new Uint8Array(details.body) : undefined,
    redirect: 'error',
    signal,
  });
  // No provider body is needed or retained, including for errors. Close it immediately.
  await response.body?.cancel();
  const raw = response.headers.get('retry-after');
  const delay = raw
    ? /^\d+$/.test(raw)
      ? Number(raw)
      : (Date.parse(raw) - Date.now()) / 1000
    : NaN;
  return {
    status: response.status,
    ...(Number.isFinite(delay)
      ? { retryAfterSeconds: Math.max(1, Math.min(600, Math.ceil(delay))) }
      : {}),
  };
};
