import { randomUUID } from 'node:crypto';
import { PROVIDER_PROTOCOLS, validateProviderEndpoint, type Connection } from '../core/product.js';
import { isVertexFileReference, validCredentialRef } from '../core/credential-reference.js';
import { fields, record, choice, number, text, boolean, HttpError } from './request-validation.js';
import { apiKey } from './credentials.js';
import type { ProductStore } from './product-store.js';

/** Parse a provider edit; secret values stay separate from the public connection record. */
export function prepareConnection(product: ProductStore, value: unknown, id?: string) {
  const body = record(value);
  fields(body, [
    'title',
    'protocol',
    'endpoint',
    'credentialRef',
    'apiKey',
    'enabled',
    'expectedRevision',
  ]);
  const protocol = choice(body.protocol, [...PROVIDER_PROTOCOLS], 'protocol');
  const rawEndpoint = text(body.endpoint, 'endpoint', 2048);
  let endpoint: string;
  try {
    endpoint = validateProviderEndpoint(protocol, rawEndpoint);
  } catch {
    throw new HttpError(400, '이 프로토콜에 맞는 API 기본 주소를 입력해 주세요.');
  }

  const prior = id ? product.get<Connection>('connection', id) : undefined;
  const expectedRevision = id ? number(body.expectedRevision, 'revision') : undefined;
  if (prior && prior.revision !== expectedRevision) throw new HttpError(409, 'Revision conflict');
  const writes: { reference: string; value: string }[] = [];
  const keyReference = (field: 'apiKey', previous: unknown): string | undefined => {
    if (Object.hasOwn(body, field) && body[field] !== '') {
      const value = apiKey(body[field]);
      if (value === null) return undefined;
      const reference = `API_${randomUUID().replaceAll('-', '')}`;
      writes.push({ reference, value });
      return reference;
    }
    if (!previous) return undefined;
    const reference = text(previous, 'credential reference', 200);
    if (!validCredentialRef(reference)) throw new HttpError(400, 'Invalid credential reference');
    if (!id && !isVertexFileReference(reference)) {
      const value = product.store.credentials.get(reference);
      if (!value) return undefined;
      const copied = `API_${randomUUID().replaceAll('-', '')}`;
      writes.push({ reference: copied, value });
      return copied;
    }
    return reference;
  };
  const credentialRef =
    protocol === 'codex-app-server-v1'
      ? undefined
      : keyReference('apiKey', body.credentialRef ?? prior?.credentialRef);
  const sameConnection =
    prior?.protocol === protocol &&
    prior.endpoint === endpoint &&
    prior.credentialRef === credentialRef;
  const connection: Omit<Connection, 'id' | 'revision'> = {
    title: text(body.title, 'title', 200),
    protocol,
    endpoint,
    ...(credentialRef ? { credentialRef } : {}),
    enabled: body.enabled === undefined ? true : boolean(body.enabled),
    catalog: sameConnection ? prior.catalog : [],
    catalogError: sameConnection ? prior.catalogError : null,
    catalogUpdatedAt: sameConnection ? (prior.catalogUpdatedAt ?? null) : null,
  };
  return { value: connection, expectedRevision, writes };
}

export function saveConnection(product: ProductStore, value: unknown, id?: string) {
  return product.store.transaction(() => {
    const previous = id ? product.get<Connection>('connection', id) : undefined;
    const prepared = prepareConnection(product, value, id);
    const saved = product.saveInTransaction(
      'connection',
      prepared.value,
      id,
      prepared.expectedRevision
    );
    for (const write of prepared.writes)
      product.store.credentials.set(write.reference, write.value);
    // A removed connection key must not survive as an orphan secret in DB backups.
    const previousCredential = previous?.credentialRef;
    if (previousCredential?.startsWith('API_')) {
      const referenced = product.db
        .prepare(`SELECT 1 FROM provider_settings WHERE kind='connection'
        AND json_extract(body,'$.credentialRef')=?`)
        .get(previousCredential);
      if (!referenced) product.store.credentials.set(previousCredential, null);
    }
    return saved;
  });
}
