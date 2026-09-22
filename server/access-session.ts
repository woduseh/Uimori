import { HttpError, isSha256Hex } from './request-validation.js';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

const digest = (value: string) => createHash('sha256').update(value).digest();
const COOKIE_AGE_SECONDS = 400 * 24 * 60 * 60;
export class AccessSessionRateLimitError extends HttpError {
  constructor(readonly retryAfterSeconds: number) {
    super(429, '잠시 후 다시 로그인해 주세요.');
  }
}

/** No server-side expiry. Restart retains sessions; logout or an access-token change revokes them. */
export class AccessSessions {
  readonly required: boolean;
  private readonly authority: Buffer;
  private readonly secure: boolean;
  private failures = 0;
  private blockedUntil = 0;
  private readonly now: () => number;

  constructor(
    private readonly db: DatabaseSync,
    options: { accessToken?: string; publicOrigin?: string; now?: () => number }
  ) {
    this.required = !!options.accessToken;
    this.authority = digest(options.accessToken ?? '');
    this.secure = !!options.publicOrigin;
    this.now = options.now ?? Date.now;
    this.db
      .prepare('DELETE FROM access_sessions WHERE authority_hash!=?')
      .run(this.authority.toString('hex'));
  }

  private token(cookie?: string): string | undefined {
    const value = cookie
      ?.split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith('uimori_session='))
      ?.slice('uimori_session='.length);
    return value && isSha256Hex(value) ? value : undefined;
  }

  authenticated(cookie?: string): boolean {
    if (!this.required) return true;
    const token = this.token(cookie);
    return (
      !!token &&
      !!this.db
        .prepare('SELECT 1 FROM access_sessions WHERE token_hash=? AND authority_hash=?')
        .get(digest(token).toString('hex'), this.authority.toString('hex'))
    );
  }

  checkLoginAllowed(): void {
    if (this.now() < this.blockedUntil)
      throw new AccessSessionRateLimitError(Math.ceil((this.blockedUntil - this.now()) / 1000));
  }

  private cookie(value: string, age = COOKIE_AGE_SECONDS): string {
    return `uimori_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${this.secure ? '; Secure' : ''}`;
  }

  renew(cookie?: string): string | undefined {
    const token = this.token(cookie);
    return token && this.authenticated(cookie) ? this.cookie(token) : undefined;
  }

  login(value: string): { cookie: string; revoked: boolean } {
    this.checkLoginAllowed();
    if (this.required && !timingSafeEqual(digest(value), this.authority)) {
      if (++this.failures >= 10) {
        this.blockedUntil = this.now() + 60_000;
        this.failures = 0;
      }
      throw new HttpError(401, '접속 토큰을 확인해 주세요.');
    }
    this.failures = 0;
    const token = randomBytes(32).toString('hex');
    this.db
      .prepare('INSERT INTO access_sessions VALUES(?,?)')
      .run(digest(token).toString('hex'), this.authority.toString('hex'));
    return { cookie: this.cookie(token), revoked: false };
  }

  logout(cookie?: string): string {
    const token = this.token(cookie);
    if (token)
      this.db
        .prepare('DELETE FROM access_sessions WHERE token_hash=?')
        .run(digest(token).toString('hex'));
    return this.cookie('', 0);
  }
}
