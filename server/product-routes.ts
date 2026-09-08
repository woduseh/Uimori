import { chatDeletionRoutes } from './chat-deletion.js';
import { assetDeletionRoutes } from './asset-deletion.js';
import { supportedModels } from '../core/model-capabilities.js';
import type { FastifyInstance } from 'fastify';
import { HttpError, type Store } from './store.js';
import { AccessSessions, AccessSessionRateLimitError } from './access-session.js';
import { forkChat } from './chat-fork.js';
import { fields, record, text, number } from './product-store.js';
import { validateVertexEndpoint, type Connection } from '../core/product.js';
import { parseCatalog, validateConnection } from '../core/transport.js';
import { promptRoutes } from './prompt-routes.js';
import { readiness, managementImpact } from './provider-management.js';
import { PROVIDER_DEFINITIONS } from '../core/provider-definitions.js';
import { chatOrganizationRoutes } from './chat-organization.js';
import { libraryOrganizationRoutes } from './library-organization.js';
import { packagePresentationRoutes } from './package-presentation-routes.js';
import { packageBehaviorRoutes } from './package-behavior-routes.js';
import type { VertexCredentialStore } from './vertex-credentials.js';
import type { CodexRuntimeService } from './codex-runtime.js';
import {
  PROVIDER_PROTOCOLS,
  validateProviderEndpoint,
  type ProviderProtocol,
} from '../core/product.js';
import { providerOriginApproval } from '../core/provider-origin-policy.js';
import { libraryDeletionRoutes } from './library-deletion.js';

