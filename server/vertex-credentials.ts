import type { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { GoogleAuth } from 'google-auth-library';
import { CredentialStore } from './credentials.js';
import { HttpError } from './request-validation.js';
import {
  ProviderContractError,
  type ProviderExecutionOptions,
  type ProviderConnection,
} from '../core/transport.js';
import {
  isVertexAdcReference,
  isVertexFileReference,
  VERTEX_FILE_PREFIX,
} from '../core/credential-reference.js';
import { vertexAccessToken } from '../core/vertex-auth.js';
import { validateVertexEndpoint } from '../core/product.js';

type ServiceAccount = {
  type: 'service_account';
  project_id: string;
  client_email: string;
  private_key: string;
  token_uri: 'https://oauth2.googleapis.com/token';
};
function accountValue(value: unknown): ServiceAccount {
  const account = value as Partial<ServiceAccount> | null;
  if (
    !account ||
    account.type !== 'service_account' ||
    typeof account.project_id !== 'string' ||
    !account.project_id.trim() ||
    typeof account.client_email !== 'string' ||
    !account.client_email.includes('@') ||
    typeof account.private_key !== 'string' ||
    !account.private_key.includes('PRIVATE KEY')
  )
    throw new HttpError(400, 'Google 서비스 계정 JSON을 확인해 주세요.');
  return {
    type: 'service_account',
    project_id: account.project_id,
    client_email: account.client_email,
    private_key: account.private_key,
    token_uri: 'https://oauth2.googleapis.com/token',
  };
}

/** Uploaded account data belongs to the app DB; short-lived OAuth tokens stay in this adapter. */
export class VertexCredentialStore {
  private readonly keys: CredentialStore;
  private readonly clients = new Map<string, GoogleAuth>();
  constructor(db: DatabaseSync) {
    this.keys = new CredentialStore(db);
  }

  upload(value: unknown) {
    const account = accountValue(value);
    const reference = VERTEX_FILE_PREFIX + randomBytes(16).toString('hex').toUpperCase();
    this.keys.set(reference, JSON.stringify(account));
    return {
      credentialRef: reference,
      projectId: account.project_id,
      clientEmail: account.client_email,
    };
  }

  private account(reference: string): ServiceAccount {
    const saved = this.keys.get(reference);
    if (!saved) throw new HttpError(400, '서비스 계정을 먼저 등록해 주세요.');
    return accountValue(JSON.parse(saved));
  }

  validate(connection: Pick<ProviderConnection, 'protocol' | 'endpoint' | 'credentialRef'>) {
    if (!connection.credentialRef || !isVertexFileReference(connection.credentialRef)) return;
    if (connection.protocol !== 'vertex-gemini-v1')
      throw new HttpError(400, 'Vertex 연결이 필요해요.');
    validateVertexEndpoint(connection.endpoint);
    const project = new URL(connection.endpoint).pathname.match(/\/projects\/([^/]+)\//u)?.[1];
    if (this.account(connection.credentialRef).project_id !== project)
      throw new HttpError(400, '서비스 계정과 API 주소의 프로젝트가 달라요.');
  }

  configured(connection: Pick<ProviderConnection, 'protocol' | 'endpoint' | 'credentialRef'>) {
    if (!connection.credentialRef) return false;
    try {
      this.validate(connection);
      return this.keys.status(connection.credentialRef).configured;
    } catch {
      return false;
    }
  }

  /** Use the same Vertex credential as generation for non-generating metadata requests. */
  async accessToken(connection: ProviderConnection, signal: AbortSignal): Promise<string> {
    if (isVertexAdcReference(connection.credentialRef)) return vertexAccessToken(signal);
    const reference = connection.credentialRef;
    if (!reference) throw new ProviderContractError('CREDENTIAL_UNAVAILABLE');
    const token = await this.resolve(reference, connection, signal);
    if (!token || /[\r\n]/u.test(token)) throw new ProviderContractError('CREDENTIAL_UNAVAILABLE');
    return token;
  }

  resolve: NonNullable<ProviderExecutionOptions['resolveCredential']> = async (
    reference,
    connection,
    signal
  ) => {
    if (!isVertexFileReference(reference)) return this.keys.get(reference);
    if (!connection || connection.credentialRef !== reference)
      throw new ProviderContractError('CREDENTIAL_UNAVAILABLE');
    this.validate(connection);
    signal?.throwIfAborted();
    let client = this.clients.get(reference);
    if (!client) {
      client = new GoogleAuth({
        credentials: this.account(reference),
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      });
      this.clients.set(reference, client);
    }
    const token = await new Promise<string | null | undefined>((resolve, reject) => {
      const abort = () => reject(new ProviderContractError('CANCELLED'));
      signal?.addEventListener('abort', abort, { once: true });
      client!.getAccessToken().then(
        (value) => {
          signal?.removeEventListener('abort', abort);
          resolve(value);
        },
        (error) => {
          signal?.removeEventListener('abort', abort);
          reject(error);
        }
      );
    });
    signal?.throwIfAborted();
    if (!token) throw new ProviderContractError('CREDENTIAL_UNAVAILABLE');
    return token;
  };
}
