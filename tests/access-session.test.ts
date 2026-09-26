import { afterEach, expect, test } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { AccessSessions } from '../server/access-session.js';
import { initCredentials } from '../server/credentials.js';

const databases: DatabaseSync[] = [];
function fixture(accessToken = 'test-only-key'.repeat(4)) {
  const db = new DatabaseSync(':memory:');
  databases.push(db);
  initCredentials(db);
  let now = 0;
  const options = { accessToken, publicOrigin: 'https://workspace.example', now: () => now };
  return {
    db,
    options,
    sessions: new AccessSessions(db, options),
    time(value: number) {
      now = value;
    },
  };
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

test('time never invalidates a logged-in device; renewing its cookie does not create another session', () => {
  const f = fixture();
  const cookie = f.sessions.login(f.options.accessToken).cookie;
  expect(cookie).toContain('HttpOnly; SameSite=Strict');
  expect(cookie).toContain('Secure');
  f.time(10 ** 13);
  expect(f.sessions.authenticated(cookie)).toBe(true);
  expect(f.sessions.renew(cookie)).toContain('Max-Age=34560000');
  expect(f.db.prepare('SELECT count(*) AS n FROM access_sessions').get()!.n).toBe(1);
});
test('logout affects only the selected device; changing the access token revokes all old devices', () => {
  const f = fixture();
  const a = f.sessions.login(f.options.accessToken).cookie;
  const b = f.sessions.login(f.options.accessToken).cookie;
  f.sessions.logout(a);
  expect(f.sessions.authenticated(a)).toBe(false);
  expect(f.sessions.authenticated(b)).toBe(true);
  expect(
    new AccessSessions(f.db, { ...f.options, accessToken: 'new-test-only-key' }).authenticated(b)
  ).toBe(false);
});
test('wrong credentials never create a session and repeated attempts briefly back off', () => {
  const f = fixture();
  for (let i = 0; i < 10; i++) expect(() => f.sessions.login('wrong')).toThrow();
  expect(() => f.sessions.login(f.options.accessToken)).toThrow();
  expect(f.db.prepare('SELECT count(*) AS n FROM access_sessions').get()!.n).toBe(0);
  f.time(60_001);
  expect(f.sessions.authenticated(f.sessions.login(f.options.accessToken).cookie)).toBe(true);
});
test('local no-token mode needs no session; invalid cookies never authenticate protected mode', () => {
  expect(fixture('').sessions.authenticated()).toBe(true);
  const f = fixture();
  for (const cookie of [undefined, '', 'uimori_session=wrong', 'uimori_session=' + '0'.repeat(64)])
    expect(f.sessions.authenticated(cookie)).toBe(false);
});
