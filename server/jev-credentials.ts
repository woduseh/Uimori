import type { DatabaseSync } from 'node:sqlite';
import { CredentialStore, apiKey } from './credentials.js';

/** JEV uses the same SQLite secret store as other API-key providers. */
export class JevCredentialStore {
  private readonly keys: CredentialStore;
  constructor(db: DatabaseSync) {
    this.keys = new CredentialStore(db);
  }

  status() {
    const { revision, configured } = this.keys.status('jev');
    return {
      revision,
      configured,
      credentialSource: configured ? ('saved' as const) : ('missing' as const),
      hasSavedKey: configured,
    };
  }

  resolve = (): string | undefined => this.keys.get('jev');

  update(expectedRevision: number, value: unknown) {
    this.keys.set('jev', apiKey(value), expectedRevision);
    return this.status();
  }
}
