import type { HelperActivity, HelperActivityEvent } from '../core/helper-activity.js';

type Stage = {
  id: number;
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
function toolLabel(name = '') {
  if (mutationTools.has(name)) return '자료·설정 변경';
  if (name === 'context.compact') return '대화 내용 정리';
  if (name === 'artifact.generate') return '가정 장면 작성';
  if (/\.(read|list|search|inspect|guide|tools)$/u.test(name)) return '자료 확인';
  return '도구 실행';
}
const attemptLabel = (purpose?: string) =>
  purpose === 'context'
    ? '대화 내용 정리'
    : purpose === 'artifact' || purpose === 'writing'
      ? '가정 장면 작성'
      : '요청 처리';

/** Only observed starts and finishes become stages; a finished tool is never called running. */
export function helperActivityStages(activity: HelperActivity): Stage[] {
  const stages: Stage[] = [];
  const attempts = new Map<string, Stage>();
  for (const event of activity.events) {
    if (event.kind === 'attempt.finished') {
      const stage = event.attemptId ? attempts.get(event.attemptId) : undefined;
      if (stage) {
        stage.events.push(event);
        stage.state = ['completed', 'tool_calls'].includes(event.status ?? '')
          ? 'completed'
          : event.status === 'cancelled'
            ? 'stopped'
            : 'issue';
        continue;
      }
    }
    const label =
      event.kind === 'attempt.started'
        ? attemptLabel(event.purpose)
        : event.kind === 'tool.finished'
          ? toolLabel(event.name)
          : event.kind === 'context.compaction'
            ? '대화 내용 정리'
            : event.kind === 'progress'
              ? '도우미 진행 메시지'
              : '실행 기록';
    const state: Stage['state'] =
      event.kind === 'attempt.started'
        ? 'running'
        : event.error || event.denied || ['failed', 'refused'].includes(event.status ?? '')
          ? 'issue'
          : event.kind === 'tool.finished'
            ? 'completed'
            : 'recorded';
    const previous = stages.at(-1);
    // Adjacent successful reads/edits share one heading; every original record remains below it.
    if (
      event.kind === 'tool.finished' &&
      state === 'completed' &&
      previous?.label === label &&
      previous.state === state &&
      previous.events.every((item) => item.kind === 'tool.finished')
    ) {
      previous.events.push(event);
    } else {
      const stage: Stage = { id: event.seq, label, state, events: [event] };
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
  return current.label === '요청 처리'
    ? '도우미가 요청을 처리하고 있어요'
    : `${current.label} 중이에요`;
}
