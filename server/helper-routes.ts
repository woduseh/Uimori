import type { OutlineTarget } from '../core/outline.js';
import type { FastifyInstance } from 'fastify';
import {
  HELPER_DECLINED_CALLS_LIMIT,
  type HelperScope,
  type HelperEditor,
} from '../core/helper.js';
import type { HelperRuntime } from './helper-runtime.js';
import { readHelperActivity } from './helper-activity.js';
import { readHelperContextState } from './helper-context.js';
import { parseHelperReferencePointers, searchHelperReferences } from './helper-references.js';
import { readHelperTaskResults } from './helper-task-results.js';
import { markHelperConversationRead } from './helper-read-state.js';
import { AppError } from './app-errors.js';
import { fields, HttpError, number, record, text } from './request-validation.js';
import { helperEndpoints } from '#contracts';
import { helperOperations } from '#contracts/operations';
import { registerEndpoint } from './endpoint.js';
import { REQUEST_TEXT_MAX_CHARS } from '../core/content-limits.js';
import { requestImageUploads } from './request-images.js';
import { requestFileUploads } from './request-files.js';
import { parseEditorFocus } from '../core/editor-focus.js';

function editorFocus(value: unknown) {
  try {
    return parseEditorFocus(value);
  } catch (cause) {
    throw new HttpError(400, (cause as Error).message);
  }
}

