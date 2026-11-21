import type { HelperActivityEvent, HelperActivityTarget } from '../core/helper-activity.js';

export type HelperActivityState = 'running' | 'completed' | 'issue' | 'stopped' | 'recorded';
export type HelperActivityStage = {
  id: number;
  kind: string;
  label: string;
  target?: string;
  subject?: HelperActivityTarget;
  state: HelperActivityState;
  events: HelperActivityEvent[];
};
export type HelperReadSummary = { scenes: number; resources: number; lookups: number };
export type HelperActivityRow =
  | { kind: 'stage'; stage: HelperActivityStage }
  | {
      kind: 'reads';
      id: number;
      state: HelperActivityState;
      summary: HelperReadSummary;
      stages: HelperActivityStage[];
    };

const readTools = new Set(['scene.versions', 'scene.lore', 'scene.regex']);

export function isHelperReadTool(name = '') {
  return readTools.has(name) || /\.(read|list|search|inspect|guide|tools)$/u.test(name);
}

const toolName = (stage: HelperActivityStage) =>
  stage.events.find((event) => event.kind === 'tool.started' || event.kind === 'tool.finished')
    ?.name;

const groupable = (stage: HelperActivityStage) =>
  stage.state !== 'issue' &&
  stage.state !== 'recorded' &&
  stage.events.every((event) => event.kind === 'tool.started' || event.kind === 'tool.finished') &&
  isHelperReadTool(toolName(stage));

export function summarizeHelperReads(stages: readonly HelperActivityStage[]): HelperReadSummary {
  const scenes = new Set<string>();
  const resources = new Set<string>();
  let untitledScenes = 0;
  let untitledResources = 0;
  let lookups = 0;
  for (const stage of stages) {
    const target = stage.subject;
    if (!target) lookups++;
    else if ('count' in target) untitledResources += target.count;
    else if (target.kind === 'scene') {
      if (target.title) scenes.add(target.title);
      else untitledScenes++;
    } else if (target.title) resources.add(`${target.kind}:${target.title}`);
    else untitledResources++;
  }
  return {
    scenes: scenes.size + untitledScenes,
    resources: resources.size + untitledResources,
    lookups,
  };
}

function groupState(stages: readonly HelperActivityStage[]): HelperActivityState {
  if (stages.some((stage) => stage.state === 'running')) return 'running';
  if (stages.some((stage) => stage.state === 'stopped')) return 'stopped';
  return 'completed';
}

export function groupHelperActivity(stages: readonly HelperActivityStage[]): HelperActivityRow[] {
  const rows: HelperActivityRow[] = [];
  let run: HelperActivityStage[] = [];
  const flush = () => {
    if (run.length > 1)
      rows.push({
        kind: 'reads',
        id: run[0]!.id,
        state: groupState(run),
        summary: summarizeHelperReads(run),
        stages: run,
      });
    else if (run.length) rows.push({ kind: 'stage', stage: run[0]! });
    run = [];
  };
  for (const stage of stages) {
    if (groupable(stage)) {
      run.push(stage);
      continue;
    }
    flush();
    rows.push({ kind: 'stage', stage });
  }
  flush();
  return rows;
}
