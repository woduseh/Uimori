import type { FastifyInstance } from 'fastify';
import { providerEndpoints } from '#contracts';
import { providerOperations } from '#contracts/operations';
import { HttpError } from './request-validation.js';
import { AppError } from './app-errors.js';
import { registerEndpoint } from './endpoint.js';
import type { CodexRuntimeService } from './codex-runtime.js';
import { ProviderContractError } from '../core/transport.js';
import { CodexProcessError } from './codex-process.js';

export function agentRuntimeRoutes(app: FastifyInstance, runtime: CodexRuntimeService) {
  registerEndpoint(
    app,
    providerEndpoints.readCodexRuntime,
    providerOperations.readCodexRuntime,
    () => runtime.status()
  );
  for (const [name, action] of [
    ['startCodexLogin', () => runtime.login()],
    ['cancelCodexLogin', () => runtime.cancelLogin()],
    ['signOutCodex', () => runtime.logout()],
  ] as const)
    registerEndpoint(app, providerEndpoints[name], providerOperations[name], async () => {
      try {
        return await action();
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
  if (code === 'CODEX_AUTH_BUSY') return new AppError(409, 'CODEX_AUTH_BUSY');
  if (code === 'CODEX_BUSY') return new AppError(409, 'CODEX_RUNTIME_BUSY');
  return new HttpError(503, code);
}
