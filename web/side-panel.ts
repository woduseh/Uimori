import {
  readPresentationChoice,
  readPresentationSetting,
  writePresentationSetting,
} from './presentation-settings.js';

export type SidePanelTab = 'helper' | 'outline' | 'options' | 'board';
export type WorkspacePanelState = SidePanelTab | 'helper-workspace' | 'closed';

export const MIN_CENTER_WIDTH = 768;
export const SIDE_PANEL_MAX_WIDTH = 960;
export const SIDE_PANEL_KEY_STEP = 16;
const SIDE_PANEL_DEFAULT_WIDTH = 384;
const SIDE_PANEL_WIDTH_KEY = 'uimori:panel-width';
const minimumWidths: Record<SidePanelTab, number> = {
  helper: 360,
  options: 360,
  outline: 400,
  board: 360,
};

export function sidePanelMinimumWidth(tab: SidePanelTab) {
  return minimumWidths[tab];
}

export function readSidePanelWidth() {
  const stored = readPresentationSetting(SIDE_PANEL_WIDTH_KEY)?.trim();
  const value = stored ? Number(stored) : Number.NaN;
  return Number.isFinite(value)
    ? Math.round(Math.min(SIDE_PANEL_MAX_WIDTH, Math.max(minimumWidths.helper, value)))
    : SIDE_PANEL_DEFAULT_WIDTH;
}

export function writeSidePanelWidth(width: number) {
  writePresentationSetting(SIDE_PANEL_WIDTH_KEY, String(width));
}

export function fitSidePanelWidth(preferred: number, minimum: number, room: number) {
  const width = Math.min(SIDE_PANEL_MAX_WIDTH, Math.max(minimum, preferred));
  return room >= minimum ? Math.min(width, room) : width;
}

const WORKSPACE_PANEL_KEY = 'uimori:workspace-panel';
const workspacePanelStates: WorkspacePanelState[] = [
  'closed',
  'helper',
  'outline',
  'options',
  'board',
  'helper-workspace',
];

export function readWorkspacePanelState() {
  const navigation = performance.getEntriesByType('navigation')[0] as
    | PerformanceNavigationTiming
    | undefined;
  const ownSession = (!location.search && !location.hash) || navigation?.type === 'reload';
  return ownSession
    ? readPresentationChoice<WorkspacePanelState>(
        WORKSPACE_PANEL_KEY,
        workspacePanelStates,
        'closed'
      )
    : 'closed';
}

export function writeWorkspacePanelState(state: WorkspacePanelState) {
  writePresentationSetting(WORKSPACE_PANEL_KEY, state);
}
