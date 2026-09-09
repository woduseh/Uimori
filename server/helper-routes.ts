import type { FastifyInstance } from 'fastify';
import type { HelperScope, HelperEditor, HelperLimits } from '../core/helper.js';
import type { HelperRuntime } from './helper-runtime.js';
import { fields, HttpError, number, record, text } from './request-validation.js';

export function helperRoutes(app: FastifyInstance, runtime: HelperRuntime) {
  const store = runtime.workspace;
  const publicTask = (task: ReturnType<typeof store.task>) => {
    const { snapshot: _snapshot, ...view } = task;
    return view;
  };
  const publicArtifact = (artifact: ReturnType<typeof store.artifact>) => {
    const { snapshot: _snapshot, ...view } = artifact;
    return view;
  };
  app.get<{ Querystring: { kind?: string; chatId?: string; branchId?: string } }>(
    '/api/helper/conversations',
    (request) => {
      const { kind, chatId, branchId } = request.query;
      if (kind !== 'library' && kind !== 'chat')
        throw new HttpError(400, 'Helper scope kind required');
      const rows =
        kind === 'library'
          ? runtime.store.db
              .prepare(
                'SELECT id FROM helper_conversations WHERE chat_id IS NULL ORDER BY rowid DESC'
              )
              .all()
          : runtime.store.db
              .prepare(
                'SELECT id FROM helper_conversations WHERE chat_id=? AND branch_id=? ORDER BY rowid DESC'
              )
              .all(text(chatId, 'chat ID', 100), text(branchId, 'branch ID', 100));
      return rows.map((row) => {
        const conversation = store.conversation(String(row.id));
        const first = runtime.store.db
          .prepare(
            "SELECT text FROM helper_messages WHERE conversation_id=? AND role='user' ORDER BY rowid LIMIT 1"
          )
          .get(conversation.id);
        return { ...conversation, title: String(first?.text ?? '새 서재 작업').slice(0, 80) };
      });
    }
  );
  app.post('/api/helper/conversations', (request) => {
    const body = record(request.body);
    fields(body, ['scope']);
    const input = record(body.scope);
    let scope: HelperScope;
    if (input.kind === 'chat') {
      fields(input, ['kind', 'chatId', 'branchId']);
      const chatId = text(input.chatId, 'chat ID', 100);
      scope = {
        kind: 'chat',
        chatId,
        branchId: runtime.store.product.branch(
          chatId,
          input.branchId === undefined ? undefined : text(input.branchId, 'branch ID', 100)
        ).id,
      };
    } else {
      fields(input, ['kind', 'workId']);
      if (input.kind !== 'library') throw new HttpError(400, 'Invalid helper scope');
      scope = { kind: 'library', workId: text(input.workId, 'library work ID', 100) };
    }
    return store.open(scope);
  });
  app.get<{ Params: { id: string } }>('/api/helper/conversations/:id', (request) =>
    store.conversation(request.params.id)
  );
  app.patch<{ Params: { id: string } }>('/api/helper/conversations/:id', (request) => {
    const body = record(request.body);
    fields(body, ['expectedRevision', 'persona', 'limits']);
    let limits: HelperLimits | undefined;
    if (body.limits !== undefined) {
      const value = record(body.limits);
      fields(value, ['totalCalls', 'helperCalls', 'artifacts']);
      const totalCalls = number(value.totalCalls, 'total call limit', 2, 100);
      limits = {
        totalCalls,
        helperCalls: number(value.helperCalls, 'helper call limit', 1, totalCalls),
        artifacts: number(value.artifacts, 'artifact jobs', 1, 10),
      };
    }
    return store.persona(
      request.params.id,
      number(body.expectedRevision, 'helper settings revision'),
      text(body.persona, 'helper persona', 2000, true),
      limits
    );
  });
  app.get<{ Params: { id: string }; Querystring: { before?: string } }>(
    '/api/helper/conversations/:id/messages',
    (request) => store.messages(request.params.id, request.query.before)
  );
  app.get<{ Params: { id: string }; Querystring: { before?: string } }>(
    '/api/helper/conversations/:id/tasks',
    (request) => store.tasks(request.params.id, request.query.before).map(publicTask)
  );
  app.post<{ Params: { id: string } }>('/api/helper/conversations/:id/messages', (request) => {
    const body = record(request.body);
    fields(body, ['requestKey', 'text', 'editor', 'selection']);
    let editor: HelperEditor | undefined;
    if (body.editor !== undefined) {
      const input = record(body.editor);
      fields(input, ['draftId', 'revision', 'title', 'kind']);
      editor = {
        draftId: text(input.draftId, 'draft ID', 100),
        revision: number(input.revision, 'draft revision'),
        title: text(input.title, 'editor title', 200, true),
        kind: text(input.kind, 'editor kind', 100),
      };
    }
    return publicTask(
      runtime.enqueue(
        request.params.id,
        text(body.requestKey, 'request key', 100),
        text(body.text, 'helper message', 100_000),
        editor,
        body.selection === undefined
          ? undefined
          : (() => {
              const selection = record(body.selection);
              fields(selection, ['sourceId', 'sourceHash', 'text']);
              return {
                sourceId: text(selection.sourceId, 'source ID', 100),
                sourceHash: text(selection.sourceHash, 'source hash', 64),
                text: text(selection.text, 'selected text', 100_000),
              };
            })()
      )
    );
  });
  app.get<{ Params: { id: string } }>('/api/helper/tasks/:id', (request) =>
    publicTask(store.task(request.params.id))
  );
  app.post<{ Params: { id: string } }>('/api/helper/tasks/:id/cancel', (request) =>
    publicTask(runtime.cancel(request.params.id))
  );
  app.get<{ Params: { id: string }; Querystring: { after?: string } }>(
    '/api/helper/conversations/:id/events',
    (request) => {
      const after = request.query.after === undefined ? 0 : Number(request.query.after);
      number(after, 'event cursor', 0, Number.MAX_SAFE_INTEGER);
      return store.events(request.params.id, after);
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
  app.patch<{ Params: { id: string } }>('/api/helper/artifacts/:id', (request) => {
    const body = record(request.body);
    fields(body, ['expectedRevision', 'text', 'requestKey']);
    return publicArtifact(
      store.editArtifact(
        request.params.id,
        number(body.expectedRevision, 'artifact revision'),
        text(body.text, 'artifact text', 500_000),
        text(body.requestKey, 'request key', 100)
      )
    );
  });
}
