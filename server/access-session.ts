import { HttpError } from './request-validation.js';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const SESSION_LIFETIME_MS = 12 * 60 * 60 * 1000;
const MAX_SESSIONS = 32;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_FAILURES = 10;
const digest = (value: string) => createHash('sha256').update(value).digest();

export class AccessSessionRateLimitError extends HttpError {
  constructor(readonly retryAfterSeconds: number) {
    super(429, 'Too many login attempts. Try again later.');
  }
}

/** In-memory personal-workspace sessions; a server restart revokes every session. */
export class AccessSessions {
  readonly required: boolean;
  private readonly secure: boolean;
  private readonly tokenDigest: Buffer | undefined;
  private readonly now: () => number;
  private readonly sessions = new Map<string, number>();
  // A single bounded limiter deliberately ignores untrusted forwarded client IPs.
  private loginFailures = 0;
  private loginWindowEnd = 0;

  constructor(options: { accessToken?: string; publicOrigin?: string; now?: () => number }) {
    this.secure = !!options.publicOrigin;
    if (
      this.secure &&
      (!options.accessToken ||
        options.accessToken.length < 32 ||
        /[\r\n]/u.test(options.accessToken))
    ) {
      throw new Error(
        'Remote access requires an access token of at least 32 characters without line breaks'
      );
    }
    this.required = !!options.accessToken;
    this.tokenDigest = options.accessToken ? digest(options.accessToken) : undefined;
    this.now = options.now ?? Date.now;
  }

  private sessionKey(cookie?: string): string | undefined {
    const values = cookie
      ?.split(';')
      .map((value) => value.trim())
      .filter((value) => value.startsWith('nr_session='));
    if (values?.length !== 1) return undefined;
    const token = values[0].slice('nr_session='.length);
    return /^[a-f0-9]{64}$/u.test(token) ? digest(token).toString('hex') : undefined;
  }

  private discardExpired(now: number): void {
    for (const [key, expiresAt] of this.sessions) if (expiresAt <= now) this.sessions.delete(key);
  }

  authenticated(cookie?: string): boolean {
    if (!this.required) return true;
    this.discardExpired(this.now());
    const key = this.sessionKey(cookie);
    return key !== undefined && this.sessions.has(key);
  }

  checkLoginAllowed(): void {
    if (!this.secure) return;
    const now = this.now();
    if (now >= this.loginWindowEnd) {
      this.loginFailures = 0;
      this.loginWindowEnd = 0;
    }
    if (this.loginFailures >= MAX_LOGIN_FAILURES)
      throw new AccessSessionRateLimitError(
        Math.max(1, Math.ceil((this.loginWindowEnd - now) / 1000))
      );
  }

  private cookie(value: string, maxAge: number): string {
    return `nr_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${this.secure ? '; Secure' : ''}`;
  }

  login(value: string): { cookie: string; revoked: boolean } {
    this.checkLoginAllowed();
    const now = this.now();
    this.discardExpired(now);
    if (this.tokenDigest && !timingSafeEqual(digest(value), this.tokenDigest)) {
      if (this.secure) {
        if (this.loginFailures === 0) this.loginWindowEnd = now + LOGIN_WINDOW_MS;
        this.loginFailures++;
      }
      throw new HttpError(401, 'Invalid access token');
    }
    this.loginFailures = 0;
    this.loginWindowEnd = 0;
    let revoked = false;
    while (this.sessions.size >= MAX_SESSIONS) {
      this.sessions.delete(this.sessions.keys().next().value!);
      revoked = true;
    }
    const token = randomBytes(32).toString('hex');
    this.sessions.set(digest(token).toString('hex'), now + SESSION_LIFETIME_MS);
    return { cookie: this.cookie(token, SESSION_LIFETIME_MS / 1000), revoked };
  }

  logout(cookie?: string): string {
    this.discardExpired(this.now());
    const key = this.sessionKey(cookie);
    if (key !== undefined) this.sessions.delete(key);
    return this.cookie('', 0);
  }
}
