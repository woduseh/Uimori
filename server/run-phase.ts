import type { RunPhase, RunSnapshot } from '../core/types.js';
import { loreSelectionPending } from './lore-selection.js';
import { nativeRisuPending } from './risu-native-run.js';

export function runPhase(snapshot: RunSnapshot): RunPhase {
  const lore = loreSelectionPending(snapshot);
  const context = snapshot.contextPlan
    ? snapshot.contextPlan.status === 'pending'
    : lore || snapshot.nativeRisuExecution !== undefined || nativeRisuPending(snapshot);
  if (context) return 'context';
  if (lore) return 'lore';
  const guide = snapshot.storyGuide;
  if (guide?.config.enabled && !guide.brief && !guide.error) return 'story-guide';
  return 'writing';
}
