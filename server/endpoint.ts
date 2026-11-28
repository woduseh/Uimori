import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod/v4';
import { type Endpoint, endpointInput, type Operation } from '#contracts';
import { AppError } from './app-errors.js';

export type RouteKind = 'endpoint';

declare module 'fastify' {
  interface FastifyContextConfig {
    admission?: Endpoint['admission'];
    cache?: Endpoint['cache'];
    routeKind?: RouteKind;
  }
}

const checkOutputs = 'uimoriCheckEndpointOutputs';

export const NOT_MODIFIED = Symbol('notModified');

export function checkEndpointOutputs(app: FastifyInstance): void {
  app.decorate(checkOutputs, true);
}

export function parseInput<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const error = new AppError(400, 'INVALID_REQUEST');
  error.message = `INVALID_REQUEST: ${parsed.error.issues
    .map((issue) => `${issue.path.map(String).join('.') || 'input'}: ${issue.message}`)
    .join('; ')}`;
  throw error;
}

// https://www.rfc-editor.org/rfc/rfc7240.html#section-4.2 (2026-11-20): `Prefer: return=minimal`
// asks for only a minimal response to a successful request; what counts as minimal is at the
// server's discretion.
export const prefersMinimal = (prefer: unknown): boolean =>
  /(?:^|[\s,;])return=minimal(?:$|[\s,;])/u.test(String(prefer ?? ''));

export async function noStore(_request: FastifyRequest, reply: FastifyReply, payload: unknown) {
  reply.header('Cache-Control', 'no-store');
  return payload;
}

export async function noStoreRefusals(
  _request: FastifyRequest,
  reply: FastifyReply,
  payload: unknown
) {
  if (reply.statusCode >= 400) reply.header('Cache-Control', 'no-store');
  return payload;
}

export const endpointUrl = (endpoint: Endpoint): string => `/api${endpoint.path}`;

type Output<Op extends Operation> = z.output<Op['output']> | typeof NOT_MODIFIED;

export function registerEndpoint<Op extends Operation>(
  app: FastifyInstance,
  endpoint: Endpoint<Op>,
  operation: Op,
  handler: (
    input: z.output<Op['input']>,
    request: FastifyRequest,
    reply: FastifyReply
  ) => Output<Op> | Promise<Output<Op>>
): void {
  const checked = app.hasDecorator(checkOutputs);
  app.route({
    method: endpoint.method,
    url: endpointUrl(endpoint),
    config: { admission: endpoint.admission, cache: endpoint.cache, routeKind: 'endpoint' },
    ...(endpoint.bodyLimit === undefined ? {} : { bodyLimit: endpoint.bodyLimit }),
    ...(endpoint.cache === 'no-store' ? { onSend: noStore } : {}),
    handler: async (request, reply) => {
      const output = await handler(
        parseInput<Op['input']>(operation.input, endpointInput(endpoint, request)),
        request,
        reply
      );
      if (output === NOT_MODIFIED) return reply.code(304).send();
      if (checked && (!endpoint.preferMinimal || prefersMinimal(request.headers.prefer)))
        operation.output.parse(output);
      if (endpoint.status !== undefined) reply.code(endpoint.status);
      return output;
    },
  });
}
