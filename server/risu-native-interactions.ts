import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Store } from './store.js';
import { HttpError, record } from './request-validation.js';

export type NativeInteraction = {
  id: string;
  runId: string;
  branchId: string;
  kind: 'input' | 'select' | 'confirm';
  prompt: string;
  choices?: string[];
};
type Pending = NativeInteraction & {
  chatId: string;
  resolve: (value: string | boolean) => void;
  reject: (error: Error) => void;
};
const pending = new WeakMap<Store, Map<string, Pending>>();
const entries = (store: Store) => {
  let map = pending.get(store);
  if (!map) {
    map = new Map();
    pending.set(store, map);
  }
  return map;
};
const visible = ({ id, runId, branchId, kind, prompt, choices }: Pending): NativeInteraction => ({
  id,
  runId,
  branchId,
  kind,
  prompt,
  ...(choices ? { choices } : {}),
});

/** Suspend the original invocation; answering never reruns a script or a paid model call. */
export function requestNativeInteraction(
  store: Store,
  runId: string,
  method: string,
  args: unknown,
  signal: AbortSignal
): Promise<string | boolean> {
  const run = store.run(runId),
    value = record(args).value;
  if (run.status !== 'running') throw new HttpError(409, 'RISU_NATIVE_ACTION_INACTIVE');
  const kind =
    method === 'alertInput'
      ? 'input'
      : method === 'alertSelect'
        ? 'select'
        : method === 'alertConfirm'
          ? 'confirm'
          : undefined;
  const decoded = value;
  if (
    !kind ||
    (kind === 'select'
      ? !Array.isArray(decoded) ||
        decoded.length > 100 ||
        decoded.some((entry) => typeof entry !== 'string' || entry.length > 10000)
      : typeof decoded !== 'string' || decoded.length > 10000)
  )
    throw new HttpError(400, 'RISU_NATIVE_INTERACTION_INVALID');
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const abort = () => finish(undefined, new Error('RISU_NATIVE_INTERACTION_CANCELLED'));
    const finish = (answer?: string | boolean, error?: Error) => {
      entries(store).delete(id);
      signal.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve(answer!);
    };
    entries(store).set(id, {
      id,
      runId,
      chatId: run.chatId,
      branchId: run.snapshot.branchId!,
      kind,
      prompt: kind === 'select' ? '항목을 선택해 주세요.' : (decoded as string),
      ...(kind === 'select' ? { choices: decoded as string[] } : {}),
      resolve: (answer) => finish(answer),
      reject: (error) => finish(undefined, error),
    });
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    else store.event(run.chatId, 'native.interaction.requested', runId);
  });
}

export function nativeInteractionRoutes(app: FastifyInstance, store: Store) {
  app.get<{ Params: { id: string }; Querystring: { branchId?: string } }>(
    '/api/chats/:id/risu-interactions',
    async (request) => {
      const branch = store.product.branch(request.params.id, request.query.branchId);
      return {
        interactions: [...entries(store).values()]
          .filter((entry) => entry.chatId === request.params.id && entry.branchId === branch.id)
          .map(visible),
      };
    }
  );
  app.post<{ Params: { id: string; interactionId: string } }>(
    '/api/chats/:id/risu-interactions/:interactionId',
    async (request) => {
      const entry = entries(store).get(request.params.interactionId);
      if (!entry || entry.chatId !== request.params.id)
        throw new HttpError(404, 'RISU_NATIVE_INTERACTION_EXPIRED');
      if (store.run(entry.runId).status !== 'running')
        throw new HttpError(409, 'RISU_NATIVE_ACTION_INACTIVE');
      const body = record(request.body),
        answer = body.answer;
      if (
        entry.kind === 'confirm'
          ? typeof answer !== 'boolean'
          : typeof answer !== 'string' || answer.length > 10000
      )
        throw new HttpError(400, 'RISU_NATIVE_INTERACTION_ANSWER');
      if (
        entry.kind === 'select' &&
        answer !== '' &&
        (!/^\d+$/u.test(String(answer)) || Number(answer) >= entry.choices!.length)
      )
        throw new HttpError(400, 'RISU_NATIVE_INTERACTION_ANSWER');
      entry.resolve(answer as string | boolean);
      return { accepted: true };
    }
  );
  app.addHook('onClose', async () => {
    for (const entry of entries(store).values())
      entry.reject(new Error('RISU_NATIVE_SERVER_STOPPED'));
    pending.delete(store);
  });
}
