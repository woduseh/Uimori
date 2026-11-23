import { randomInt } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { FastifyInstance } from 'fastify';
import {
  latestStoryUiPins,
  parseStoryUi,
  type StoryUiAction,
  validateStoryUiAction,
} from '../core/story-ui.js';
import { latestTranslation } from './source-editing.js';
import { storyUiPinSlot } from '../core/story-ui-style.js';
import type { RunSnapshot } from '../core/types.js';
import {
  choice,
  fields,
  HttpError,
  isSha256Hex,
  number,
  record,
  text,
} from './request-validation.js';
import type { Store } from './store.js';
import { runResponse } from './run-projections.js';

type ActionCommand = Omit<StoryUiAction, 'roll'>;

function actionRequest(source: string, action: StoryUiAction): string {
  const block = parseStoryUi(source).find(
    (part) => part.kind === 'ui' && part.id === action.blockId
  );
  if (block?.kind !== 'ui') throw new HttpError(400, 'STORY_UI_INVALID_ACTION');
  const surface = (
    block.messages[0] as unknown as { createSurface: { components: Record<string, unknown>[] } }
  ).createSurface;
  const components = surface.components;
  const button = components.find(
    (item) =>
      item.component === 'Button' &&
      (action.componentId === undefined || action.componentId === item.id) &&
      validateStoryUiAction(source, action.blockId, action.name, action.context, String(item.id))
  );
  const label = (id: unknown): string => {
    const item = components.find((component) => component.id === id);
    if (!item) return '';
    if (item.component === 'Text' && typeof item.text === 'string') return item.text;
    if (typeof item.child === 'string') return label(item.child);
    if (Array.isArray(item.children)) return item.children.map(label).filter(Boolean).join(' ');
    return '';
  };
  const valueText = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    if (typeof value !== 'object') return String(value);
    if (Array.isArray(value)) return value.map(valueText).join(', ');
    return Object.entries(value)
      .map(([key, entry]) => `${key}: ${valueText(entry)}`)
      .join('; ');
  };
  const details = Object.entries(action.context).map(
    ([key, value]) => `${key}: ${valueText(value)}`
  );
  return [
    label(button?.child) || action.name,
    ...details,
    ...(action.roll
      ? [
          `🎲 ${action.roll.results.length}d${action.roll.sides} → ${action.roll.results.join(', ')}`,
        ]
      : []),
  ].join('\n');
}

export function storyUiRoutes(
  app: FastifyInstance,
  store: Store,
  options: {
    publish: (chatId: string) => void;
    execute: (runId: string) => void;
    requireRequestModel: (snapshot: RunSnapshot) => void;
  }
): void {
  app.get<{ Params: { id: string }; Querystring: { at?: string } }>(
    '/api/chats/:id/story-ui/pins',
    async (request) => {
      const chat = store.chat(request.params.id);
      const at = request.query.at ?? chat.headRevision;
      if (!at) return { pins: [] };
      if (store.source(at).chatId !== chat.id) throw new HttpError(404, 'Scene not found');
      const scenes = store.history(at).map((entry) => ({ id: entry.revision, text: entry.text }));
      return {
        pins: latestStoryUiPins(scenes).map((pin) => {
          const source = store.source(pin.sourceId);
          const job = latestTranslation(store, source.id);
          const translated =
            job?.status === 'completed' && job.sourceHash === source.hash && job.result?.text
              ? parseStoryUi(job.result.text).filter((part) => part.kind === 'ui')[pin.index]
              : undefined;
          return {
            slot: pin.slot,
            sourceId: pin.sourceId,
            original: pin.segment,
            ...(translated?.kind === 'ui' && storyUiPinSlot(translated.messages) === pin.slot
              ? { translated }
              : {}),
          };
        }),
      };
    }
  );
  app.post<{ Params: { id: string } }>(
    '/api/chats/:id/story-ui/actions',
    { bodyLimit: 16 * 1024 },
    async (request) => {
      const body = record(request.body);
      fields(body, [
        'sourceRevision',
        'sourceHash',
        'blockId',
        'surfaceId',
        'componentId',
        'eventName',
        'context',
        'mode',
        'idempotencyKey',
      ]);
      if (!isSha256Hex(body.sourceHash)) throw new HttpError(400, 'Invalid source hash');
      const action: ActionCommand = {
        sourceRevision: text(body.sourceRevision, 'source revision', 100),
        sourceHash: body.sourceHash,
        blockId: text(body.blockId, 'block ID', 100),
        surfaceId:
          body.surfaceId === undefined ? 'main' : choice(body.surfaceId, ['main'], 'surface ID'),
        ...(body.componentId !== undefined
          ? { componentId: text(body.componentId, 'component ID', 200) }
          : {}),
        name: text(body.eventName, 'event name', 200),
        context: record(body.context),
        mode: choice(body.mode, ['short', 'continue'], 'action mode'),
      };
      const chatId = request.params.id;
      const idempotencyKey = text(body.idempotencyKey, 'idempotency key', 120);
      const result = store.transaction(() => {
        const previous = store.db
          .prepare(`SELECT id,json_extract(command,'$.storyUiAction') AS action
            FROM runs WHERE chat_id=? AND request_key=?`)
          .get(chatId, idempotencyKey);
        if (previous) {
          if (
            typeof previous.action !== 'string' ||
            !isDeepStrictEqual(JSON.parse(previous.action), action)
          )
            throw new HttpError(409, 'Idempotency key reused with different command');
          return { run: store.run(String(previous.id)), created: false };
        }

        const chat = store.chat(chatId);
        if (chat.headRevision !== action.sourceRevision)
          throw new HttpError(409, 'STORY_UI_STALE_SOURCE');
        const source = store.source(action.sourceRevision);
        if (source.chatId !== chatId || source.hash !== action.sourceHash)
          throw new HttpError(409, 'STORY_UI_STALE_SOURCE');
        if (chat.settings.storyUi !== true) throw new HttpError(409, 'STORY_UI_DISABLED');
        const event = validateStoryUiAction(
          source.text,
          action.blockId,
          action.name,
          action.context,
          action.componentId
        );
        if (!event) throw new HttpError(400, 'STORY_UI_INVALID_ACTION');

        const receipt: StoryUiAction = { ...action, ...event };
        if (event.name === 'roll') {
          const sides = number(event.context.sides, 'number of dice sides', 2, 1000);
          const count = number(event.context.count ?? 1, 'number of dice', 1, 20);
          receipt.roll = {
            sides,
            results: Array.from({ length: count }, () => randomInt(1, sides + 1)),
          };
        }
        const prompt = actionRequest(source.text, receipt);
        return store.createRunInTransaction(
          chatId,
          {
            request: prompt,
            expectedRevision: action.sourceRevision,
            expectedSourceHash: action.sourceHash,
            expectedSettingsRevision: chat.settingsRevision,
            idempotencyKey,
            storyUiAction: action,
          },
          (current) => {
            const profile = store.product.snapshot(chatId);
            const snapshot: RunSnapshot = {
              chatId,
              parentRevision: current.headRevision,
              settingsRevision: current.settingsRevision,
              settings: current.settings,
              request: prompt,
              storyUiAction: receipt,
              history: store.history(current.headRevision),
              resources: store.product.resources(chatId, profile),
              ...(profile ? { profile } : {}),
            };
            options.requireRequestModel(snapshot);
            return snapshot;
          }
        );
      });
      if (result.created) {
        options.publish(chatId);
        if (result.run.status === 'queued') options.execute(result.run.id);
      }
      return runResponse(request.headers.prefer, result.run);
    }
  );
}
