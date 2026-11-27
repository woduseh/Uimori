import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

export const REVALIDATED_ROUTES: ReadonlySet<string> = new Set([
  '/api/activity-feed',
  '/api/library',
  '/api/chats',
  '/api/chats/:id/reader',
  '/api/connections/:id/catalog',
]);

export function matchesEntityTag(header: string | string[] | undefined, etag: string) {
  if (header === undefined) return false;
  const opaque = etag.replace(/^W\//u, '');
  return String(header)
    .split(',')
    .some((candidate) => {
      const value = candidate.trim();
      return value === '*' || value.replace(/^W\//u, '') === opaque;
    });
}

export function revalidatePrivateJson(app: FastifyInstance) {
  app.addHook('onSend', (request, reply, payload, done) => {
    if (
      request.method !== 'GET' ||
      reply.statusCode !== 200 ||
      (request.routeOptions.config.cache !== 'revalidate' &&
        !REVALIDATED_ROUTES.has(request.routeOptions.url ?? '')) ||
      (typeof payload !== 'string' && !Buffer.isBuffer(payload))
    )
      return done(null, payload);
    const etag = `W/"${createHash('sha256').update(payload).digest('base64url')}"`;
    reply.header('ETag', etag).header('Cache-Control', 'private, no-cache');
    if (!matchesEntityTag(request.headers['if-none-match'], etag)) return done(null, payload);
    reply.code(304);
    done(null, null);
  });
}
