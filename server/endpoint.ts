import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod/v4';
import {
  type AnyOperation,
  type Endpoint,
  endpointInput,
  type Operation,
  type SplitOperation,
} from '#contracts';
import { type Command, executeOperation, NOT_MODIFIED, parseInput, type Query } from './command.js';
import type { AppPorts } from './store-ports.js';

export type RouteKind = 'endpoint';

declare module 'fastify' {
  interface FastifyContextConfig {
    admission?: Endpoint['admission'];
    cache?: Endpoint['cache'];
    routeKind?: RouteKind;
  }
}

const checkOutputs = 'uimoriCheckEndpointOutputs';

export { NOT_MODIFIED, parseInput };

export function checkEndpointOutputs(app: FastifyInstance): void {
  app.decorate(checkOutputs, true);
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

export const endpointUrl = (endpoint: Endpoint<AnyOperation>): string => `/api${endpoint.path}`;

type Output<Op extends Operation> = z.output<Op['output']> | typeof NOT_MODIFIED;

function responseStatus<Op extends AnyOperation>(
  endpoint: Endpoint<Op>,
  output: unknown
): number | undefined {
  if (endpoint.status === undefined) return undefined;
  return typeof endpoint.status === 'function' ? endpoint.status(output as never) : endpoint.status;
}

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
      const status = responseStatus(endpoint, output);
      if (status !== undefined) reply.code(status);
      return output;
    },
  });
}

export function registerCommand<
  Op extends SplitOperation<any, any, any, any, any, any>,
  P extends Pick<AppPorts, 'tx'>,
>(app: FastifyInstance, endpoint: Endpoint<Op>, target: Command<Op, P>, ports: P): void;
export function registerCommand<Op extends SplitOperation<any, any, any, any, any, any>, P>(
  app: FastifyInstance,
  endpoint: Endpoint<Op>,
  target: Query<Op, P>,
  ports: P
): void;
export function registerCommand<Op extends SplitOperation<any, any, any, any, any, any>, P>(
  app: FastifyInstance,
  endpoint: Endpoint<Op>,
  target: Command<Op, P & Pick<AppPorts, 'tx'>> | Query<Op, P>,
  ports: P
): void {
  const checked = app.hasDecorator(checkOutputs);
  app.route({
    method: endpoint.method,
    url: endpointUrl(endpoint),
    config: { admission: endpoint.admission, cache: endpoint.cache },
    ...(endpoint.bodyLimit === undefined ? {} : { bodyLimit: endpoint.bodyLimit }),
    ...(endpoint.cache === 'no-store' ? { onSend: noStore } : {}),
    handler: async (request, reply) => {
      const controller = new AbortController();
      const abort = () => controller.abort();
      request.raw.once('close', abort);
      try {
        const check =
          checked && (!endpoint.preferMinimal || prefersMinimal(request.headers.prefer));
        const output =
          target.kind === 'command'
            ? await executeOperation(
                target,
                ports as P & Pick<AppPorts, 'tx'>,
                endpointInput(endpoint, request),
                { signal: controller.signal, checkOutputs: check }
              )
            : await executeOperation(target, ports, endpointInput(endpoint, request), {
                signal: controller.signal,
                checkOutputs: check,
              });
        if (output === NOT_MODIFIED) return reply.code(304).send();
        const status = responseStatus(endpoint, output);
        if (status !== undefined) reply.code(status);
        return output;
      } finally {
        request.raw.off('close', abort);
      }
    },
  });
}
