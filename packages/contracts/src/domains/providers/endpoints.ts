import { defineEndpoint } from '../../endpoint.js';
import type { providerOperations as operations } from './operations.js';

const codex = '/agent-runtimes/codex';
const jev = '/provider-management/jev';

export const providerEndpoints = {
  readCodexRuntime: defineEndpoint<typeof operations.readCodexRuntime>()({
    operation: 'providers.readCodexRuntime',
    method: 'GET',
    path: codex,
    cache: 'no-store',
  }),
  startCodexLogin: defineEndpoint<typeof operations.startCodexLogin>()({
    operation: 'providers.startCodexLogin',
    method: 'POST',
    path: `${codex}/login`,
    cache: 'no-store',
  }),
  cancelCodexLogin: defineEndpoint<typeof operations.cancelCodexLogin>()({
    operation: 'providers.cancelCodexLogin',
    method: 'POST',
    path: `${codex}/login/cancel`,
    cache: 'no-store',
  }),
  signOutCodex: defineEndpoint<typeof operations.signOutCodex>()({
    operation: 'providers.signOutCodex',
    method: 'DELETE',
    path: `${codex}/session`,
    cache: 'no-store',
  }),
  readJev: defineEndpoint<typeof operations.readJev>()({
    operation: 'providers.readJev',
    method: 'GET',
    path: jev,
    cache: 'no-store',
  }),
  saveJevKey: defineEndpoint<typeof operations.saveJevKey>()({
    operation: 'providers.saveJevKey',
    method: 'PUT',
    path: jev,
    bodyLimit: 8192,
    cache: 'no-store',
  }),
  deleteJevKey: defineEndpoint<typeof operations.deleteJevKey>()({
    operation: 'providers.deleteJevKey',
    method: 'DELETE',
    path: jev,
    cache: 'no-store',
  }),
  updateJevSettings: defineEndpoint<typeof operations.updateJevSettings>()({
    operation: 'providers.updateJevSettings',
    method: 'PUT',
    path: `${jev}/settings`,
    cache: 'no-store',
  }),
  startJevTest: defineEndpoint<typeof operations.startJevTest>()({
    operation: 'providers.startJevTest',
    method: 'POST',
    path: `${jev}/test`,
    status: 202,
    cache: 'no-store',
  }),
  startModelTest: defineEndpoint<typeof operations.startModelTest>()({
    operation: 'providers.startModelTest',
    method: 'POST',
    path: '/provider-management/models/:id/test',
    status: 202,
    cache: 'no-store',
  }),
  readConnectionTest: defineEndpoint<typeof operations.readConnectionTest>()({
    operation: 'providers.readConnectionTest',
    method: 'GET',
    path: '/provider-management/tests/:id',
    cache: 'no-store',
  }),
  validateVertexCredential: defineEndpoint<typeof operations.validateVertexCredential>()({
    operation: 'providers.validateVertexCredential',
    method: 'POST',
    path: '/provider-management/vertex-credentials/validate',
    bodyLimit: 70 * 1024,
    cache: 'no-store',
  }),
};
