import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';
import {
  createNativeRisuWorkerSession,
  runNativeRisuWorker,
} from '../server/risu-native-worker.js';

type Input = {
  text?: string;
  nested?: { value: string };
  delay?: number;
  fail?: boolean;
  spin?: boolean;
  exit?: boolean;
};
type Result = {
  threadId: number;
  calls: number;
  copy: Input;
  env: string | null;
  resourceLimits: {
    maxOldGenerationSizeMb: number;
    maxYoungGenerationSizeMb: number;
    stackSizeMb: number;
  };
};
const module = new URL('./fixtures/native-worker-session.mjs', import.meta.url);
const sessions = new Set<ReturnType<typeof createNativeRisuWorkerSession<Input, Result>>>();
afterEach(async () => {
  for (const session of sessions) await session.close();
  sessions.clear();
});
function session(timeout = 3000, signal?: AbortSignal) {
  const value = createNativeRisuWorkerSession<Input, Result>(module, 'evaluate', timeout, signal);
  sessions.add(value);
  return value;
}

test('serial calls reuse one worker, evaluate again and clone each input/result', async () => {
  const value = session();
  const input = { text: '동일한 입력', nested: { value: 'original' } };
  const first = await value.run(input);
  first.copy.nested!.value = 'changed in caller';
  const second = await value.run(input);
  assert.equal(first.threadId, second.threadId);
  assert.equal(second.calls, 2);
  assert.equal(input.nested.value, 'original');
  assert.equal(second.copy.nested!.value, 'original');
});

test('different requests never share a worker or its module state', async () => {
  const first = await session().run({ text: 'chat A' });
  const second = await session().run({ text: 'chat B' });
  assert.notEqual(first.threadId, second.threadId);
  assert.equal(first.calls, 1);
  assert.equal(second.calls, 1);
});

test('one-shot callers still get new workers', async () => {
  const a = await runNativeRisuWorker<Result>(module, 'evaluate', { text: 'one' });
  const b = await runNativeRisuWorker<Result>(module, 'evaluate', { text: 'two' });
  assert.notEqual(a.threadId, b.threadId);
  assert.equal(a.calls, 1);
  assert.equal(b.calls, 1);
});

test('resource limits and an empty worker environment remain in force', async () => {
  const previous = process.env.UIMORI_WORKER_TEST_SECRET;
  process.env.UIMORI_WORKER_TEST_SECRET = 'test-only-sentinel';
  try {
    const result = await session().run({});
    assert.equal(result.env, null);
    assert.equal(result.resourceLimits.maxOldGenerationSizeMb, 96);
    assert.equal(result.resourceLimits.maxYoungGenerationSizeMb, 16);
    assert.equal(result.resourceLimits.stackSizeMb, 4);
  } finally {
    if (previous === undefined) delete process.env.UIMORI_WORKER_TEST_SECRET;
    else process.env.UIMORI_WORKER_TEST_SECRET = previous;
  }
});

test('concurrent calls are rejected rather than reordered or queued', async () => {
  const value = session();
  const first = value.run({ delay: 30 });
  await assert.rejects(value.run({}), /RISU_NATIVE_WORKER_BUSY/u);
  assert.equal((await first).calls, 1);
  assert.equal((await value.run({})).calls, 2);
});

test('a method failure terminates the session and never silently retries', async () => {
  const value = session();
  await assert.rejects(value.run({ fail: true }), /fixture failure/u);
  await assert.rejects(value.run({}), /fixture failure/u);
  await value.close();
});

test('each invocation has a deadline, including a later synchronous infinite loop', async () => {
  const value = session(750);
  await value.run({});
  await assert.rejects(value.run({ spin: true }), /RISU_NATIVE_TIMEOUT/u);
  await assert.rejects(value.run({}), /RISU_NATIVE_TIMEOUT/u);
});

test('abort before startup and during work prevents late results and future calls', async () => {
  const before = new AbortController();
  before.abort();
  await assert.rejects(session(3000, before.signal).run({}), /CANCELLED/u);
  const controller = new AbortController();
  const value = session(3000, controller.signal);
  await value.run({});
  const pending = assert.rejects(value.run({ spin: true }), /CANCELLED/u);
  controller.abort();
  await pending;
  await assert.rejects(value.run({}), /CANCELLED/u);
});

test('explicit close is idempotent and rejects pending work after terminating the worker', async () => {
  const value = session();
  const pending = assert.rejects(value.run({ delay: 5000 }), /RISU_NATIVE_WORKER_CLOSED/u);
  await value.close();
  await pending;
  await value.close();
  await assert.rejects(value.run({}), /RISU_NATIVE_WORKER_CLOSED/u);
});

test('worker exit and input clone failures are terminal, not cached successes', async () => {
  const exited = session();
  await assert.rejects(exited.run({ exit: true }), /RISU_NATIVE_WORKER_EXIT/u);
  await assert.rejects(exited.run({}), /RISU_NATIVE_WORKER_EXIT/u);
  const cloned = session();
  await assert.rejects(cloned.run({ text: () => 'not cloneable' } as unknown as Input));
  await assert.rejects(cloned.run({}));
});

test('invalid timeout values fail before worker startup', () => {
  for (const timeout of [0, 9, 15001, NaN, Infinity, 10.5])
    assert.throws(() => session(timeout), /RISU_NATIVE_TIMEOUT_INVALID/u);
});
