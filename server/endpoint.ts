import type { FastifyInstance, FastifyReply, FastifyRequest, RouteOptions } from 'fastify';
import type { z } from 'zod/v4';
import {
  type AnyOperation,
  type AnySplitOperation,
  type Endpoint,
  endpointInput,
  type HttpMethod,
  type Operation,
  type PathCheck,
} from '#contracts';
import { type Command, executeOperation, parseInput } from './command.js';
import type { AppPorts } from './store-ports.js';

export type RouteKind = 'endpoint' | 'command' | 'raw';
export type RawRouteCache = 'no-store' | 'no-store-refusals';

declare module 'fastify' {
  interface FastifyContextConfig {
    admission?: Endpoint['admission'];
    cache?: Endpoint['cache'] | RawRouteCache;
    routeKind?: RouteKind;
  }
}

const checkOutputs = 'uimoriCheckEndpointOutputs';

export const NOT_MODIFIED = Symbol('notModified');

export { parseInput };

export function checkEndpointOutputs(app: FastifyInstance): void {
  app.decorate(checkOutputs, true);
}

// https://www.rfc-editor.org/rfc/rfc7240.html#section-4.2 (2026-11-20): `Prefer: return=minimal`
// asks for only a minimal response to a successful request; what counts as minimal is at the
// server's discretion.
export const prefersMinimal = (prefer: unknown): boolean =>
  /(?:^|[\s,;])return=minimal(?:$|[\s,;])/u.test(String(prefer ?? ''));

async function noStore(_request: FastifyRequest, reply: FastifyReply, payload: unknown) {
  reply.header('Cache-Control', 'no-store');
  return payload;
}

async function noStoreRefusals(_request: FastifyRequest, reply: FastifyReply, payload: unknown) {
  if (reply.statusCode >= 400) reply.header('Cache-Control', 'no-store');
  return payload;
}

export const endpointUrl = (endpoint: Endpoint<AnyOperation>): string => `/api${endpoint.path}`;

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

export function registerCommand<Op extends AnySplitOperation, P extends Pick<AppPorts, 'tx'>>(
  app: FastifyInstance,
  endpoint: Endpoint<Op>,
  command: Command<Op, P>,
  ports: P
): void {
  const checked = app.hasDecorator(checkOutputs);
  app.route({
    method: endpoint.method,
    url: endpointUrl(endpoint),
    config: { admission: endpoint.admission, cache: endpoint.cache, routeKind: 'command' },
    ...(endpoint.bodyLimit === undefined ? {} : { bodyLimit: endpoint.bodyLimit }),
    ...(endpoint.cache === 'no-store' ? { onSend: noStore } : {}),
    handler: async (request, reply) => {
      const controller = new AbortController();
      const abort = () => {
        if (!reply.raw.writableEnded) controller.abort();
      };
      if (reply.raw.destroyed && !reply.raw.writableEnded) controller.abort();
      else reply.raw.once('close', abort);
      try {
        const output = await executeOperation(command, ports, endpointInput(endpoint, request), {
          signal: controller.signal,
          checkOutputs:
            checked && (!endpoint.preferMinimal || prefersMinimal(request.headers.prefer)),
        });
        if (endpoint.status !== undefined) reply.code(endpoint.status);
        return output;
      } finally {
        reply.raw.off('close', abort);
      }
    },
  });
}

export type RawRouteOptions<U extends `/api/${string}` = `/api/${string}`> = {
  readonly method: HttpMethod;
  readonly url: U;
  readonly cache: RawRouteCache;
  readonly admission?: Endpoint['admission'];
  readonly bodyLimit?: number;
  readonly compress?: RouteOptions['compress'];
};

export function registerRawRoute<const U extends `/api/${string}`, S extends z.ZodType>(
  app: FastifyInstance,
  route: RawRouteOptions<U> & { readonly input: S } & PathCheck<U, z.input<S>>,
  handler: (input: z.output<S>, request: FastifyRequest, reply: FastifyReply) => unknown
): void;
export function registerRawRoute(
  app: FastifyInstance,
  route: RawRouteOptions & { readonly input?: undefined },
  handler: (input: undefined, request: FastifyRequest, reply: FastifyReply) => unknown
): void;
export function registerRawRoute(
  app: FastifyInstance,
  route: RawRouteOptions & { readonly input?: z.ZodType },
  handler: (input: never, request: FastifyRequest, reply: FastifyReply) => unknown
): void {
  app.route({
    method: route.method,
    url: route.url,
    config: {
      ...(route.admission === undefined ? {} : { admission: route.admission }),
      cache: route.cache,
      routeKind: 'raw',
    },
    ...(route.bodyLimit === undefined ? {} : { bodyLimit: route.bodyLimit }),
    ...(route.compress === undefined ? {} : { compress: route.compress }),
    onSend: route.cache === 'no-store' ? noStore : noStoreRefusals,
    handler: async (request, reply) =>
      handler(
        (route.input ? parseInput(route.input, endpointInput(route, request)) : undefined) as never,
        request,
        reply
      ),
  });
}
