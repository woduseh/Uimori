import { randomUUID } from 'node:crypto';
import { PROVIDER_PROTOCOLS, validateProviderEndpoint, type Connection } from '../core/product.js';
import { isVertexFileReference, validCredentialRef } from '../core/credential-reference.js';
import { fields, record, choice, number, text, boolean, HttpError } from './request-validation.js';
import { apiKey } from './credentials.js';
import { AppError } from './app-errors.js';
import { prepareVertexAccount, validateVertexCredential } from './vertex-credentials.js';
import type { ProductStore } from './product-store.js';
import { sameVertexProject } from '../core/vertex-location.js';

function prepareConnection(product: ProductStore, value: unknown, id?: string) {
  const body = record(value);
  fields(body, [
    'title',
    'protocol',
    'endpoint',
    'credentialRef',
    'apiKey',
    'serviceAccount',
    'enabled',
    'displayOrder',
    'expectedRevision',
  ]);
  const protocol = choice(body.protocol, [...PROVIDER_PROTOCOLS], 'protocol');
  const rawEndpoint = text(body.endpoint, 'endpoint', 2048);
  let endpoint: string;
  try {
    endpoint = validateProviderEndpoint(protocol, rawEndpoint);
  } catch {
    throw new AppError(400, 'PROVIDER_ENDPOINT_INVALID');
  }

  const expectedRevision = id ? number(body.expectedRevision, 'revision') : undefined;
  const prior = id ? product.editable<Connection>('connection', id, expectedRevision!) : undefined;
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
  let credentialRef: string | undefined;
  if (Object.hasOwn(body, 'serviceAccount')) {
    if (body.apiKey !== undefined && body.apiKey !== '')
      throw new HttpError(400, 'Choose one credential type');
    const write = prepareVertexAccount(body.serviceAccount);
    writes.push(write);
    credentialRef = write.reference;
  } else if (protocol !== 'codex-app-server-v1') {
    credentialRef = keyReference('apiKey', body.credentialRef ?? prior?.credentialRef);
  }
  const sameConnection =
    prior?.protocol === protocol &&
    (prior.endpoint === endpoint ||
      (protocol === 'vertex-gemini-v1' && sameVertexProject(prior.endpoint, endpoint))) &&
    prior.credentialRef === credentialRef;
  const connection: Omit<Connection, 'id' | 'revision'> = {
    title: text(body.title, 'title', 200),
    protocol,
    endpoint,
    ...(credentialRef ? { credentialRef } : {}),
    enabled: body.enabled === undefined ? true : boolean(body.enabled),
    ...(prior?.displayOrder !== undefined ? { displayOrder: prior.displayOrder } : {}),
    catalog: sameConnection ? prior.catalog : [],
    catalogError: sameConnection ? prior.catalogError : null,
    catalogUpdatedAt: sameConnection ? (prior.catalogUpdatedAt ?? null) : null,
  };
  return { value: connection, expectedRevision, writes, prior };
}

export function saveConnection(product: ProductStore, value: unknown, id?: string) {
  return product.store.transaction(() => {
    const prepared = prepareConnection(product, value, id);
    const previous = prepared.prior;
    const pending = prepared.writes.find(
      (write) => write.reference === prepared.value.credentialRef
    );
    validateVertexCredential(product.store.credentials, prepared.value, pending?.value);
    const saved = product.saveInTransaction(
      'connection',
      prepared.value,
      id,
      prepared.expectedRevision
    );
    for (const write of prepared.writes)
      product.store.credentials.set(write.reference, write.value);
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
