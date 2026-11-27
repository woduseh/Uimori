import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import {
  DEFAULT_LORE_CONTEXT,
  validateLoreContextPolicy,
  type LoreContextDefaults,
  type LoreContextPolicy,
} from '../core/lore-context.js';
import { promptEndpoints, type UpdateLoreContextDefaults } from '#contracts';
import { promptOperations } from '#contracts/operations';
import { HttpError } from './request-validation.js';
import { registerEndpoint } from './endpoint.js';
import type { Store } from './store.js';
import { assertRevision } from './app-errors.js';

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

export function updateLoreContextDefaults(
  store: Store,
  { expectedRevision, ...policyValue }: UpdateLoreContextDefaults
): LoreContextDefaults {
  let policy: LoreContextPolicy;
  try {
    policy = validateLoreContextPolicy(policyValue);
  } catch {
    throw new HttpError(400, 'Invalid lore context defaults');
  }
  return store.transaction(() => {
    const prior = loreContextDefaults(store);
    assertRevision(prior.revision, expectedRevision);
    const revision = prior.revision + 1;
    store.db
      .prepare('UPDATE lore_context_defaults SET revision=?,body=? WHERE id=1')
      .run(revision, JSON.stringify(policy));
    return { revision, ...policy };
  });
}

export function loreContextDefaultRoutes(app: FastifyInstance, store: Store) {
  registerEndpoint(
    app,
    promptEndpoints.readLoreContextDefaults,
    promptOperations.readLoreContextDefaults,
    (_input, _request, reply) => {
      reply.header('Cache-Control', 'no-store');
      return loreContextDefaults(store);
    }
  );
  registerEndpoint(
    app,
    promptEndpoints.updateLoreContextDefaults,
    promptOperations.updateLoreContextDefaults,
    (input) => updateLoreContextDefaults(store, input)
  );
}
