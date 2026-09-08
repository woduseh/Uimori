import { HttpError, fields, record } from './request-validation.js';
import type { FastifyInstance } from 'fastify';
import type { CodexRuntimeService } from './codex-runtime.js';
import { ProviderContractError } from '../core/transport.js';
import { CodexProcessError } from './codex-process.js';

/** Shares the app's authenticated API/Origin boundary; accepts no tokens or commands. */
export function agentRuntimeRoutes(app: FastifyInstance, runtime: CodexRuntimeService) {
  app.get('/api/agent-runtimes/codex', async (_request, reply) =>
    reply.header('Cache-Control', 'no-store').send(await runtime.status())
  );
  for (const [path, action] of [
    ['login', () => runtime.login()],
    ['login/cancel', () => runtime.cancelLogin()],
  ] as const) {
    app.post(`/api/agent-runtimes/codex/${path}`, async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      fields(record(request.body ?? {}), []);
      try {
        return await action();
      } catch (error) {
        throw safeFailure(error);
      }
    });
  }
  app.delete('/api/agent-runtimes/codex/session', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    fields(record(request.body ?? {}), []);
    try {
      return await runtime.logout();
    } catch (error) {
      throw safeFailure(error);
    }
  });
}
function safeFailure(error: unknown): HttpError {
  const code =
    error instanceof ProviderContractError || error instanceof CodexProcessError
      ? error.message
      : 'CODEX_UNAVAILABLE';
  return new HttpError(code === 'CODEX_BUSY' || code === 'CODEX_AUTH_BUSY' ? 409 : 503, code);
}
