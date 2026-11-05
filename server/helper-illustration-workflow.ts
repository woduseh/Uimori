import type { HelperTask, HelperTaskResultTarget } from '../core/helper.js';
import type { Store } from './store.js';
import type { HelperWorkspace } from './helper-workspace.js';
import { recordHelperTaskResult } from './helper-task-results.js';
import {
  saveIllustrationProfiles,
  HELPER_ILLUSTRATION_PROFILE_TOOLS,
} from './helper-illustration-profiles.js';
import {
  generateHelperIllustrations,
  HELPER_ILLUSTRATION_GENERATION_TOOLS,
} from './helper-illustration-generation.js';
import {
  redrawIllustrationCut,
  reviseFailedIllustrationCut,
  deleteIllustrationCut,
  HELPER_ILLUSTRATION_CUT_TOOLS,
} from './helper-illustration-cuts.js';
import {
  saveIllustrationReferenceAssignments,
  HELPER_ILLUSTRATION_REFERENCE_TOOLS,
} from './helper-illustration-references.js';
import {
  saveIllustrationContinuity,
  HELPER_ILLUSTRATION_CONTINUITY_TOOLS,
} from './illustration-continuity.js';
import {
  placeIllustrationCuts,
  HELPER_ILLUSTRATION_PLACEMENT_TOOLS,
} from './helper-illustration-placement.js';
import { HttpError } from './request-validation.js';

export const HELPER_ILLUSTRATION_TOOLS = [
  ...HELPER_ILLUSTRATION_PROFILE_TOOLS,
  ...HELPER_ILLUSTRATION_GENERATION_TOOLS,
  ...HELPER_ILLUSTRATION_CUT_TOOLS,
  ...HELPER_ILLUSTRATION_REFERENCE_TOOLS,
  ...HELPER_ILLUSTRATION_CONTINUITY_TOOLS,
  ...HELPER_ILLUSTRATION_PLACEMENT_TOOLS,
];

/** Commit the change, its receipt and navigable outcomes together. Wake the queue after commit. */
export function applyHelperIllustration(
  store: Store,
  workspace: HelperWorkspace,
  task: HelperTask,
  chatId: string,
  name: string,
  args: Record<string, unknown>,
  operationId: string,
  testMode: boolean,
  publish?: (chatId: string, queued: boolean) => void
) {
  const receiptId = `${task.id}:${operationId}`;
  const scene = (id: string, title: string, revision: number): HelperTaskResultTarget => ({
    kind: 'illustration',
    id,
    chatId,
    title: title.slice(0, 200).replace(/[\uD800-\uDBFF]$/u, ''),
    revision,
  });
  const settings = (setting: string, title: string, revision: number): HelperTaskResultTarget => ({
    kind: 'settings',
    id: chatId,
    title,
    revision,
    setting,
  });
  let changed = false;
  const finish = <T>(value: T, requestedTargets: number, targets: HelperTaskResultTarget[]) => {
    recordHelperTaskResult(workspace, task, {
      receiptId,
      operation: name,
      requestedTargets,
      targets,
    });
    changed = targets.length > 0;
    return value;
  };
  const saved = workspace.operation<unknown>(task.id, receiptId, { name, args, chatId }, () => {
    switch (name) {
      case 'illustration.generate': {
        const result = generateHelperIllustrations(store, chatId, args, { testMode });
        return finish(
          result,
          result.count,
          result.plans.map((p) => scene(p.sourceId, p.focus, p.revision))
        );
      }
      case 'illustration.cut.redraw': {
        const result = redrawIllustrationCut(store, chatId, args, testMode);
        return finish(result, 1, [scene(result.sourceId, result.focus, result.editRevision)]);
      }
      case 'illustration.cut.revise': {
        const result = reviseFailedIllustrationCut(store, chatId, args, testMode);
        return finish(result, 1, [scene(result.sourceId, result.focus, result.editRevision)]);
      }
      case 'illustration.cut.delete': {
        const result = deleteIllustrationCut(store, chatId, args);
        return finish(result, 1, [
          scene(result.sourceId, 'Removed illustration cut', result.editRevision),
        ]);
      }
      case 'illustration.cuts.place': {
        const result = placeIllustrationCuts(store, chatId, args);
        return finish(
          result,
          result.placements.length,
          result.placements
            .filter((p) => p.changed)
            .map((p) => scene(p.sourceId, p.focus, p.revision))
        );
      }
      case 'illustration.continuity.save': {
        const result = saveIllustrationContinuity(store, chatId, args);
        return finish(
          result,
          (args.edits as unknown[]).length,
          result.changedNotes.map((n) => scene(n.sourceId, n.title, result.revision))
        );
      }
      case 'illustration.references.save': {
        const result = saveIllustrationReferenceAssignments(store, chatId, args);
        return finish(
          result,
          result.assignments.length,
          result.assignments
            .filter((a) => a.changed)
            .map((a) => settings('chat.illustrationReferences', a.title, result.revision))
        );
      }
      case 'illustration.profiles.save': {
        const result = saveIllustrationProfiles(store, chatId, args);
        return finish(
          result,
          result.profiles.length,
          result.profiles
            .filter((p) => p.changed)
            .map((p) => settings('chat.illustrationProfiles', p.name, result.revision))
        );
      }
      default:
        throw new HttpError(400, 'Unknown illustration operation');
    }
  });
  if (changed)
    publish?.(
      chatId,
      name === 'illustration.generate' ||
        name === 'illustration.cut.redraw' ||
        name === 'illustration.cut.revise'
    );
  return saved;
}
