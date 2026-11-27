import { expect, test, vi, type Mock } from 'vitest';
import {
  dispatchQueuedRequest,
  mergeReturnedText,
  type QueuedDispatchEnv,
  type QueuedHandoff,
  type QueuedRequest,
  type QueuedReturnReason,
} from '../web/queued-send.js';

const queue: QueuedRequest = {
  id: 'q1',
  chatId: 'chat-1',
  text: '계속 써 주세요.',
  loreContextReset: false,
  runId: 'run-1',
  settingsRevision: 4,
  profileRevision: 7,
  optionsRevision: 2,
  workspaceRevision: 9,
};

type MockEnv = { [K in keyof QueuedDispatchEnv]: Mock<QueuedDispatchEnv[K]> };

function setup(
  overrides: Partial<MockEnv> = {},
  handoffState: QueuedHandoff['state'] = 'committed'
) {
  const handoff: QueuedHandoff = {
    chatId: queue.chatId,
    text: queue.text,
    loreContextReset: false,
    left: false,
    state: 'waiting',
  };
  const env: MockEnv = {
    here: vi.fn(() => !handoff.left),
    readRunStatus: vi.fn(async () => 'completed'),
    currentChat: vi.fn(() => ({ id: queue.chatId, settingsRevision: queue.settingsRevision })),
    readRevisions: vi.fn(async () => ({
      profileRevision: queue.profileRevision,
      optionsRevision: queue.optionsRevision,
      workspaceRevision: queue.workspaceRevision,
    })),
    send: vi.fn(async (item: QueuedHandoff) => {
      item.state = handoffState;
      return handoffState === 'committed';
    }),
    giveBack: vi.fn<(reason: QueuedReturnReason) => void>(),
    committed: vi.fn<(accepted: boolean) => void>(),
    ...overrides,
  };
  return {
    handoff,
    env,
    run: (blocked = false) => dispatchQueuedRequest(queue, handoff, blocked, env),
  };
}

function expectReturnedWithoutSending(
  { env }: ReturnType<typeof setup>,
  reason: QueuedReturnReason
) {
  expect(env.send).not.toHaveBeenCalled();
  expect(env.giveBack.mock.calls).toEqual([[reason]]);
  expect(env.committed).not.toHaveBeenCalled();
}

test('a queued request is sent exactly once when every guard passes', async () => {
  const flow = setup();
  await flow.run();
  expect(flow.env.send).toHaveBeenCalledTimes(1);
  expect(flow.env.send).toHaveBeenCalledWith(flow.handoff);
  expect(flow.env.giveBack).not.toHaveBeenCalled();
  expect(flow.env.committed).toHaveBeenCalledWith(true);
});

test.each(['failed', 'cancelled', 'running', 'queued'])(
  'a previous run that ended as %s returns the request to the draft instead of sending it',
  async (status) => {
    const flow = setup({ readRunStatus: vi.fn(async () => status) });
    await flow.run();
    expectReturnedWithoutSending(flow, 'incomplete');
    expect(flow.env.readRevisions).not.toHaveBeenCalled();
  }
);

test('a run status that cannot be read returns the request without sending it', async () => {
  const flow = setup({
    readRunStatus: vi.fn(async () => {
      throw new Error('offline');
    }),
  });
  await flow.run();
  expectReturnedWithoutSending(flow, 'unknown');
});

test('a blocked composer returns the request without sending or reading revisions', async () => {
  const flow = setup();
  await flow.run(true);
  expectReturnedWithoutSending(flow, 'blocked');
  expect(flow.env.readRevisions).not.toHaveBeenCalled();
});

test('a chat settings revision change returns the request without sending it', async () => {
  const flow = setup({
    currentChat: vi.fn(() => ({ id: queue.chatId, settingsRevision: queue.settingsRevision + 1 })),
  });
  await flow.run();
  expectReturnedWithoutSending(flow, 'settings');
  expect(flow.env.readRevisions).not.toHaveBeenCalled();
});

