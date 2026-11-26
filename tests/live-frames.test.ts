import { expect, test } from 'vitest';
import { activityFrame, helperDataFrame, promptWorkspaceFrame } from '../web/live-frames.js';
import type { LiveFrame } from '../web/live-stream.js';

const chats = (kind: string, chatId: string | null = 'chat-1'): LiveFrame => ({
  event: 'chats',
  seq: 1,
  chatId,
  kind,
  entityId: null,
});
const helper = (kind: string, taskId: string | null = 'task-1'): LiveFrame => ({
  event: 'helper',
  seq: 1,
  conversationId: 'conversation-1',
  taskId,
  kind,
});
const invalidate = (name: string): LiveFrame => ({ event: 'invalidate', name });

test('the activity feed reads on status changes of runs, jobs, illustrations and helper tasks only', () => {
  for (const frame of [
    chats('run.queued'),
    chats('run.completed'),
    chats('job.failed'),
    chats('illustration.interrupted'),
    chats('helper.task.completed'),
    helper('task.running'),
    invalidate('activity'),
  ])
    expect(activityFrame(frame), JSON.stringify(frame)).toBe(true);
  for (const frame of [
    chats('run.context.updated'),
    chats('context.job.completed'),
    chats('illustration-layout.updated'),
    chats('scene.updated'),
    chats('helper.artifact.saved'),
    helper('tool.started'),
    helper('artifact.saved'),
    invalidate('helper-list'),
  ])
    expect(activityFrame(frame), JSON.stringify(frame)).toBe(false);
});

test('helper data readers wake on finished tasks and saved settings or resources, not on progress', () => {
  for (const kind of [
    'task.completed',
    'task.interrupted',
    'task.rolled-back',
    'artifact.saved',
    'settings.updated',
    'resource.updated',
  ])
    expect(helperDataFrame(helper(kind)), kind).toBe(true);
  for (const kind of ['task.running', 'tool.finished', 'theme.updated'])
    expect(helperDataFrame(helper(kind)), kind).toBe(false);
  expect(helperDataFrame(chats('helper.task.completed'))).toBe(false);
  expect(promptWorkspaceFrame(chats('prompt-workspace.updated', null))).toBe(true);
  expect(promptWorkspaceFrame(helper('prompt-workspace.updated'))).toBe(false);
});