export function helperRoutes(app: FastifyInstance, runtime: HelperRuntime) {
  const store = runtime.workspace;
  const publicTask = (task: ReturnType<typeof store.task>) => {
    const { snapshot, ...view } = task;
    return { ...view, modelTitle: snapshot.model.title };
  };
  const publicArtifact = (artifact: ReturnType<typeof store.artifact>) => artifact;
  registerEndpoint(app, helperEndpoints.listProjects, helperOperations.listProjects, () =>
    store.groups()
  );
  registerEndpoint(
    app,
    helperEndpoints.createProject,
    helperOperations.createProject,
    ({ title, requestKey }) => store.createGroup(title.trim(), requestKey)
  );
  registerEndpoint(
    app,
    helperEndpoints.renameProject,
    helperOperations.renameProject,
    ({ id, expectedRevision, title }) => store.renameGroup(id, expectedRevision, title.trim())
  );
  registerEndpoint(
    app,
    helperEndpoints.deleteProject,
    helperOperations.deleteProject,
    ({ id, expectedRevision }) => store.deleteGroup(id, expectedRevision)
  );
  registerEndpoint(
    app,
    helperEndpoints.listConversations,
    helperOperations.listConversations,
    (input) =>
      store.list(
        input.kind === 'chat' ? { kind: 'chat', chatId: input.chatId } : { kind: input.kind }
      )
  );
  const readScope = (scope: HelperScope): HelperScope => {
    if (scope.kind === 'chat') runtime.store.chat(scope.chatId);
    return scope;
  };
  registerEndpoint(
    app,
    helperEndpoints.openConversation,
    helperOperations.openConversation,
    ({ scope }) => store.open(readScope(scope))
  );
  registerEndpoint(
    app,
    helperEndpoints.createConversation,
    helperOperations.createConversation,
    ({ scope, requestKey, title, projectId }) =>
      store.create(readScope(scope), `request:${requestKey}`, title, projectId)
  );
  registerEndpoint(
    app,
    helperEndpoints.moveConversation,
    helperOperations.moveConversation,
    ({ id, expectedRevision, projectId }) => store.moveGroup(id, expectedRevision, projectId)
  );
  registerEndpoint(
    app,
    helperEndpoints.copyConversation,
    helperOperations.copyConversation,
    ({ id, requestKey, expectedRevision, expectedEventSequence }) =>
      store.copy(id, requestKey, { expectedRevision, expectedEventSequence })
  );
  registerEndpoint(
    app,
    helperEndpoints.readConversation,
    helperOperations.readConversation,
    ({ id }) => store.conversation(id)
  );
  app.get<{ Params: { id: string } }>('/api/helper/conversations/:id/view', (request) => {
    const id = request.params.id;
    const eventCursor = store.latestEventSequence(id);
    return {
      eventCursor,
      conversation: store.conversation(id),
      messages: store.messages(id),
      tasks: store.taskSummaries(id),
      context: readHelperContextState(runtime.store, id, runtime.compactionRunning(id)),
    };
  });
  app.post<{ Params: { id: string } }>('/api/helper/conversations/:id/compact', (request) => {
    if (request.body !== undefined && request.body !== null) fields(record(request.body), []);
    return runtime.compactConversation(request.params.id);
  });
  app.delete<{ Params: { id: string } }>('/api/helper/conversations/:id/compact', (request) => {
    if (request.body !== undefined && request.body !== null) fields(record(request.body), []);
    return runtime.cancelCompaction(request.params.id);
  });
  registerEndpoint(
    app,
    helperEndpoints.readContextSummary,
    helperOperations.readContextSummary,
    ({ id }) => runtime.contextSummary(id)
  );
  registerEndpoint(
    app,
    helperEndpoints.editContextSummary,
    helperOperations.editContextSummary,
    ({ id, expectedRevision, summary }) => {
      if (!summary.trim()) throw new AppError(400, 'HELPER_SUMMARY_EMPTY');
      return runtime.editContextSummary(id, expectedRevision, summary);
    }
  );
  registerEndpoint(
    app,
    helperEndpoints.resetContextSummary,
    helperOperations.resetContextSummary,
    ({ id, expectedRevision }) => runtime.resetContextSummary(id, expectedRevision)
  );
  registerEndpoint(
    app,
    helperEndpoints.updateConversation,
    helperOperations.updateConversation,
    ({ id, expectedRevision, title, persona }) =>
      store.update(id, expectedRevision, {
        ...(title === undefined ? {} : { title }),
        ...(persona === undefined ? {} : { persona }),
      })
  );
  registerEndpoint(
    app,
    helperEndpoints.markConversationRead,
    helperOperations.markConversationRead,
    ({ id, activityEventSeq }) => markHelperConversationRead(runtime.store, id, activityEventSeq)
  );
  registerEndpoint(
    app,
    helperEndpoints.readConversationDeletion,
    helperOperations.readConversationDeletion,
    ({ id }) => runtime.deletionImpact(id)
  );
  registerEndpoint(
    app,
    helperEndpoints.deleteConversation,
    helperOperations.deleteConversation,
    ({ id, expectedRevision, expectedEventSequence }) =>
      runtime.deleteConversation(id, { expectedRevision, expectedEventSequence })
  );
  app.get<{ Params: { id: string }; Querystring: { q?: string } }>(
    '/api/helper/conversations/:id/references',
    (request) => {
      const conversation = store.conversation(request.params.id);
      const query = typeof request.query.q === 'string' ? request.query.q.slice(0, 120) : '';
      return searchHelperReferences(runtime.store, conversation.scope, query);
    }
  );
  app.get<{ Params: { id: string }; Querystring: { before?: string } }>(
    '/api/helper/conversations/:id/messages',
    (request) => store.messages(request.params.id, request.query.before)
  );
  app.get<{ Params: { id: string }; Querystring: { before?: string } }>(
    '/api/helper/conversations/:id/tasks',
    (request) => store.taskSummaries(request.params.id, request.query.before)
  );
  registerEndpoint(
    app,
    helperEndpoints.editMessage,
    helperOperations.editMessage,
    ({ id, messageId, expectedRevision, text }) =>
      runtime.editMessage(id, messageId, expectedRevision, text)
  );
  registerEndpoint(
    app,
    helperEndpoints.deleteMessages,
    helperOperations.deleteMessages,
    ({ id, messageId, expectedRevision, scope }) =>
      runtime.deleteMessages(id, messageId, expectedRevision, scope)
  );
  app.post<{ Params: { id: string } }>(
    '/api/helper/conversations/:id/messages',
    { bodyLimit: 48 * 1024 * 1024 },
    async (request) => {
      const body = record(request.body);
      fields(body, [
        'requestKey',
        'text',
        'editor',
        'selection',
        'retryOf',
        'resume',
        'outline',
        'references',
        'images',
        'files',
        'mode',
        'confirmations',
        'declinedConfirmations',
      ]);
      const references =
        body.references === undefined ? undefined : parseHelperReferencePointers(body.references);
      if (body.mode !== undefined && body.mode !== 'apply' && body.mode !== 'plan')
        throw new HttpError(400, 'Invalid helper mode');
      if (body.resume !== undefined && body.resume !== true)
        throw new HttpError(400, 'Invalid helper resume');
      if (
        body.confirmations !== undefined &&
        (!Array.isArray(body.confirmations) || body.confirmations.length > 16)
      )
        throw new HttpError(400, 'Invalid helper confirmations');
      const confirmations =
        body.confirmations === undefined
          ? undefined
          : (body.confirmations as unknown[]).map((id) => text(id, 'confirmation ID', 64));
      if (
        body.declinedConfirmations !== undefined &&
        (!Array.isArray(body.declinedConfirmations) ||
          body.declinedConfirmations.length > HELPER_DECLINED_CALLS_LIMIT)
      )
        throw new HttpError(400, 'Invalid declined helper confirmations');
      const declinedConfirmations =
        body.declinedConfirmations === undefined
          ? undefined
          : (body.declinedConfirmations as unknown[]).map((id) => text(id, 'confirmation ID', 64));
      let outline: OutlineTarget | undefined;
      if (body.outline !== undefined) {
        const selected = record(body.outline);
        fields(selected, ['nodeId', 'expectedRevision', 'purpose']);
        if (selected.purpose !== 'compose' && selected.purpose !== 'review')
          throw new HttpError(400, 'Invalid outline purpose');
        outline = {
          nodeId: selected.nodeId === null ? null : text(selected.nodeId, 'outline ID', 100),
          expectedRevision:
            selected.expectedRevision === null
              ? null
              : number(selected.expectedRevision, 'outline revision'),
          purpose: selected.purpose,
        };
      }
      let editor: HelperEditor | undefined;
      if (body.editor !== undefined) {
        const input = record(body.editor);
        fields(input, [
          'targetId',
          'revision',
          'title',
          'kind',
          'model',
          'source',
          'location',
          'focus',
        ]);
        const location = input.location === undefined ? undefined : record(input.location);
        if (location) {
          fields(location, ['path', 'label']);
          if (typeof location.path !== 'string' || !/^(\/|$)/u.test(location.path))
            throw new HttpError(400, 'Invalid editor location');
        }
        if (!['content', 'prompt-preset', 'prompt-workspace'].includes(input.kind))
          throw new HttpError(400, 'Invalid editor kind');
        if (input.source !== undefined && !['saved', 'unsaved'].includes(input.source))
          throw new HttpError(400, 'Invalid editor source');
        if (input.source === 'saved' && input.model !== undefined)
          throw new HttpError(400, 'A saved editor is sent by ID and revision, without a model');
        if (input.source === 'unsaved' && input.model === undefined)
          throw new HttpError(400, 'An unsaved editor needs its model');
        editor = {
          targetId: input.targetId === null ? null : text(input.targetId, 'resource ID', 100),
          revision: input.revision === null ? null : number(input.revision, 'revision'),
          title: text(input.title, 'editor title', 200, true),
          kind: input.kind,
          ...(input.source ? { source: input.source } : {}),
          ...(location
            ? {
                location: {
                  path: text(location.path, 'editor location', 1024, true),
                  ...(location.label === undefined
                    ? {}
                    : { label: text(location.label, 'editor location label', 200, true) }),
                },
              }
            : {}),
          ...(input.focus === undefined ? {} : { focus: editorFocus(input.focus) }),
          ...(input.model === undefined
            ? {}
            : {
                model: record(input.model) as import('../core/resource-editing.js').ResourceModel,
              }),
        };
      }
      return publicTask(
        await runtime.enqueueWithAttachments(
          request.params.id,
          text(body.requestKey, 'request key', 100),
          text(body.text, 'helper message', REQUEST_TEXT_MAX_CHARS, true),
          editor,
          body.selection === undefined
            ? undefined
            : (() => {
                const selection = record(body.selection);
                fields(selection, ['sourceId', 'sourceHash', 'text']);
                return {
                  sourceId: text(selection.sourceId, 'source ID', 100),
                  sourceHash: text(selection.sourceHash, 'source hash', 64),
                  text: text(selection.text, 'selected text', REQUEST_TEXT_MAX_CHARS),
                };
              })(),
          body.retryOf === undefined ? undefined : text(body.retryOf, 'retry task ID', 100),
          outline,
          { images: requestImageUploads(body.images), files: requestFileUploads(body.files) },
          true,
          {
            mode: body.mode,
            confirmations,
            declinedConfirmations,
            references,
            resume: body.resume === true,
          }
        )
      );
    }
  );
  app.get<{ Params: { id: string } }>('/api/helper/tasks/:id', (request) =>
    store.taskSummary(request.params.id)
  );
  app.get<{ Params: { id: string } }>('/api/helper/tasks/:id/activity', (request) =>
    readHelperActivity(runtime.store, request.params.id)
  );
  app.get<{ Params: { id: string } }>('/api/helper/tasks/:id/results', (request) =>
    readHelperTaskResults(runtime.store, request.params.id)
  );
  app.post<{ Params: { id: string } }>('/api/helper/tasks/:id/cancel', (request) =>
    publicTask(runtime.cancel(request.params.id))
  );
  app.post<{ Params: { id: string } }>(
    '/api/helper/tasks/:id/steer',
    { bodyLimit: 8 * 1024 * 1024 },
    (request) => {
      const body = record(request.body);
      fields(body, ['requestKey', 'text']);
      runtime.steer(
        request.params.id,
        text(body.requestKey, 'request key', 100),
        text(body.text, 'additional instruction', REQUEST_TEXT_MAX_CHARS)
      );
      return store.taskSummary(request.params.id);
    }
  );
  app.get<{ Params: { id: string }; Querystring: { after?: string } }>(
    '/api/helper/conversations/:id/events',
    (request) => {
      const after = request.query.after === undefined ? 0 : Number(request.query.after);
      number(after, 'event cursor', 0, Number.MAX_SAFE_INTEGER);
      return store.events(request.params.id, after, 'updates');
    }
  );
  app.get<{ Params: { id: string }; Querystring: { revision?: string } }>(
    '/api/helper/artifacts/:id',
    (request) =>
      publicArtifact(
        store.artifact(
          request.params.id,
          request.query.revision === undefined
            ? undefined
            : number(Number(request.query.revision), 'artifact revision')
        )
      )
  );
}
