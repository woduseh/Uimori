import type { FastifyInstance } from 'fastify';
import type { Store } from './store.js';
import type { ResourceKind, ResourceModel } from '../core/resource-editing.js';
import { choice, fields, HttpError, number, record, text } from './request-validation.js';
import { cloneResource, readResource, saveResource, undoResource } from './resource-service.js';

const kinds = ['content', 'prompt-preset', 'prompt-workspace', 'theme', 'illustration-preset'];
export function resourceKind(value: unknown): ResourceKind {
  if (!kinds.includes(String(value))) throw new HttpError(400, '자료 종류를 확인해 주세요.');
  return value as ResourceKind;
}

export function resourceRoutes(app: FastifyInstance, store: Store) {
  app.get<{ Params: { kind: string; id: string } }>('/api/resources/:kind/:id', (request) =>
    readResource(store, resourceKind(request.params.kind), request.params.id)
  );
  app.post('/api/resources/clone', (request) => {
    const body = record(request.body);
    fields(body, ['kind', 'sourceId', 'expectedSourceRevision', 'title', 'syncNativeName']);
    if (body.syncNativeName !== undefined && typeof body.syncNativeName !== 'boolean')
      throw new HttpError(400, '내부 이름 동기화 옵션을 확인해 주세요.');
    return cloneResource(store, {
      kind: choice(body.kind, ['content', 'prompt-preset'], 'clone resource kind'),
      sourceId: text(body.sourceId, 'source ID', 100),
      expectedSourceRevision: number(body.expectedSourceRevision, 'source revision'),
      title: text(body.title, 'title', 200),
      ...(body.syncNativeName === undefined ? {} : { syncNativeName: body.syncNativeName }),
    });
  });
  app.post('/api/resources/save', { bodyLimit: 48 * 1024 * 1024 }, (request) => {
    const body = record(request.body);
    fields(body, ['kind', 'id', 'expectedRevision', 'model']);
    return saveResource(store, {
      kind: resourceKind(body.kind),
      id: body.id == null ? null : text(body.id, 'resource ID', 100),
      expectedRevision:
        body.expectedRevision === undefined ? undefined : number(body.expectedRevision, 'revision'),
      model: record(body.model) as ResourceModel,
    });
  });
  app.post<{ Params: { kind: string; id: string } }>('/api/resources/:kind/:id/undo', (request) => {
    const body = record(request.body);
    fields(body, ['expectedRevision']);
    return undoResource(
      store,
      resourceKind(request.params.kind),
      request.params.id,
      number(body.expectedRevision, 'revision')
    );
  });
}
