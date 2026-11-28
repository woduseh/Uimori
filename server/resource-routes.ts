import type { FastifyInstance } from 'fastify';
import { resourceEditorEndpoints as endpoints } from '#contracts';
import { resourceEditorOperations as operations } from '#contracts/operations';
import type { ResourceModel } from '../core/resource-editing.js';
import type { Store } from './store.js';
import { registerEndpoint } from './endpoint.js';
import {
  cloneResource,
  readPreviousResource,
  readResource,
  saveResource,
  undoResource,
} from './resource-service.js';

export function resourceRoutes(app: FastifyInstance, store: Store, publishAll: () => void) {
  const published = <T>(result: T) => {
    publishAll();
    return result;
  };
  registerEndpoint(app, endpoints.readResource, operations.readResource, ({ kind, id }) =>
    readResource(store, kind, id)
  );
  registerEndpoint(app, endpoints.cloneResource, operations.cloneResource, (input) =>
    published(cloneResource(store, input))
  );
  registerEndpoint(app, endpoints.saveResource, operations.saveResource, (input) =>
    published(
      saveResource(store, {
        ...input,
        id: input.id ?? null,
        model: input.model as ResourceModel,
      })
    )
  );
  registerEndpoint(
    app,
    endpoints.readPreviousResource,
    operations.readPreviousResource,
    ({ kind, id }) => {
      readResource(store, kind, id);
      return readPreviousResource(store, kind, id);
    }
  );
  registerEndpoint(
    app,
    endpoints.undoResource,
    operations.undoResource,
    ({ kind, id, expectedRevision }) => published(undoResource(store, kind, id, expectedRevision))
  );
}