test.each([
  ['profileRevision', 'settings'],
  ['optionsRevision', 'options'],
  ['workspaceRevision', 'workspace'],
] as const)('a changed %s returns the request as %s without sending it', async (field, reason) => {
  const flow = setup({
    readRevisions: vi.fn(async () => ({
      profileRevision: queue.profileRevision,
      optionsRevision: queue.optionsRevision,
      workspaceRevision: queue.workspaceRevision,
      [field]: queue[field] + 1,
    })),
  });
  await flow.run();
  expectReturnedWithoutSending(flow, reason);
});

test('revisions that cannot be read return the request as blocked without sending it', async () => {
  const flow = setup({
    readRevisions: vi.fn(async () => {
      throw new Error('offline');
    }),
  });
  await flow.run();
  expectReturnedWithoutSending(flow, 'blocked');
});

test('a different or missing chat in the reader returns the request as left', async () => {
  for (const currentChat of [
    vi.fn(() => ({ id: 'other', settingsRevision: queue.settingsRevision })),
    vi.fn(() => undefined),
  ]) {
    const flow = setup({ currentChat });
    await flow.run();
    expectReturnedWithoutSending(flow, 'left');
  }
});

test('leaving the chat before any guard returns the request without a single read', async () => {
  const flow = setup({ here: vi.fn(() => false) });
  await flow.run();
  expectReturnedWithoutSending(flow, 'left');
  expect(flow.env.readRunStatus).not.toHaveBeenCalled();
});

test('leaving the chat while the revisions are read returns the request without sending it', async () => {
  const flow = setup();
  flow.env.readRevisions.mockImplementation(async () => {
    flow.handoff.left = true;
    return {
      profileRevision: queue.profileRevision,
      optionsRevision: queue.optionsRevision,
      workspaceRevision: queue.workspaceRevision,
    };
  });
  await flow.run();
  expectReturnedWithoutSending(flow, 'left');
});

test('a send that needs confirmation is returned for the user instead of being committed', async () => {
  const flow = setup({}, 'confirmation');
  await flow.run();
  expect(flow.env.send).toHaveBeenCalledTimes(1);
  expect(flow.env.giveBack.mock.calls).toEqual([['confirmation']]);
  expect(flow.env.committed).not.toHaveBeenCalled();
});

test('a send the server rejected is returned to the draft', async () => {
  const flow = setup({}, 'rejected');
  await flow.run();
  expect(flow.env.giveBack.mock.calls).toEqual([['rejected']]);
  expect(flow.env.committed).not.toHaveBeenCalled();
});

test('a send that never reached admission is returned as blocked', async () => {
  const flow = setup({}, 'waiting');
  await flow.run();
  expect(flow.env.giveBack.mock.calls).toEqual([['blocked']]);
});

test('leaving the chat during an unaccepted send returns the request as left', async () => {
  const flow = setup({}, 'waiting');
  flow.env.send.mockImplementation(async () => {
    flow.handoff.left = true;
    return false;
  });
  await flow.run();
  expect(flow.env.giveBack.mock.calls).toEqual([['left']]);
});

test('a committed send is never given back even if the user left meanwhile', async () => {
  const flow = setup();
  flow.env.send.mockImplementation(async (item) => {
    item.state = 'committed';
    flow.handoff.left = true;
    return true;
  });
  await flow.run();
  expect(flow.env.giveBack).not.toHaveBeenCalled();
  expect(flow.env.committed).toHaveBeenCalledWith(true);
});

test('a returned request goes in front of what the user typed meanwhile', () => {
  expect(mergeReturnedText('', '계속 써 주세요.')).toBe('계속 써 주세요.');
  expect(mergeReturnedText('  \n', '계속 써 주세요.')).toBe('계속 써 주세요.');
  expect(mergeReturnedText('덧붙일 말', '계속 써 주세요.')).toBe('계속 써 주세요.\n\n덧붙일 말');
});
