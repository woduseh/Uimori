import { Writable } from 'node:stream';
import { afterEach, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ResponseStreamStore, responseStreamRoutes } from '../server/response-stream.js';

const owned: Writable[] = [];
afterEach(async () => {
  for (const raw of owned.splice(0)) raw.destroy();
  await new Promise<void>((resolve) => setImmediate(resolve));
});

test('a stalled SSE subscriber pauses reads, resumes after its accepted cursor and does not block other subscribers', async () => {
  type Request = { params: { taskKind: string; taskId: string }; query: object; headers: object };
  type Reply = { hijack: () => void; raw: Writable & { writeHead: () => void } };
  const routes = new Map<string, (request: Request, reply: Reply) => Promise<void>>();
  const listeners = new Set<() => void>();
  const reads: number[] = [];
  let terminal = false;
  const streams = {
    read(taskKind: string, taskId: string, after = 0) {
      reads.push(after);
      return {
        taskKind,
        taskId,
        status: terminal ? 'completed' : 'running',
        cursor: Math.min(after + 1, 3),
        hasMore: after < 2,
        chunks: after < 3 ? [{ seq: after + 1, text: 'x'.repeat(1024) }] : [],
      };
    },
    subscribe(_identity: unknown, listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as ResponseStreamStore;
  responseStreamRoutes(
    {
      addHook() {},
      get(path: string, handler: (request: Request, reply: Reply) => Promise<void>) {
        routes.set(path, handler);
      },
    } as unknown as FastifyInstance,
    streams,
    { authenticated: () => true }
  );
  const connect = async (stalled: boolean) => {
    const queued: (() => void)[] = [];
    const data: string[] = [];
    const raw = Object.assign(
      new Writable({
        highWaterMark: 512,
        write(chunk, _encoding, callback) {
          data.push(String(chunk));
          if (stalled) queued.push(callback);
          else callback();
        },
      }),
      { writeHead() {} }
    );
    owned.push(raw);
    await routes.get('/api/response-streams/:taskKind/:taskId/events')!(
      {
        params: { taskKind: 'main', taskId: 'synthetic' },
        query: {},
        headers: {},
      },
      { hijack() {}, raw }
    );
    return { raw, data, queued };
  };
  const slow = await connect(true);
  expect(reads).toEqual([0, 0]); // preflight plus just one accepted page
  expect(slow.raw.writableLength).toBeLessThan(1500);
  const before = reads.length;
  for (const listener of listeners) listener();
  expect(reads).toHaveLength(before);
  const fast = await connect(false);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(fast.data.some((page) => page.startsWith('id: 3\n'))).toBe(true);
  slow.queued.shift()!();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(slow.data.map((page) => page.split('\n')[0])).toEqual(['id: 1', 'id: 2']);
  terminal = true;
  slow.queued.shift()!();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(slow.data.map((page) => page.split('\n')[0])).toEqual(['id: 1', 'id: 2', 'id: 3']);
  expect(slow.raw.writableEnded).toBe(true);
  slow.queued.shift()!();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(slow.raw.listenerCount('drain')).toBe(0);
  expect(listeners.size).toBe(1);
  fast.raw.destroy();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(listeners.size).toBe(0);
});
