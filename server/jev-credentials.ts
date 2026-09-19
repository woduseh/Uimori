import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HttpError } from './request-validation.js';

type CredentialFile = { revision: number; apiKey: string | null };
const validKey = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 4096 && /^[\x21-\x7e]+$/u.test(value);

/** Like Vertex credentials, server-local secret files are outside SQLite and JSON archives. */
export class JevCredentialStore {
  readonly directory: string;
  constructor(dbPath: string) {
    this.directory = join(dirname(dbPath), basename(dbPath) + '.jev-credentials');
  }
  private read(): CredentialFile {
    let raw: string;
    try {
      raw = readFileSync(join(this.directory, 'connection.json'), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { revision: 0, apiKey: null };
      throw new HttpError(503, 'JEV_CREDENTIAL_STORE_UNAVAILABLE');
    }
    try {
      const value = JSON.parse(raw) as CredentialFile;
      if (
        !Number.isSafeInteger(value.revision) ||
        value.revision < 1 ||
        (value.apiKey !== null && !validKey(value.apiKey))
      )
        throw new Error();
      return value;
    } catch {
      throw new HttpError(503, 'JEV_CREDENTIAL_STORE_UNAVAILABLE');
    }
  }
  status() {
    const saved = this.read();
    const source = saved.apiKey
      ? 'saved'
      : validKey(process.env.TYPESAFE_API_KEY)
        ? 'environment'
        : 'missing';
    return {
      revision: saved.revision,
      configured: source !== 'missing',
      credentialSource: source,
      hasSavedKey: saved.apiKey !== null,
    } as const;
  }
  resolve = (): string | undefined => {
    const value = this.read().apiKey ?? process.env.TYPESAFE_API_KEY;
    return validKey(value) ? value : undefined;
  };
  update(expectedRevision: number, apiKey: unknown) {
    if (apiKey !== null && !validKey(apiKey)) throw new HttpError(400, 'JEV_KEY_INVALID');
    const previous = this.read();
    if (expectedRevision !== previous.revision) throw new HttpError(409, 'JEV_REVISION_CONFLICT');
    if (previous.revision >= Number.MAX_SAFE_INTEGER)
      throw new HttpError(503, 'JEV_CREDENTIAL_STORE_UNAVAILABLE');
    const temporary = join(this.directory, randomUUID() + '.tmp');
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      writeFileSync(temporary, JSON.stringify({ revision: previous.revision + 1, apiKey }), {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      renameSync(temporary, join(this.directory, 'connection.json'));
    } catch {
      throw new HttpError(500, 'JEV_CREDENTIAL_SAVE_FAILED');
    } finally {
      rmSync(temporary, { force: true });
    }
    return this.status();
  }
}
