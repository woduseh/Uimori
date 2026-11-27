import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod/v4';
import { type Endpoint, endpointInput, type Operation } from '#contracts';
import { AppError } from './app-errors.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    admission?: Endpoint['admission'];
    cache?: Endpoint['cache'];
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
    config: { admission: endpoint.admission, cache: endpoint.cache },
    ...(endpoint.bodyLimit === undefined ? {} : { bodyLimit: endpoint.bodyLimit }),
    ...(endpoint.cache === 'no-store'
      ? {
          onSend: async (_request: FastifyRequest, reply: FastifyReply, payload: unknown) => {
            reply.header('Cache-Control', 'no-store');
            return payload;
          },
        }
      : {}),
    handler: async (request, reply) => {
      const output = await handler(
        parseInput<Op['input']>(operation.input, endpointInput(endpoint, request)),
        request,
        reply
      );
      if (output === NOT_MODIFIED) return reply.code(304).send();
      if (checked) operation.output.parse(output);
      if (endpoint.status !== undefined) reply.code(endpoint.status);
      return output;
    },
  });
}
