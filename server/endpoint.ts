import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { type Endpoint, endpointInput, type Operation } from '#contracts';
import { AppError } from './app-errors.js';

const checkOutputs = 'uimoriCheckEndpointOutputs';

export function checkEndpointOutputs(app: FastifyInstance): void {
  app.decorate(checkOutputs, true);
}

export function parseInput<S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const error = new AppError(400, 'INVALID_REQUEST');
  error.message = `INVALID_REQUEST: ${parsed.error.issues
    .map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`)
    .join('; ')}`;
  throw error;
}

export function registerEndpoint<Op extends Operation>(
  app: FastifyInstance,
  endpoint: Endpoint<Op>,
  operation: Op,
  handler: (
    input: z.output<Op['input']>,
    request: FastifyRequest,
    reply: FastifyReply
  ) => z.output<Op['output']> | Promise<z.output<Op['output']>>
): void {
  const checked = app.hasDecorator(checkOutputs);
  app.route({
    method: endpoint.method,
    url: `/api${endpoint.path}`,
    ...(endpoint.bodyLimit === undefined ? {} : { bodyLimit: endpoint.bodyLimit }),
    handler: async (request, reply) => {
      const output = await handler(
        parseInput(operation.input, endpointInput(endpoint, request)),
        request,
        reply
      );
      if (checked) operation.output.parse(output);
      if (endpoint.status !== undefined) reply.code(endpoint.status);
      return output;
    },
  });
}
