import { expect, test } from 'vitest';
import { createECDH, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import webPush from 'web-push';
import {
  encryptedPushRequest,
  pushEndpoint,
  publicPushAddress,
  validatePushSubscription,
  sendWebPush,
} from '../server/push-transport.js';
import { notificationIntent, type PushEnvelope } from '../core/push.js';

function subscription() {
  const ec = createECDH('prime256v1');
  ec.generateKeys();
  return {
    endpoint: 'https://fcm.googleapis.com/fcm/send/synthetic-capability',
    keys: {
      p256dh: ec.getPublicKey().toString('base64url'),
      auth: randomBytes(16).toString('base64url'),
    },
  };
}
const envelope: PushEnvelope = {
  version: 1,
  kind: 'main-completed',
  tag: 'uimori-stable-task',
  chatId: 'chat-1',
  branchId: 'main:chat-1',
  sourceId: 'source-1',
  representation: 'original',
};

test('push capabilities accept only supported TLS relays and real curve/auth keys; private/mapped IP destinations are excluded', () => {
  const value = subscription();
  expect(validatePushSubscription(value)).toEqual(value);
  for (const endpoint of [
    'http://fcm.googleapis.com/push',
    'https://fcm.googleapis.com.attacker.invalid/push',
    'https://localhost/push',
    'https://127.0.0.1/push',
    'https://user:password@fcm.googleapis.com/push',
    'https://fcm.googleapis.com:8443/push',
    'file:///etc/passwd',
    'https://evilpush.apple.com/push',
  ])
    expect(() => pushEndpoint(endpoint), endpoint).toThrow();
  for (const endpoint of [
    'https://updates.push.services.mozilla.com/wpush/v2/x',
    'https://web.push.apple.com/synthetic',
    'https://wns2-par02p.notify.windows.com/w/?token=synthetic',
  ])
    expect(pushEndpoint(endpoint).protocol).toBe('https:');
  for (const address of [
    '127.0.0.1',
    '169.254.169.254',
    '10.0.0.1',
    '192.168.1.1',
    '100.64.0.1',
    '::1',
    'fc00::1',
    '::ffff:127.0.0.1',
    'fe80::1',
    '0.0.0.0',
  ])
    expect(publicPushAddress(address), address).toBe(false);
  expect(publicPushAddress('8.8.8.8')).toBe(true);
  expect(publicPushAddress('2606:4700:4700::1111')).toBe(true);
  expect(() =>
    validatePushSubscription({ ...value, keys: { ...value.keys, auth: 'AAAA' } })
  ).toThrow();
  expect(() =>
    validatePushSubscription({
      ...value,
      keys: { ...value.keys, p256dh: Buffer.alloc(65, 4).toString('base64url') },
    })
  ).toThrow();
});

test('real Web Push encryption/signing hides the payload, keeps TTL/topic bounded, and pre-aborted delivery never resolves DNS', async () => {
  const sub = subscription(),
    keys = webPush.generateVAPIDKeys();
  const details = encryptedPushRequest(
    sub,
    { ...envelope, title: 'PRIVATE_TITLE_CANARY' },
    keys,
    'https://story.example.test',
    999999
  );
  const headers = Object.fromEntries(
    Object.entries(details.headers).map(([key, value]) => [key.toLowerCase(), value])
  );
  expect(headers['content-encoding']).toBe('aes128gcm');
  expect(Number(headers.ttl)).toBe(7200);
  expect(headers.authorization).toContain('vapid');
  expect(String(headers.topic)).toHaveLength(32);
  expect(details.body!.toString()).not.toContain('PRIVATE_TITLE_CANARY');
  expect(JSON.stringify(details)).not.toContain(keys.privateKey);
  await expect(
    sendWebPush(sub, envelope, keys, 'https://story.example.test', 60, AbortSignal.abort())
  ).rejects.toThrow();
});

test('actual service-worker code shows a generic visible notification and focuses the existing app without navigating over its draft', async () => {
  const callbacks = new Map<string, (event: unknown) => void>();
  const notices: { title: string; options: { body: string; tag: string; data: unknown } }[] = [];
  const posted: unknown[] = [];
  let focused = 0,
    closed = 0;
  runInNewContext(readFileSync('web/public/sw.js', 'utf8'), {
    URL,
    self: {
      location: { origin: 'https://story.example.test' },
      addEventListener: (type: string, callback: (event: unknown) => void) =>
        callbacks.set(type, callback),
      registration: {
        showNotification: async (
          title: string,
          options: { body: string; tag: string; data: unknown }
        ) => {
          notices.push({ title, options });
        },
      },
      clients: {
        matchAll: async () => [
          {
            url: 'https://story.example.test/?chat=current',
            focused: true,
            focus: async () => {
              focused++;
            },
            postMessage: (message: unknown) => posted.push(message),
            navigate: () => {
              throw new Error('Would discard a user draft');
            },
          },
        ],
        openWindow: () => {
          throw new Error('Must focus the existing window');
        },
        claim: async () => {},
      },
    },
  });
  const work: Promise<unknown>[] = [];
  callbacks.get('push')!({
    data: { json: () => ({ ...envelope, text: 'PRIVATE_PROSE', url: 'https://attacker.invalid' }) },
    waitUntil: (value: Promise<unknown>) => work.push(value),
  });
  await Promise.all(work);
  expect(notices).toHaveLength(1);
  expect(notices[0]).toMatchObject({
    title: 'Uimori',
    options: { body: '본문 생성이 완료됐어요.', tag: envelope.tag },
  });
  expect(JSON.stringify(notices)).not.toMatch(/PRIVATE_PROSE|attacker/);
  callbacks.get('notificationclick')!({
    notification: {
      data: notices[0].options.data,
      close: () => {
        closed++;
      },
    },
    waitUntil: (value: Promise<unknown>) => work.push(value),
  });
  await Promise.all(work);
  expect(closed).toBe(1);
  expect(focused).toBe(1);
  expect(posted).toEqual([
    {
      type: 'uimori:notification-open',
      payload: {
        chatId: 'chat-1',
        branchId: 'main:chat-1',
        sourceId: 'source-1',
        representation: 'original',
      },
    },
  ]);
  expect(callbacks.has('fetch')).toBe(false);
  expect(callbacks.has('sync')).toBe(false);
});

test('a closed-app notification opens only the same origin and safely encodes IDs; malformed data cannot inject a URL', async () => {
  const callbacks = new Map<string, (event: unknown) => void>();
  const opened: string[] = [];
  runInNewContext(readFileSync('web/public/sw.js', 'utf8'), {
    URL,
    self: {
      location: { origin: 'https://story.example.test' },
      addEventListener: (type: string, callback: (event: unknown) => void) =>
        callbacks.set(type, callback),
      clients: { matchAll: async () => [], openWindow: async (url: string) => opened.push(url) },
    },
  });
  for (const data of [
    {
      ...envelope,
      chatId: 'x&source=wrong',
      sourceId: 'right?#',
      representation: 'translation',
      url: 'https://attacker.invalid',
    },
    { url: 'javascript:alert(1)' },
  ]) {
    const pending: Promise<unknown>[] = [];
    callbacks.get('notificationclick')!({
      notification: { data, close() {} },
      waitUntil: (value: Promise<unknown>) => pending.push(value),
    });
    await Promise.all(pending);
  }
  const first = new URL(opened[0]);
  expect(first.origin).toBe('https://story.example.test');
  expect(first.searchParams.get('chat')).toBe('x&source=wrong');
  expect(first.searchParams.get('source')).toBe('right?#');
  expect(first.searchParams.get('mode')).toBe('translation');
  expect(opened[1]).toBe('https://story.example.test/');
  expect(notificationIntent({ ...envelope, sourceId: null })).toEqual({ chatId: 'chat-1' });
  expect(notificationIntent({ url: 'https://attacker.invalid' })).toBeNull();
});
