import type { OutlineTarget } from '../core/outline.js';
import type { FastifyInstance } from 'fastify';
import type { HelperScope, HelperEditor } from '../core/helper.js';
import type { HelperRuntime } from './helper-runtime.js';
import { lastHelperResourceEdit, undoHelperResourceEdit } from './helper-resource-undo.js';
import { readHelperActivity } from './helper-activity.js';
import { readHelperTaskResults } from './helper-task-results.js';
import { fields, HttpError, number, record, text } from './request-validation.js';
import { HELPER_PERSONA_MAX_CHARS, REQUEST_TEXT_MAX_CHARS } from '../core/content-limits.js';

export function helperRoutes(app: FastifyInstance, runtime: HelperRuntime) {
  const store = runtime.workspace;
  const publicTask = (task: ReturnType<typeof store.task>) => {
    const { snapshot, ...view } = task;
    return { ...view, modelTitle: snapshot.model.title };
  };
  const publicArtifact = (artifact: ReturnType<typeof store.artifact>) => artifact;
  app.get('/api/helper/projects', () => store.groups());
  app.post('/api/helper/projects', (request) => {
    const body = record(request.body);
    fields(body, ['title', 'requestKey']);
    return store.createGroup(
      text(body.title, 'group title', 200).trim(),
      text(body.requestKey, 'request key', 100)
    );
  });
  app.patch<{ Params: { id: string } }>('/api/helper/projects/:id', (request) => {
    const body = record(request.body);
    fields(body, ['title', 'expectedRevision']);
    return store.renameGroup(
      request.params.id,
      number(body.expectedRevision, 'group revision'),
      text(body.title, 'group title', 200).trim()
    );
  });
  app.delete<{ Params: { id: string } }>('/api/helper/projects/:id', (request) => {
    const body = record(request.body);
    fields(body, ['expectedRevision']);
    return store.deleteGroup(request.params.id, number(body.expectedRevision, 'group revision'));
  });
  app.get<{ Querystring: { kind?: string; chatId?: string } }>(
    '/api/helper/conversations',
    (request) => {
      const { kind, chatId } = request.query;
      if (kind !== 'library' && kind !== 'chat' && kind !== 'all')
        throw new HttpError(400, 'Helper scope kind required');
      return store.list(
        kind === 'library' || kind === 'all'
          ? { kind }
          : {
              kind,
              chatId: text(chatId, 'chat ID', 100),
            }
      );
    }
  );
  const readScope = (value: unknown): HelperScope => {
    const input = record(value);
    let scope: HelperScope;
    if (input.kind === 'chat') {
      fields(input, ['kind', 'chatId']);
      const chatId = text(input.chatId, 'chat ID', 100);
      runtime.store.chat(chatId);
      scope = {
        kind: 'chat',
        chatId,
      };
    } else {
      fields(input, ['kind', 'workId']);
      if (input.kind !== 'library') throw new HttpError(400, 'Invalid helper scope');
      scope = { kind: 'library', workId: text(input.workId, 'library work ID', 100) };
    }
    return scope;
  };
  app.post('/api/helper/conversations', (request) => {
    const body = record(request.body);
    fields(body, ['scope']);
    return store.open(readScope(body.scope));
  });
  app.post('/api/helper/conversations/new', (request) => {
    const body = record(request.body);
    fields(body, ['scope', 'requestKey', 'title']);
    return store.create(
      readScope(body.scope),
      `request:${text(body.requestKey, 'request key', 100)}`,
      body.title === undefined ? undefined : text(body.title, 'conversation title', 200)
    );
  });
  app.patch<{ Params: { id: string } }>('/api/helper/conversations/:id/project', (request) => {
    const body = record(request.body);
    fields(body, ['projectId', 'expectedRevision']);
    return store.moveGroup(
      request.params.id,
      number(body.expectedRevision, 'conversation revision'),
      body.projectId === null ? null : text(body.projectId, 'project ID', 100)
    );
  });
  app.post<{ Params: { id: string } }>('/api/helper/conversations/:id/copy', (request) => {
    const body = record(request.body);
    fields(body, ['requestKey', 'expectedRevision', 'expectedEventSequence']);
    return store.copy(request.params.id, text(body.requestKey, 'request key', 100), {
      expectedRevision: number(body.expectedRevision, 'conversation revision'),
      expectedEventSequence: number(
        body.expectedEventSequence,
        'event sequence',
        0,
        Number.MAX_SAFE_INTEGER
      ),
    });
  });
  app.get<{ Params: { id: string } }>('/api/helper/conversations/:id', (request) =>
    store.conversation(request.params.id)
  );
  app.get<{ Params: { id: string } }>('/api/helper/conversations/:id/view', (request) => {
    const id = request.params.id;
    // Capture the cursor before reading: a concurrent external write is replayed, never skipped.
    const eventCursor = store.latestEventSequence(id);
    return {
      eventCursor,
      conversation: store.conversation(id),
      messages: store.messages(id),
      tasks: store.taskSummaries(id),
      lastResourceEdit: lastHelperResourceEdit(runtime.store, store, id),
    };
  });
  app.post<{ Params: { id: string } }>('/api/helper/conversations/:id/undo-resource', (request) => {
    const body = record(request.body);
    fields(body, ['editSeq']);
    return undoHelperResourceEdit(
      runtime.store,
      store,
      request.params.id,
      number(body.editSeq, 'resource edit sequence', 1, Number.MAX_SAFE_INTEGER)
    );
  });
  app.patch<{ Params: { id: string } }>('/api/helper/conversations/:id', (request) => {
    const body = record(request.body);
    fields(body, ['expectedRevision', 'title', 'persona']);
    if (body.title === undefined && body.persona === undefined)
      throw new HttpError(400, '변경할 도우미 설정이 필요해요.');
    return store.update(
      request.params.id,
      number(body.expectedRevision, 'helper settings revision'),
      {
        ...(body.title === undefined ? {} : { title: text(body.title, 'conversation title', 200) }),
        ...(body.persona === undefined
          ? {}
          : { persona: text(body.persona, 'helper persona', HELPER_PERSONA_MAX_CHARS, true) }),
      }
    );
  });
  app.get<{ Params: { id: string } }>('/api/helper/conversations/:id/deletion', (request) =>
    runtime.deletionImpact(request.params.id)
  );
  app.delete<{ Params: { id: string } }>('/api/helper/conversations/:id', (request) => {
    const body = record(request.body);
    fields(body, ['expectedRevision', 'expectedEventSequence']);
    return runtime.deleteConversation(request.params.id, {
      expectedRevision: number(body.expectedRevision, 'conversation revision'),
      expectedEventSequence: number(
        body.expectedEventSequence,
        'event sequence',
        0,
        Number.MAX_SAFE_INTEGER
      ),
    });
  });
  app.get<{ Params: { id: string }; Querystring: { before?: string } }>(
    '/api/helper/conversations/:id/messages',
    (request) => store.messages(request.params.id, request.query.before)
  );
  app.get<{ Params: { id: string }; Querystring: { before?: string } }>(
    '/api/helper/conversations/:id/tasks',
    (request) => store.taskSummaries(request.params.id, request.query.before)
  );
  app.patch<{ Params: { id: string; messageId: string } }>(
    '/api/helper/conversations/:id/messages/:messageId',
    { bodyLimit: 16 * 1024 * 1024 },
    (request) => {
      const body = record(request.body);
      fields(body, ['expectedRevision', 'text']);
      return runtime.editMessage(
        request.params.id,
        request.params.messageId,
        number(body.expectedRevision, 'conversation revision'),
        text(body.text, 'helper message', REQUEST_TEXT_MAX_CHARS)
      );
    }
  );
  app.delete<{ Params: { id: string; messageId: string } }>(
    '/api/helper/conversations/:id/messages/:messageId',
    (request) => {
      const body = record(request.body);
      fields(body, ['expectedRevision', 'scope']);
      if (body.scope !== 'pair' && body.scope !== 'following')
        throw new HttpError(400, 'Invalid helper message deletion scope');
      return runtime.deleteMessages(
        request.params.id,
        request.params.messageId,
        number(body.expectedRevision, 'conversation revision'),
        body.scope
      );
    }
  );
  app.post<{ Params: { id: string } }>(
    '/api/helper/conversations/:id/messages',
    { bodyLimit: 48 * 1024 * 1024 },
    (request) => {
      const body = record(request.body);
      fields(body, ['requestKey', 'text', 'editor', 'selection', 'retryOf', 'outline']);
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
        fields(input, ['targetId', 'revision', 'title', 'kind', 'model', 'source']);
        if (!['content', 'prompt-preset', 'prompt-workspace'].includes(input.kind))
          throw new HttpError(400, 'Invalid editor kind');
        if (input.source !== undefined && !['saved', 'unsaved'].includes(input.source))
          throw new HttpError(400, 'Invalid editor source');
        if (input.source === 'saved' && input.model !== undefined)
          throw new HttpError(400, '저장된 자료는 ID와 수정 번호로 보내 주세요.');
        if (input.source === 'unsaved' && input.model === undefined)
          throw new HttpError(400, '미저장 입력을 함께 보내 주세요.');
        editor = {
          targetId: input.targetId === null ? null : text(input.targetId, 'resource ID', 100),
          revision: input.revision === null ? null : number(input.revision, 'revision'),
          title: text(input.title, 'editor title', 200, true),
          kind: input.kind,
          ...(input.source ? { source: input.source } : {}),
          ...(input.model === undefined
            ? {}
            : {
                model: record(input.model) as import('../core/resource-editing.js').ResourceModel,
              }),
        };
      }
      return publicTask(
        runtime.enqueue(
          request.params.id,
          text(body.requestKey, 'request key', 100),
          text(body.text, 'helper message', REQUEST_TEXT_MAX_CHARS),
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
          outline
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
