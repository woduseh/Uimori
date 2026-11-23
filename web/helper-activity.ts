import { formatNumber, t } from './i18n.js';
import type {
  HelperActivity,
  HelperActivityEvent,
  HelperProviderRetry,
} from '../core/helper-activity.js';
import { isHelperReadTool, type HelperActivityStage as Stage } from './helper-activity-groups.js';

const change = 'helpers.m196';
const read = 'helpers.m199';
const sceneEdit = 'helpers.activitySceneEdit';
const illustrationDraw = 'helpers.activityIllustrationDraw';
const illustrationEdit = 'helpers.activityIllustrationEdit';
const toolKinds: Record<string, string> = {
  'resource.patch': change,
  'resource.patchMany': change,
  'resource.save': change,
  'resource.clone': change,
  'resource.undo': change,
  'resource.delete': change,
  'image.update-metadata': change,
  'settings.update': change,
  'outline.write': change,
  'notes.write': change,
  'context.edit': change,
  'chat.rename': change,
  'chat.fork': change,
  'context.compact': 'helpers.m197',
  'artifact.generate': 'helpers.m198',
  'scene.patch': sceneEdit,
  'scene.patchMany': sceneEdit,
  'scene.restore': sceneEdit,
  'scene.title': sceneEdit,
  'scene.request': 'helpers.activitySceneRequest',
  'scene.translate': 'helpers.activitySceneTranslate',
  'illustration.generate': illustrationDraw,
  'illustration.cut.redraw': illustrationDraw,
  'illustration.cut.revise': illustrationDraw,
  'illustration.cut.delete': illustrationEdit,
  'illustration.cuts.place': illustrationEdit,
  'illustration.profiles.save': illustrationEdit,
  'data.exec': 'helpers.activityShell',
};
function toolKind(name = '') {
  return toolKinds[name] ?? (isHelperReadTool(name) ? read : 'helpers.m200');
}
function targetLabel(target: HelperActivityEvent['target']) {
  if (!target) return undefined;
  if ('count' in target)
    return t('helpers.activityTargetCount', { count: formatNumber(target.count) });
  return target.title || (target.kind === 'scene' ? t('helpers.activityTargetScene') : undefined);
}
const modelCall = 'helpers.m201';
const attemptKind = (purpose?: string) =>
  purpose === 'context'
    ? 'helpers.m197'
    : purpose === 'artifact' || purpose === 'writing'
      ? 'helpers.m198'
      : modelCall;
const finishedAttemptState = (status?: string): Stage['state'] =>
  status === 'completed' || status === 'tool_calls'
    ? 'completed'
    : status === 'cancelled'
      ? 'stopped'
      : 'issue';

export function helperRetrySentence(retry: HelperProviderRetry) {
  return t('helpers.activityRetrying', {
    reason: retry.code === 'HTTP_429' ? 'limit' : 'server',
    seconds: Math.round(retry.delayMs / 1000),
    attempt: retry.attempt,
    attempts: retry.attempts,
  });
}

export function helperActivityStages(activity: HelperActivity): Stage[] {
  const stages: Stage[] = [];
  const attempts = new Map<string, Stage>();
  const tools = new Map<string, Stage>();
  let retryWait: Stage | undefined;
  for (const event of activity.events) {
    if (retryWait) {
      retryWait.state = 'recorded';
      retryWait = undefined;
    }
    if (event.kind === 'attempt.finished') {
      const stage = event.attemptId ? attempts.get(event.attemptId) : undefined;
      if (stage) {
        stage.events.push(event);
        stage.state = finishedAttemptState(event.status);
        continue;
      }
    }
    if (event.kind === 'tool.finished' && event.callId) {
      const stage = tools.get(event.callId);
      if (stage) {
        stage.events = [event];
        stage.state =
          event.error || event.denied || ['failed', 'refused'].includes(event.status ?? '')
            ? 'issue'
            : 'completed';
        continue;
      }
    }
    const kind =
      event.kind === 'attempt.started'
        ? attemptKind(event.purpose)
        : event.kind === 'tool.finished' || event.kind === 'tool.started'
          ? toolKind(event.name)
          : event.kind === 'context.compaction'
            ? 'helpers.m197'
            : event.kind === 'progress'
              ? 'helpers.m202'
              : event.retry
                ? 'helpers.activityRetryWait'
                : 'helpers.m203';
    const state: Stage['state'] =
      event.kind === 'attempt.started' || event.kind === 'tool.started' || event.retry
        ? 'running'
        : event.kind === 'attempt.finished'
          ? finishedAttemptState(event.status)
          : event.error || event.denied || ['failed', 'refused'].includes(event.status ?? '')
            ? 'issue'
            : event.kind === 'tool.finished'
              ? 'completed'
              : 'recorded';
    const stage: Stage = {
      id: event.seq,
      kind,
      label: t(kind),
      target: targetLabel(event.target),
      ...(event.target ? { subject: event.target } : {}),
      state,
      events: [event],
    };
    stages.push(stage);
    if (event.kind === 'attempt.started' && event.attemptId) attempts.set(event.attemptId, stage);
    if (event.kind === 'tool.started' && event.callId) tools.set(event.callId, stage);
    if (event.retry) retryWait = stage;
  }
  if (!['running', 'queued'].includes(activity.status))
    for (const stage of stages) if (stage.state === 'running') stage.state = 'stopped';
  return stages;
}

export function helperActivitySummary(activity?: HelperActivity | null): string | undefined {
  if (activity?.status !== 'running') return undefined;
  const current = helperActivityStages(activity).findLast((stage) => stage.state === 'running');
  if (!current) return undefined;
  const retry = current.events[0]?.retry;
  if (retry) return helperRetrySentence(retry);
  if (current.kind === modelCall && activity.helperCalls)
    return t('helpers.activityModelWaiting', { call: activity.helperCalls });
  return current.target
    ? t('helpers.activityRunningTarget', { label: current.label, target: current.target })
    : t('helpers.activityRunning', { label: current.label });
}
