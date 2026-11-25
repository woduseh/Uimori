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
const modelSettings = 'taskTrace.toolModelSettings';
const appearance = 'taskTrace.toolAppearance';
const codeCheck = 'taskTrace.toolCodeCheck';
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
  'chat.bookmark': change,
  'chat.organize': change,
  'chat.lore': change,
  'chat.guide.update': change,
  'chat.profile.update': change,
  'chat.variables.update': change,
  'library.organize': change,
  'scene.context.update': change,
  'options.fix': change,
  'options.oneoff': change,
  'illustration-preset.select': change,
  'model.register': modelSettings,
  'model.delete': modelSettings,
  'model.parameters.update': modelSettings,
  'model.pricing.update': modelSettings,
  'model.pricing.backfill': modelSettings,
  'vertex.location.update': modelSettings,
  'font.register': appearance,
  'font.delete': appearance,
  'font.select': appearance,
  'palette.save': appearance,
  'palette.delete': appearance,
  'theme.select': appearance,
  'code.cbs': codeCheck,
  'code.diagnose': codeCheck,
  'code.preview': codeCheck,
  'code.references': codeCheck,
  'code.regex': codeCheck,
  'preset.validate': codeCheck,
  'web.search': 'taskTrace.toolWebSearch',
  'helper.ask': 'taskTrace.toolAsk',
  'task.cancel': 'taskTrace.toolTaskControl',
  'task.retry': 'taskTrace.toolTaskControl',
  'app.call': 'helpers.m200',
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
  'illustration.continuity.save': illustrationEdit,
  'illustration.references.save': illustrationEdit,
  'data.exec': 'helpers.activityShell',
};
export function helperToolKind(name = ''): string | undefined {
  return toolKinds[name] ?? (isHelperReadTool(name) ? read : undefined);
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

const refusalRetry = (retry: HelperProviderRetry) =>
  retry.code.startsWith('HELPER_RESPONSE_REFUSED');

export function helperRetrySentence(retry: HelperProviderRetry) {
  return t('helpers.activityRetrying', {
    reason: refusalRetry(retry) ? 'refused' : retry.code === 'HTTP_429' ? 'limit' : 'server',
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
  const modelCalls = activity.events.filter(
    (event) => event.kind === 'attempt.started' && attemptKind(event.purpose) === modelCall
  ).length;
  let call = Math.max(0, activity.helperCalls - modelCalls);
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
        if (event.elapsedMs !== undefined) stage.elapsedMs = event.elapsedMs;
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
        stage.elapsedMs = event.elapsedMs;
        stage.resultChars = event.resultChars;
        continue;
      }
    }
    const tool = event.kind === 'tool.finished' || event.kind === 'tool.started';
    const kind =
      event.kind === 'attempt.started'
        ? attemptKind(event.purpose)
        : tool
          ? (helperToolKind(event.name) ?? 'helpers.m200')
          : event.kind === 'context.compaction'
            ? 'helpers.m197'
            : event.kind === 'progress'
              ? 'helpers.m202'
              : event.retry
                ? refusalRetry(event.retry)
                  ? 'helpers.activityRetryRefused'
                  : 'helpers.activityRetryWait'
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
    const numbered = event.kind === 'attempt.started' && kind === modelCall ? ++call : undefined;
    const stage: Stage = {
      id: event.seq,
      kind,
      label:
        tool && event.name && !helperToolKind(event.name)
          ? event.name
          : numbered
            ? t('taskTrace.modelCall', { count: numbered })
            : t(kind),
      target: targetLabel(event.target),
      ...(event.target ? { subject: event.target } : {}),
      ...(tool && event.name ? { tool: event.name } : {}),
      ...(numbered ? { call: numbered } : {}),
      ...(event.elapsedMs !== undefined ? { elapsedMs: event.elapsedMs } : {}),
      ...(event.resultChars !== undefined ? { resultChars: event.resultChars } : {}),
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
