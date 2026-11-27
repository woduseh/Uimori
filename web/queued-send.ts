export type QueuedRequest = {
  id: string;
  chatId: string;
  text: string;
  loreContextReset: boolean;
  runId: string;
  settingsRevision: number;
  profileRevision: number;
  optionsRevision: number;
  workspaceRevision: number;
};

export type QueuedRevisions = Pick<
  QueuedRequest,
  'profileRevision' | 'optionsRevision' | 'workspaceRevision'
>;

export type QueuedReturnReason =
  | 'reload'
  | 'left'
  | 'incomplete'
  | 'unknown'
  | 'settings'
  | 'options'
  | 'workspace'
  | 'blocked'
  | 'confirmation'
  | 'rejected';

export type QueuedHandoff = {
  chatId: string;
  text: string;
  loreContextReset: boolean;
  left: boolean;
  state: 'waiting' | 'confirmation' | 'committed' | 'rejected';
};

export type QueuedDispatchEnv = {
  here: () => boolean;
  readRunStatus: () => Promise<string>;
  currentChat: () => { id: string; settingsRevision: number } | undefined;
  readRevisions: () => Promise<QueuedRevisions>;
  send: (handoff: QueuedHandoff) => Promise<boolean>;
  giveBack: (reason: QueuedReturnReason) => void;
  committed: (accepted: boolean) => void;
};

export function mergeReturnedText(current: string, queuedText: string): string {
  return current.trim() ? `${queuedText}\n\n${current}` : queuedText;
}

export async function dispatchQueuedRequest(
  queue: QueuedRequest,
  handoff: QueuedHandoff,
  blocked: boolean,
  env: QueuedDispatchEnv
): Promise<void> {
  const { giveBack } = env;
  if (!env.here()) return giveBack('left');
  let status: string;
  try {
    status = await env.readRunStatus();
  } catch {
    return giveBack('unknown');
  }
  if (status !== 'completed') return giveBack('incomplete');
  if (blocked) return giveBack('blocked');
  const chat = env.currentChat();
  if (!env.here() || chat?.id !== queue.chatId) return giveBack('left');
  if (chat.settingsRevision !== queue.settingsRevision) return giveBack('settings');
  let revisions: QueuedRevisions;
  try {
    revisions = await env.readRevisions();
  } catch {
    return giveBack('blocked');
  }
  if (!env.here()) return giveBack('left');
  if (revisions.profileRevision !== queue.profileRevision) return giveBack('settings');
  if (revisions.optionsRevision !== queue.optionsRevision) return giveBack('options');
  if (revisions.workspaceRevision !== queue.workspaceRevision) return giveBack('workspace');
  const accepted = await env.send(handoff);
  if (handoff.state === 'committed') return env.committed(accepted);
  if (!env.here()) return giveBack('left');
  giveBack(
    handoff.state === 'rejected'
      ? 'rejected'
      : handoff.state === 'confirmation'
        ? 'confirmation'
        : 'blocked'
  );
}
