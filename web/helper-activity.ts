import { t } from './i18n.js';
import type { HelperActivity, HelperActivityEvent } from '../core/helper-activity.js';

type Stage = {
  id: number;
  kind: string;
  label: string;
  state: 'running' | 'completed' | 'issue' | 'stopped' | 'recorded';
  events: HelperActivityEvent[];
};
const mutationTools = new Set([
  'resource.patch',
  'resource.save',
  'resource.undo',
  'resource.delete',
  'image.update-metadata',
  'settings.update',
  'outline.write',
  'notes.write',
  'context.edit',
  'chat.rename',
  'chat.fork',
]);
function toolKind(name = '') {
  if (mutationTools.has(name)) return 'helpers.m196';
  if (name === 'context.compact') return 'helpers.m197';
  if (name === 'artifact.generate') return 'helpers.m198';
  if (/\.(read|list|search|inspect|guide|tools)$/u.test(name)) return 'helpers.m199';
  return 'helpers.m200';
}
const attemptKind = (purpose?: string) =>
  purpose === 'context'
    ? 'helpers.m197'
    : purpose === 'artifact' || purpose === 'writing'
      ? 'helpers.m198'
      : 'helpers.m201';
const finishedAttemptState = (status?: string): Stage['state'] =>
  status === 'completed' || status === 'tool_calls'
    ? 'completed'
    : status === 'cancelled'
      ? 'stopped'
      : 'issue';

/** Only observed starts and finishes become stages; a finished tool is never called running. */
export function helperActivityStages(activity: HelperActivity): Stage[] {
  const stages: Stage[] = [];
  const attempts = new Map<string, Stage>();
  for (const event of activity.events) {
    if (event.kind === 'attempt.finished') {
      const stage = event.attemptId ? attempts.get(event.attemptId) : undefined;
      if (stage) {
        stage.events.push(event);
        stage.state = finishedAttemptState(event.status);
        continue;
      }
    }
    const kind =
      event.kind === 'attempt.started'
        ? attemptKind(event.purpose)
        : event.kind === 'tool.finished'
          ? toolKind(event.name)
          : event.kind === 'context.compaction'
            ? 'helpers.m197'
            : event.kind === 'progress'
              ? 'helpers.m202'
              : 'helpers.m203';
    const state: Stage['state'] =
      event.kind === 'attempt.started'
        ? 'running'
        : event.kind === 'attempt.finished'
          ? finishedAttemptState(event.status)
          : event.error || event.denied || ['failed', 'refused'].includes(event.status ?? '')
            ? 'issue'
            : event.kind === 'tool.finished'
              ? 'completed'
              : 'recorded';
    const previous = stages.at(-1);
    // Only adjacent successful lookups share a heading. Mutations remain individually visible.
    if (
      event.kind === 'tool.finished' &&
      state === 'completed' &&
      kind === 'helpers.m199' &&
      previous?.kind === kind &&
      previous.state === state &&
      previous.events.every((item) => item.kind === 'tool.finished')
    ) {
      previous.events.push(event);
    } else {
      const stage: Stage = { id: event.seq, kind, label: t(kind), state, events: [event] };
      stages.push(stage);
      if (event.kind === 'attempt.started' && event.attemptId) attempts.set(event.attemptId, stage);
    }
  }
  if (!['running', 'queued'].includes(activity.status))
    for (const stage of stages) if (stage.state === 'running') stage.state = 'stopped';
  return stages;
}

export function helperActivitySummary(activity?: HelperActivity | null): string | undefined {
  if (activity?.status !== 'running') return undefined;
  const current = helperActivityStages(activity).findLast((stage) => stage.state === 'running');
  if (!current) return undefined;
  return t('helpers.m336', {
    kind:
      current.kind === 'helpers.m197'
        ? 'summary'
        : current.kind === 'helpers.m198'
          ? 'whatif'
          : 'request',
  });
}
