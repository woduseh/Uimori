import { HttpError } from './request-validation.js';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { createPrivateKey, randomBytes } from 'node:crypto';
import { GoogleAuth } from 'google-auth-library';
import {
  ProviderContractError,
  type ProviderExecutionOptions,
  type ProviderConnection,
} from '../core/transport.js';
import {
  isVertexFileReference,
  validVertexFileReference,
  VERTEX_FILE_PREFIX,
} from '../core/credential-reference.js';
import { validateVertexEndpoint } from '../core/product.js';

type ServiceAccount = {
  type: 'service_account';
  project_id: string;
  client_email: string;
  private_key: string;
  private_key_id: string;
  token_uri: 'https://oauth2.googleapis.com/token';
};
function normalize(value: unknown): ServiceAccount {
  const fail = (): never => {
    throw new HttpError(400, 'Invalid Google service account JSON');
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const b = value as Record<string, unknown>;
  if (
    b.type !== 'service_account' ||
    typeof b.project_id !== 'string' ||
    !/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/u.test(b.project_id) ||
    typeof b.client_email !== 'string' ||
    !/^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.iam\.gserviceaccount\.com$/u.test(b.client_email) ||
    typeof b.private_key !== 'string' ||
    b.private_key.length > 16000 ||
    typeof b.private_key_id !== 'string' ||
    !/^[a-fA-F0-9]{1,128}$/u.test(b.private_key_id) ||
    (b.token_uri !== undefined && b.token_uri !== 'https://oauth2.googleapis.com/token') ||
    (b.universe_domain !== undefined && b.universe_domain !== 'googleapis.com')
  )
    return fail();
  try {
    const key = createPrivateKey(b.private_key);
    if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048)
      return fail();
  } catch {
    return fail();
  }
  // Never pass uploader-controlled URLs, impersonation or external-account config to GoogleAuth.
  return {
    type: 'service_account',
    project_id: b.project_id,
    client_email: b.client_email,
    private_key: b.private_key,
    private_key_id: b.private_key_id,
    token_uri: 'https://oauth2.googleapis.com/token',
  };
}

/** App-local secret files are outside SQLite and every archive/export surface. */
export class VertexCredentialStore {
  readonly directory: string;
  private clients = new Map<string, GoogleAuth>();
  constructor(dbPath: string) {
    this.directory = join(dirname(dbPath), basename(dbPath) + '.vertex-credentials');
  }
  upload(value: unknown) {
    const account = normalize(value),
      reference = VERTEX_FILE_PREFIX + randomBytes(16).toString('hex').toUpperCase();
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      writeFileSync(this.path(reference), JSON.stringify(account), {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
    } catch {
      throw new HttpError(500, 'Service account could not be stored');
    }
    return {
      credentialEnv: reference,
      projectId: account.project_id,
      clientEmail: account.client_email,
    };
  }
  private path(reference: string) {
    if (!validVertexFileReference(reference))
      throw new HttpError(400, 'Invalid service account reference');
    return join(this.directory, reference.slice(VERTEX_FILE_PREFIX.length) + '.json');
  }
  private account(reference: string) {
    try {
      return normalize(JSON.parse(readFileSync(this.path(reference), 'utf8')));
    } catch {
      throw new HttpError(400, 'Service account unavailable');
    }
  }
  validate(connection: Pick<ProviderConnection, 'protocol' | 'endpoint' | 'credentialEnv'>) {
    const ref = connection.credentialEnv;
    if (!ref || !isVertexFileReference(ref)) return;
    if (connection.protocol !== 'vertex-gemini-v1')
      throw new HttpError(400, 'Service account requires Vertex AI');
    validateVertexEndpoint(connection.endpoint);
    const account = this.account(ref),
      project = new URL(connection.endpoint).pathname.match(/\/projects\/([^/]+)\//u)?.[1];
    if (project !== account.project_id)
      throw new HttpError(400, 'Service account project does not match Vertex endpoint');
  }
  configured(connection: Pick<ProviderConnection, 'protocol' | 'endpoint' | 'credentialEnv'>) {
    try {
      this.validate(connection);
      return true;
    } catch {
      return false;
    }
  }
  resolve: NonNullable<ProviderExecutionOptions['resolveCredential']> = async (
    reference,
    connection,
    signal
  ) => {
    if (!isVertexFileReference(reference)) return process.env[reference];
    try {
      if (!connection || connection.credentialEnv !== reference || !signal) throw new Error();
      this.validate(connection);
      if (signal.aborted) throw new Error();
      let client = this.clients.get(reference);
      if (!client) {
        client = new GoogleAuth({
          credentials: this.account(reference),
          scopes: ['https://www.googleapis.com/auth/cloud-platform'],
        });
        this.clients.set(reference, client);
      }
      const token = await new Promise<string | null | undefined>((resolve, reject) => {
        const abort = () => reject(new Error());
        signal.addEventListener('abort', abort, { once: true });
        client!
          .getAccessToken()
          .then(resolve, reject)
          .finally(() => signal.removeEventListener('abort', abort));
      });
      if (signal.aborted || !token || /[\r\n]/u.test(token)) throw new Error();
      return token;
    } catch {
      throw new ProviderContractError(signal?.aborted ? 'CANCELLED' : 'CREDENTIAL_UNAVAILABLE');
    }
  };
}