export function productRoutes(
  app: FastifyInstance,
  store: Store,
  options: {
    credentials?: VertexCredentialStore;
    codex?: CodexRuntimeService;
    accessToken?: string;
    publicOrigin?: string;
    approvedOrigins: readonly string[];
    publish: (chatId: string) => void;
    onAuthChanged?: () => void;
    onChatDeleted?: (chatId: string) => void;
  }
) {
  const product = store.product;
  libraryDeletionRoutes(app, store);
  promptRoutes(app, store);
  chatDeletionRoutes(app, store, options.publish, options.onChatDeleted);
  assetDeletionRoutes(app, store, options.publish);
  chatOrganizationRoutes(app, store, options.publish);
  libraryOrganizationRoutes(app, store);
  packagePresentationRoutes(app, store);
  packageBehaviorRoutes(app, store);
  app.post<{ Params: { id: string } }>('/api/chats/:id/fork', async (request) => {
    const chat = forkChat(store, request.params.id, request.body);
    options.publish(chat.id);
    return chat;
  });
  const sessions = new AccessSessions(options);
  const authenticated = (cookie?: string) => sessions.authenticated(cookie);
  app.addHook('onRequest', async (request) => {
    // Fastify resolves percent-encoded paths before hooks, while request.url stays raw.
    // Authenticate the matched route so /%61pi/export cannot skip API protection.
    const rawPath = request.url.split('?')[0],
      routePath = request.routeOptions.url ?? rawPath;
    if (
      (routePath.startsWith('/api/') || rawPath.startsWith('/api/')) &&
      routePath !== '/api/session' &&
      !authenticated(request.headers.cookie)
    )
      throw new HttpError(401, 'Authentication required');
  });
  app.get('/api/session', async (request, reply) =>
    reply
      .header('Cache-Control', 'no-store')
      .send({ required: sessions.required, authenticated: authenticated(request.headers.cookie) })
  );
  app.post('/api/session', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      sessions.checkLoginAllowed();
      const b = record(request.body);
      fields(b, ['token']);
      const value = text(b.token, 'token', 1000);
      const session = sessions.login(value);
      if (session.revoked) options.onAuthChanged?.();
      reply.header('Set-Cookie', session.cookie);
      return { required: sessions.required, authenticated: true };
    } catch (error) {
      if (error instanceof AccessSessionRateLimitError)
        reply.header('Retry-After', String(error.retryAfterSeconds));
      throw error;
    }
  });
  app.delete('/api/session', async (request, reply) => {
    const cookie = sessions.logout(request.headers.cookie);
    options.onAuthChanged?.();
    reply.header('Cache-Control', 'no-store').header('Set-Cookie', cookie);
    return { required: sessions.required, authenticated: !sessions.required };
  });
  app.get<{ Querystring: { view?: string } }>('/api/library', async (request) => {
    if (request.query.view !== undefined && request.query.view !== 'summary')
      throw new HttpError(400, 'Invalid library view');
    return product.library(request.query.view === 'summary');
  });
  app.get('/api/provider-management/definitions', async () => PROVIDER_DEFINITIONS);
  app.post('/api/provider-management/endpoint-status', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const b = record(request.body);
    fields(b, ['protocol', 'endpoint']);
    if (!PROVIDER_PROTOCOLS.includes(b.protocol as ProviderProtocol))
      throw new HttpError(400, 'Unsupported protocol');
    const protocol = b.protocol as ProviderProtocol,
      endpoint = text(b.endpoint, 'endpoint', 2048);
    try {
      validateProviderEndpoint(protocol, endpoint);
      const url = new URL(endpoint);
      if (url.username || url.password || url.search || url.hash)
        return { status: 'invalid', origin: null };
      if (protocol === 'codex-app-server-v1') return { status: 'local', origin: null };
      return {
        status:
          providerOriginApproval(protocol, endpoint, options.approvedOrigins) ?? 'needs-approval',
        origin: url.origin,
      };
    } catch {
      return { status: 'invalid', origin: null };
    }
  });
  app.post(
    '/api/provider-management/vertex-credentials',
    { bodyLimit: 70 * 1024 },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const b = record(request.body);
      fields(b, ['serviceAccount']);
      if (Buffer.byteLength(JSON.stringify(b.serviceAccount ?? null), 'utf8') > 64 * 1024)
        throw new HttpError(400, 'Service account JSON is too large');
      if (!options.credentials) throw new HttpError(503, 'Service account storage unavailable');
      return options.credentials.upload(b.serviceAccount);
    }
  );
  app.get<{ Params: { id: string } }>(
    '/api/provider-management/connections/:id/readiness',
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const connection = product.get<Connection>('connection', request.params.id);
      const agent =
        connection.protocol === 'codex-app-server-v1' ? await options.codex?.status() : undefined;
      return readiness(product, connection, options.approvedOrigins, options.credentials, agent);
    }
  );
  app.get<{ Params: { kind: string; id: string } }>(
    '/api/provider-management/:kind/:id/impact',
    async (request) => {
      if (request.params.kind !== 'connection' && request.params.kind !== 'model')
        throw new HttpError(404, 'Unsupported management kind');
      return managementImpact(product, request.params.kind, request.params.id);
    }
  );
  app.get<{ Params: { id: string } }>('/api/content/:id', async (request) =>
    product.get('content', request.params.id)
  );
  app.get<{ Params: { id: string } }>('/api/prompt-presets/:id', async (request) =>
    product.get('prompt-preset', request.params.id)
  );
  app.post('/api/content', { bodyLimit: 5_000_000 }, async (request) =>
    product.content(request.body)
  );
  app.put<{ Params: { id: string } }>(
    '/api/content/:id',
    { bodyLimit: 5_000_000 },
    async (request) => product.content(request.body, request.params.id)
  );
  app.post('/api/prompt-combinations', async (request) => product.promptCombination(request.body));
  app.post('/api/prompt-presets', async (request) => product.promptPreset(request.body));
  app.put<{ Params: { id: string } }>('/api/prompt-presets/:id', async (request) =>
    product.promptPreset(request.body, request.params.id)
  );
  app.post('/api/connections', async (request) => {
    const prepared = product.prepareConnection(request.body);
    options.credentials?.validate(prepared.value);
    return product.connection(request.body);
  });
  app.put<{ Params: { id: string } }>('/api/connections/:id', async (request) => {
    const prepared = product.prepareConnection(request.body, request.params.id);
    options.credentials?.validate(prepared.value);
    return product.connection(request.body, request.params.id);
  });
  app.post('/api/model-presets', async (request) => product.model(request.body));
  app.put<{ Params: { id: string } }>('/api/model-presets/:id', async (request) =>
    product.model(request.body, request.params.id)
  );
  app.get<{ Params: { kind: string; id: string; revision: string } }>(
    '/api/revisions/:kind/:id/:revision',
    async (request) => {
      if (!['content', 'prompt-preset'].includes(request.params.kind))
        throw new HttpError(404, 'Revision kind not found');
      return product.get(
        request.params.kind,
        request.params.id,
        number(Number(request.params.revision), 'revision')
      );
    }
  );
  app.post<{ Params: { id: string } }>('/api/connections/:id/catalog', async (request) => {
    const b = record(request.body ?? {});
    fields(b, []);
    const previous = product.get<Connection>('connection', request.params.id);
    let error: string | null = null;
    let catalog = previous.catalog;
    try {
      if (previous.protocol === 'codex-app-server-v1') {
        product.authorize(previous);
        if (!options.codex) throw new Error('Codex unavailable');
        catalog = await options.codex.catalog();
        product.authorize(previous);
      } else if (previous.protocol === 'vertex-gemini-v1') {
        // This is the adapter's local support list, not a provider availability probe.
        validateVertexEndpoint(previous.endpoint);
        catalog = supportedModels('vertex-gemini-v1').map((model) => ({
          id: model.id,
          name: model.name,
          capabilities: { tools: true, structuredOutput: null },
          priceRevision: null,
        }));
      } else {
        product.authorize(previous);
        const c = validateConnection(
          {
            id: previous.id,
            protocol: previous.protocol,
            endpoint: previous.endpoint,
            ...(previous.credentialEnv ? { credentialEnv: previous.credentialEnv } : {}),
          },
          options.approvedOrigins
        );
        const credential = c.credentialEnv ? process.env[c.credentialEnv] : undefined;
        if (
          (c.credentialEnv ||
            ['openai-responses-v1', 'anthropic-messages-v1'].includes(c.protocol)) &&
          (!credential || /[\r\n]/.test(credential))
        )
          throw new Error('Credential unavailable');
        const headers: Record<string, string> = { Accept: 'application/json' };
        if (c.protocol === 'anthropic-messages-v1') {
          headers['anthropic-version'] = '2023-06-01';
          headers['x-api-key'] = credential!;
        } else if (credential) headers.Authorization = 'Bearer ' + credential;
        const url =
          c.protocol === 'fixture-sse-v1'
            ? new URL('models', c.endpoint)
            : new URL(c.endpoint.replace(/\/$/u, '') + '/models');
        if (c.protocol === 'anthropic-messages-v1') url.searchParams.set('limit', '1000');
        const signal = AbortSignal.timeout(5000);
        const collected: Connection['catalog'] = [];
        const ids = new Set<string>();
        let totalSize = 0;
        for (let page = 0; page < 5; page++) {
          product.authorize(previous);
          const response = await fetch(url, { method: 'GET', signal, redirect: 'error', headers });
          if (!response.ok || !response.body) throw new Error('Catalog unavailable');
          const reader = response.body.getReader();
          const parts: Uint8Array[] = [];
          const abort = () => {
            void reader.cancel().catch(() => {});
          };
          signal.addEventListener('abort', abort, { once: true });
          try {
            if (signal.aborted) throw new Error('Catalog timeout');
            while (true) {
              const next = await reader.read();
              if (signal.aborted) throw new Error('Catalog timeout');
              if (next.done) break;
              totalSize += next.value.length;
              if (totalSize > 1000000) throw new Error('Catalog too large');
              parts.push(next.value);
            }
          } finally {
            signal.removeEventListener('abort', abort);
            await reader.cancel().catch(() => {});
            reader.releaseLock();
          }
          const body = JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts))
          );
          if (c.protocol === 'fixture-sse-v1') {
            collected.push(
              ...parseCatalog(body).map((m) => ({
                id: m.id,
                name: m.label,
                capabilities: m.capabilities,
                priceRevision: m.pricing.revision,
              }))
            );
            break;
          }
          const payload = record(body);
          if (!Array.isArray(payload.data) || collected.length + payload.data.length > 5000)
            throw new Error('Invalid model catalog');
          for (const item of payload.data) {
            const model = record(item);
            const id = text(model.id, 'model ID', 300);
            const name = text(model.display_name ?? model.name ?? id, 'model name', 400);
            if (ids.has(id)) throw new Error('Duplicate model ID');
            ids.add(id);
            collected.push({
              id,
              name,
              capabilities: { tools: null, structuredOutput: null },
              priceRevision: null,
            });
          }
          if (
            c.protocol !== 'anthropic-messages-v1' ||
            payload.has_more === false ||
            payload.has_more === undefined
          )
            break;
          if (payload.has_more !== true || payload.data.length === 0 || page === 4)
            throw new Error('Incomplete model catalog');
          const cursor = text(payload.last_id, 'model cursor', 300);
          if (cursor !== payload.data.at(-1).id) throw new Error('Invalid model cursor');
          url.searchParams.set('after_id', cursor);
        }
        catalog = collected;
      }
    } catch {
      error = 'CATALOG_UNAVAILABLE';
    }
    return product.save(
      'connection',
      {
        ...previous,
        catalog,
        catalogError: error,
        catalogUpdatedAt: error ? (previous.catalogUpdatedAt ?? null) : new Date().toISOString(),
      },
      previous.id,
      previous.revision
    );
  });
  app.get<{ Params: { id: string } }>('/api/chats/:id/profile', async (request) =>
    product.profile(request.params.id)
  );
  app.put<{ Params: { id: string } }>('/api/chats/:id/profile', async (request) => {
    const p = product.updateProfile(request.params.id, request.body);
    options.publish(p.chatId);
    return p;
  });
  app.post<{ Params: { id: string } }>('/api/chats/:id/branches', async (request) => {
    const branch = product.createBranch(request.params.id, request.body);
    options.publish(branch.chatId);
    return branch;
  });
  app.post<{ Params: { id: string } }>('/api/runs/:id/issue', async (request) => {
    const b = record(request.body);
    fields(b, ['note']);
    const run = store.run(request.params.id);
    store.db
      .prepare('UPDATE runs SET issue=? WHERE id=?')
      .run(text(b.note, 'issue note', 4000), run.id);
    store.event(run.chatId, 'run.issue', run.id);
    options.publish(run.chatId);
    return store.run(run.id);
  });
  app.post<{ Params: { id: string } }>('/api/chats/:id/assets', async (request) => {
    const asset = product.createAsset(request.params.id, request.body);
    store.event(asset.chatId, 'asset.created', asset.id);
    options.publish(asset.chatId);
    return asset;
  });
  app.get<{ Params: { id: string } }>('/api/assets/:id', async (request, reply) => {
    const a = product.asset(request.params.id);
    return reply
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'private, max-age=86400')
      .type(a.asset.mime)
      .send(a.bytes);
  });
  app.get('/api/export', async (_request, reply) =>
    reply
      .header('Content-Disposition', 'attachment; filename="narrative-archive.json"')
      .send(product.export())
  );
  app.get('/api/backup', async (_request, reply) =>
    reply
      .header('Content-Disposition', 'attachment; filename="narrative-backup.sqlite"')
      .type('application/vnd.sqlite3')
      .send(product.backup())
  );
  app.get('/api/import/status', async (_request, reply) =>
    reply.header('Cache-Control', 'no-store').send(product.importStatus())
  );
  app.post('/api/import', { bodyLimit: 64 * 1024 * 1024 }, async (request) => {
    const b = record(request.body);
    fields(b, ['archive']);
    return product.import(b.archive);
  });
  return { authenticated };
}
