import { formatNumber, t } from './i18n.js';
import type { HelperActivity, HelperActivityEvent } from '../core/helper-activity.js';

type Stage = {
  id: number;
  kind: string;
  label: string;
  target?: string;
  state: 'running' | 'completed' | 'issue' | 'stopped' | 'recorded';
  events: HelperActivityEvent[];
};
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
  'scene.versions': read,
  'scene.lore': read,
  'scene.regex': read,
  'illustration.generate': illustrationDraw,
  'illustration.cut.redraw': illustrationDraw,
  'illustration.cut.revise': illustrationDraw,
  'illustration.cut.delete': illustrationEdit,
  'illustration.cuts.place': illustrationEdit,
  'illustration.profiles.save': illustrationEdit,
  'data.exec': 'helpers.activityShell',
};
function toolKind(name = '') {
  return (
    toolKinds[name] ??
    (/\.(read|list|search|inspect|guide|tools)$/u.test(name) ? read : 'helpers.m200')
  );
}
function targetLabel(target: HelperActivityEvent['target']) {
  if (!target) return undefined;
  if ('count' in target)
    return t('helpers.activityTargetCount', { count: formatNumber(target.count) });
  return target.title || (target.kind === 'scene' ? t('helpers.activityTargetScene') : undefined);
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

export function helperActivityStages(activity: HelperActivity): Stage[] {
  const stages: Stage[] = [];
  const attempts = new Map<string, Stage>();
  const tools = new Map<string, Stage>();
  for (const event of activity.events) {
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
        const index = stages.indexOf(stage);
        const previous = stages[index - 1];
        if (
          index === stages.length - 1 &&
          stage.state === 'completed' &&
          stage.kind === read &&
          previous?.kind === read &&
          previous.state === 'completed' &&
          previous.events.every((item) => item.kind === 'tool.finished')
        ) {
          previous.events.push(event);
          previous.target = undefined;
          stages.pop();
        }
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
              : 'helpers.m203';
    const state: Stage['state'] =
      event.kind === 'attempt.started' || event.kind === 'tool.started'
        ? 'running'
        : event.kind === 'attempt.finished'
          ? finishedAttemptState(event.status)
          : event.error || event.denied || ['failed', 'refused'].includes(event.status ?? '')
            ? 'issue'
            : event.kind === 'tool.finished'
              ? 'completed'
              : 'recorded';
    const previous = stages.at(-1);
    if (
      event.kind === 'tool.finished' &&
      state === 'completed' &&
      kind === read &&
      previous?.kind === kind &&
      previous.state === state &&
      previous.events.every((item) => item.kind === 'tool.finished')
    ) {
      previous.events.push(event);
      previous.target = undefined;
    } else {
      const stage: Stage = {
        id: event.seq,
        kind,
        label: t(kind),
        target: targetLabel(event.target),
        state,
        events: [event],
      };
      stages.push(stage);
      if (event.kind === 'attempt.started' && event.attemptId) attempts.set(event.attemptId, stage);
      if (event.kind === 'tool.started' && event.callId) tools.set(event.callId, stage);
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
