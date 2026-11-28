import type { LiveFrame } from './live-stream.js';
import type { HelperEvent } from '../core/helper.js';

export const diagnosticHelperEvent = ({ kind, taskId }: Pick<HelperEvent, 'kind' | 'taskId'>) =>
  kind === 'tool.started' ||
  kind === 'tool.finished' ||
  kind === 'input.measured' ||
  kind === 'progress' ||
  (kind.startsWith('context.') && !(taskId === null && kind.startsWith('context.compaction')));

const finishedTask = /^task\.(?:completed|failed|cancelled|interrupted|rolled-back)$/u;
const helperDataKinds = new Set(['artifact.saved', 'settings.updated', 'resource.updated']);
const chatTitleKind = /^chat\.title\.(?:manual|generated)$/u;
const activityKind = /^(?:run|job|illustration)\.[a-z]+$/u;

export const helperListFrame = (frame: LiveFrame) =>
  frame.event === 'invalidate' && frame.name === 'helper-list';

export const helperListChange: LiveFrame = { event: 'invalidate', name: 'helper-list' };

export const helperSessionsFrame = (
  frame: LiveFrame,
  options: { chatTitles: boolean; chatIds: () => readonly string[] }
) =>
  frame.event === 'invalidate'
    ? helperListFrame(frame)
    : frame.event === 'helper'
      ? !diagnosticHelperEvent(frame)
      : options.chatTitles &&
        chatTitleKind.test(frame.kind) &&
        frame.chatId !== null &&
        options.chatIds().includes(frame.chatId);

export const helperDataFrame = (frame: LiveFrame) =>
  frame.event === 'helper' && (finishedTask.test(frame.kind) || helperDataKinds.has(frame.kind));

export const resourceFrame = (frame: LiveFrame) =>
  helperDataFrame(frame) || (frame.event === 'invalidate' && frame.name === 'resources');

export const presentationFrame =
  (catalog: 'themes' | 'illustration-presets' | 'fonts') => (frame: LiveFrame) =>
    frame.event === 'invalidate' && frame.name === catalog;

export const promptWorkspaceFrame = (frame: LiveFrame) =>
  frame.event === 'chats' && frame.kind === 'prompt-workspace.updated';

export const activityFrame = (frame: LiveFrame) =>
  frame.event === 'chats'
    ? activityKind.test(frame.kind) || frame.kind.startsWith('helper.task.')
    : frame.event === 'helper'
      ? frame.kind.startsWith('task.')
      : frame.name === 'activity';

export const promptWorkspaceChange: LiveFrame = {
  event: 'chats',
  seq: 0,
  chatId: null,
  kind: 'prompt-workspace.updated',
  entityId: null,
};

export const helperChange = (kind: string, taskId: string | null = null): LiveFrame => ({
  event: 'helper',
  seq: 0,
  conversationId: '',
  taskId,
  kind,
});
