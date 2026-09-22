import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import {
  DEFAULT_LORE_CONTEXT,
  validateLoreContextPolicy,
  type LoreContextDefaults,
  type LoreContextPolicy,
} from '../core/lore-context.js';
import { HttpError, fields, number, record } from './request-validation.js';
import type { Store } from './store.js';

type Row = { id: number; revision: number; body: string };

export function initLoreContextDefaults(db: DatabaseSync) {
  db.exec(
    'CREATE TABLE lore_context_defaults(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL CHECK(revision>0),body TEXT NOT NULL)'
  );
  db.prepare('INSERT INTO lore_context_defaults(id,revision,body) VALUES(1,1,?)').run(
    JSON.stringify(DEFAULT_LORE_CONTEXT)
  );
}

export function loreContextDefaults(store: Store): LoreContextDefaults {
  const row = store.db
    .prepare('SELECT id,revision,body FROM lore_context_defaults WHERE id=1')
    .get() as Row | undefined;
  if (!row || row.id !== 1 || !Number.isSafeInteger(row.revision) || row.revision < 1)
    throw new Error('LORE_CONTEXT_DEFAULTS_MISSING');
  return { revision: row.revision, ...validateLoreContextPolicy(JSON.parse(row.body)) };
}

export function updateLoreContextDefaults(store: Store, value: unknown): LoreContextDefaults {
  const body = record(value);
  fields(body, [
    'expectedRevision',
    'enabled',
    'tokenEstimator',
    'maxRetainedTokens',
    'maxRetainedEntries',
    'maxPinnedTokens',
    'judgment',
  ]);
  const { expectedRevision, ...policyValue } = body;
  let policy: LoreContextPolicy;
  try {
    policy = validateLoreContextPolicy(policyValue);
  } catch {
    throw new HttpError(400, 'Invalid lore context defaults');
  }
  return store.transaction(() => {
    const prior = loreContextDefaults(store);
    if (prior.revision !== number(expectedRevision, 'lore context defaults revision'))
      throw new HttpError(409, '로어 문맥 기본값이 변경됐어요. 새로고침한 뒤 저장해 주세요.');
    const revision = prior.revision + 1;
    store.db
      .prepare('UPDATE lore_context_defaults SET revision=?,body=? WHERE id=1')
      .run(revision, JSON.stringify(policy));
    return { revision, ...policy };
  });
}

export function loreContextDefaultRoutes(app: FastifyInstance, store: Store) {
  app.get('/api/lore-context-defaults', async (_request, reply) =>
    reply.header('Cache-Control', 'no-store').send(loreContextDefaults(store))
  );
  app.put('/api/lore-context-defaults', async (request) =>
    updateLoreContextDefaults(store, request.body)
  );
}
