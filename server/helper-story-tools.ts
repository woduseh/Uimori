import { createHash } from 'node:crypto';
import { REQUEST_TEXT_MAX_CHARS } from '../core/content-limits.js';
import type { HelperTask } from '../core/helper.js';
import type { Json, ProviderTool } from '../core/transport.js';
import type { Job, Run, RunSnapshot } from '../core/types.js';
import { composerRunSnapshot } from './composer-run.js';
import { recordHelperTaskResult } from './helper-task-results.js';
import type { HelperWorkspace } from './helper-workspace.js';
import { HelperToolError } from './app-errors.js';
import { fields, HttpError, number, record, text } from './request-validation.js';
import { latestTranslation, requestTranslation } from './source-editing.js';
import type { Store } from './store.js';

const schema = (properties: Record<string, Json>, required: string[]): Json => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

export const HELPER_STORY_TOOLS: ProviderTool[] = [
  {
    name: 'scene.request',
    description:
      "Send a writing request to the writer of a chat, the same as sending it from the composer: the main model writes the next scene from the request, the saved story and the chat's settings. It starts a paid model request, so call it only when the user asks you to write, continue or request the next scene; to suggest or draft a scene, answer in the conversation instead. Values staged with options.oneoff apply to this request. Take expectedHeadRevision (chat.headRevision, null for a chat without scenes) and expectedSettingsRevision (chat.settingsRevision) from chat.read. It is refused while another request of the chat is queued or running, and after the story or the chat settings changed. It returns the queued run at once and the scene appears in the chat when the writer finishes, so do not wait for it in this task; task.inspect with kind run reports its progress or failure later.",
    inputSchema: schema(
      {
        request: {
          type: 'string',
          minLength: 1,
          maxLength: REQUEST_TEXT_MAX_CHARS,
          description: 'The writing request, as the user would type it in the composer.',
        },
        expectedHeadRevision: {
          type: ['string', 'null'],
          maxLength: 100,
          description: 'chat.headRevision from chat.read, null for a chat without scenes.',
        },
        expectedSettingsRevision: {
          type: 'integer',
          minimum: 1,
          description: 'chat.settingsRevision from chat.read.',
        },
      },
      ['request', 'expectedHeadRevision', 'expectedSettingsRevision']
    ),
  },
  {
    name: 'scene.translate',
    description:
      "Ask the translation model to translate a saved scene of the chat, as the reader's translate action does. It starts a paid model request, so call it only when the user asks for a translation. Without retranslate, a scene whose translation of the current text is complete keeps it and nothing starts; retranslate:true starts a new translation that replaces it when it finishes. A translation of the scene that is already queued or running is returned instead of starting another. The translation follows the scene text as saved now. It returns the job at once and the translation appears in the reader when it finishes; task.inspect with kind job reports its progress or failure later.",
    inputSchema: schema(
      {
        sourceId: {
          type: 'string',
          minLength: 1,
          maxLength: 100,
          description: 'Scene id from chat.read.',
        },
        retranslate: {
          type: 'boolean',
          description: 'Replace a completed translation with a new one. Default false.',
        },
      },
      ['sourceId']
    ),
  },
];

export type HelperStoryEffects = {
  requireRunModel: (snapshot: RunSnapshot) => void;
  requireTranslationModel: (jobId: string) => void;
};

export function requestHelperStory(
  store: Store,
  workspace: HelperWorkspace,
  task: Pick<HelperTask, 'id' | 'conversationId'>,
  receiptId: string,
  chatId: string,
  name: string,
  value: unknown,
  effects: HelperStoryEffects
): { result: Record<string, unknown>; started?: { run: Run } | { job: Job } } {
  const args = record(value);
  const chat = store.chat(chatId);
  if (name === 'scene.request') {
    fields(args, ['request', 'expectedHeadRevision', 'expectedSettingsRevision']);
    const command = {
      request: text(args.request, 'request', REQUEST_TEXT_MAX_CHARS),
      expectedRevision:
        args.expectedHeadRevision === null
          ? null
          : text(args.expectedHeadRevision, 'head revision', 100),
      expectedSettingsRevision: number(args.expectedSettingsRevision, 'settings revision'),
      idempotencyKey: `helper:${createHash('sha256').update(receiptId).digest('hex')}`,
    };
    if (
      !store.findRunByCommand(chatId, command) &&
      store.db
        .prepare("SELECT 1 FROM runs WHERE chat_id=? AND status IN ('queued','running')")
        .get(chatId)
    )
      throw new HelperToolError(
        409,
        'SCENE_REQUEST_BUSY',
        'Another request of this chat is queued or running. Tell the user instead of sending it again.'
      );
    const { run, created } = store.createRunInTransaction(chatId, command, (current) => {
      const snapshot = composerRunSnapshot(store, current, command.request);
      effects.requireRunModel(snapshot);
      return snapshot;
    });
    recordHelperTaskResult(workspace, task, {
      receiptId,
      operation: name,
      requestedTargets: 1,
      targets: [{ kind: 'chat', id: chatId, title: chat.title, revision: run.settingsRevision }],
    });
    return {
      result: { runId: run.id, status: run.status, chatId },
      ...(created && run.status === 'queued' ? { started: { run } } : {}),
    };
  }
  if (name !== 'scene.translate') throw new HelperToolError(400, 'UNKNOWN_STORY_TOOL');
  fields(args, ['sourceId', 'retranslate']);
  const sourceId = text(args.sourceId, 'source ID', 100);
  if (args.retranslate !== undefined && typeof args.retranslate !== 'boolean')
    throw new HttpError(400, 'Invalid retranslate: expected a boolean');
  if (!store.history(chat.headRevision).some((item) => item.revision === sourceId))
    throw new HelperToolError(404, 'SCENE_NOT_IN_CHAT', 'Find the scene id with chat.read.');
  const previous = latestTranslation(store, sourceId)?.id;
  const job = requestTranslation(
    store,
    sourceId,
    args.retranslate === true,
    effects.requireTranslationModel
  );
  const started = job.id !== previous;
  recordHelperTaskResult(workspace, task, {
    receiptId,
    operation: name,
    requestedTargets: 1,
    targets: started
      ? [
          {
            kind: 'translation',
            id: sourceId,
            chatId,
            title: chat.title,
            revision: job.revision ?? 0,
          },
        ]
      : [],
  });
  return {
    result: { jobId: job.id, status: job.status, sourceId, started },
    ...(started ? { started: { job } } : {}),
  };
}
