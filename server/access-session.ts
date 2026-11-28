import { HttpError, isSha256Hex } from './request-validation.js';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

const digest = (value: string) => createHash('sha256').update(value).digest();
const COOKIE_AGE_SECONDS = 400 * 24 * 60 * 60;
export class AccessSessionRateLimitError extends HttpError {
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number) {
    super(429, 'Too many login attempts');
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class AccessSessions {
  readonly required: boolean;
  private readonly authority: Buffer;
  private readonly mcpAuthority: Buffer | undefined;
  private readonly secure: boolean;
  private failures = 0;
  private blockedUntil = 0;
  private readonly now: () => number;

  private readonly db: DatabaseSync;
  constructor(
    db: DatabaseSync,
    options: {
      accessToken?: string;
      mcpToken?: string;
      publicOrigin?: string;
      now?: () => number;
    }
  ) {
    this.db = db;
    this.required = !!options.accessToken;
    this.authority = digest(options.accessToken ?? '');
    this.mcpAuthority = options.mcpToken ? digest(options.mcpToken) : undefined;
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

  sessionHash(cookie?: string): string | null {
    const token = this.token(cookie);
    if (!token) return null;
    const hash = digest(token).toString('hex');
    return this.db
      .prepare('SELECT 1 FROM access_sessions WHERE token_hash=? AND authority_hash=?')
      .get(hash, this.authority.toString('hex'))
      ? hash
      : null;
  }
  authenticated(cookie?: string): boolean {
    return !this.required || this.sessionHash(cookie) !== null;
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

  private reject(message: string): never {
    if (++this.failures >= 10) {
      this.blockedUntil = this.now() + 60_000;
      this.failures = 0;
    }
    throw new HttpError(401, message);
  }

  authorizeMcp(authorization?: string): void {
    this.checkLoginAllowed();
    const bearer = /^Bearer (\S+)$/iu.exec(authorization ?? '')?.[1];
    if (!bearer || !this.mcpAuthority) throw new HttpError(401, 'MCP token required');
    if (!timingSafeEqual(digest(bearer), this.mcpAuthority)) this.reject('MCP token rejected');
  }

  login(value: string): { cookie: string } {
    this.checkLoginAllowed();
    if (this.required && !timingSafeEqual(digest(value), this.authority))
      this.reject('Access token rejected');
    this.failures = 0;
    const token = randomBytes(32).toString('hex');
    this.db
      .prepare('INSERT INTO access_sessions VALUES(?,?)')
      .run(digest(token).toString('hex'), this.authority.toString('hex'));
    return { cookie: this.cookie(token) };
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
