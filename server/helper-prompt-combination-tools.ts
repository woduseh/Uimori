import type { HelperTask } from '../core/helper.js';
import type { PromptRole, SavedPromptCombination } from '../core/product.js';
import {
  combinationOwner,
  matchesPromptCombination,
  ownsPromptCombination,
} from '../core/prompt-combinations.js';
import { promptControls } from '../core/risu-prompt.js';
import type { Json, ProviderTool } from '../core/transport.js';
import { recordHelperTaskResult } from './helper-task-results.js';
import type { HelperWorkspace } from './helper-workspace.js';
import { deleteLibraryItem } from './library-deletion.js';
import { updatePromptCombination } from './prompt-combinations.js';
import { applyPromptCombination, promptWorkspace } from './prompt-workspace.js';
import { HelperToolError } from './app-errors.js';
import { fields, HttpError, number, record, text } from './request-validation.js';
import type { Store } from './store.js';

const role: Json = {
  type: 'string',
  enum: ['main', 'translation'],
  description: 'The writing (main) or translation prompt. Default main.',
};
const id: Json = {
  type: 'string',
  minLength: 1,
  maxLength: 100,
  description: 'Option preset id from prompt.combination.list.',
};
const revision = (description: string): Json => ({ type: 'integer', minimum: 0, description });
const values: Json = {
  type: 'object',
  description:
    'Option values by option id, as in the definitions prompt.combination.list returns; options left out keep their default.',
};
const input = (properties: Record<string, Json>, required: string[]): Json => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

export const HELPER_PROMPT_COMBINATION_TOOLS: ProviderTool[] = [
  {
    name: 'prompt.combination.list',
    description:
      "List the saved option presets (named combinations of writing option values) of the current writing or translation prompt, as the prompt settings show them. Each has its id, revision, title, values and whether it still matches the prompt's option definitions (compatible). Also returns the option definitions, the current values, workspaceRevision (the guard for save and apply) and sourceRevision (the guard for update). To use a compatible preset for one chat from now on, as the composer does, pass its values to options.fix.",
    inputSchema: input({ role }, []),
  },
  {
    name: 'prompt.combination.save',
    description:
      'Save the given option values of the current writing or translation prompt as a new named option preset, as Save option preset in the prompt settings does. values omitted saves the current values. Values are checked against the option definitions; an unknown option or value is refused.',
    inputSchema: input(
      {
        role,
        title: { type: 'string', minLength: 1, maxLength: 200, description: 'Preset name.' },
        values,
        workspaceRevision: revision('workspaceRevision from prompt.combination.list.'),
      },
      ['title', 'workspaceRevision']
    ),
  },
  {
    name: 'prompt.combination.update',
    description:
      'Change the title or the values of an option preset, as editing it in Manage option presets does. Give the complete title and values; both are saved together.',
    inputSchema: input(
      {
        id,
        expectedRevision: revision('The preset revision from prompt.combination.list.'),
        sourceRevision: revision('sourceRevision from prompt.combination.list.'),
        title: { type: 'string', minLength: 1, maxLength: 200, description: 'Preset name.' },
        values,
      },
      ['id', 'expectedRevision', 'sourceRevision', 'title', 'values']
    ),
  },
  {
    name: 'prompt.combination.delete',
    description:
      'Delete an option preset. It cannot be restored, so the call waits for the owner confirmation. Values already fixed in chats stay.',
    inputSchema: input(
      { id, expectedRevision: revision('The preset revision from prompt.combination.list.') },
      ['id', 'expectedRevision']
    ),
  },
  {
    name: 'prompt.combination.apply',
    description:
      "Set the current values of the writing or translation prompt to a compatible option preset, as choosing it in the prompt settings does. This changes the app-wide default values; a chat's own fixed values still win in that chat.",
    inputSchema: input(
      { role, id, workspaceRevision: revision('workspaceRevision from prompt.combination.list.') },
      ['id', 'workspaceRevision']
    ),
  },
];

function roleOf(value: unknown): PromptRole {
  if (value === undefined || value === 'main') return 'main';
  if (value === 'translation') return 'translation';
  throw new HttpError(400, 'Invalid prompt role');
}

export function readHelperPromptCombinations(store: Store, value: unknown) {
  const args = record(value);
  fields(args, ['role']);
  const promptRole = roleOf(args.role);
  const workspace = promptWorkspace(store);
  const current = workspace[promptRole];
  const owner = combinationOwner(current, promptRole);
  const items = (store.product.all('prompt-combination') as SavedPromptCombination[]).filter(
    (item) => ownsPromptCombination(item, owner, promptRole)
  );
  return {
    role: promptRole,
    prompt: current.title,
    workspaceRevision: workspace.revision,
    sourceRevision: current.presetRevision ?? workspace.revision,
    definitions: promptControls(current.program),
    currentValues: current.values,
    combinations: items.map((item) => ({
      id: item.id,
      revision: item.revision,
      title: item.title,
      compatible: matchesPromptCombination(item, owner, promptRole, current.program),
      values: item.values,
    })),
  };
}

export function applyHelperPromptCombination(
  store: Store,
  workspace: HelperWorkspace,
  task: Pick<HelperTask, 'id' | 'conversationId'>,
  receiptId: string,
  name: string,
  value: unknown
) {
  const args = record(value);
  const report = (item: { id: string; title: string; revision: number }) =>
    recordHelperTaskResult(workspace, task, {
      receiptId,
      operation: name,
      requestedTargets: 1,
      targets: [
        {
          kind: 'settings',
          id: item.id,
          title: item.title,
          revision: item.revision,
          setting: name,
        },
      ],
    });
  if (name === 'prompt.combination.save') {
    fields(args, ['role', 'title', 'values', 'workspaceRevision']);
    const promptRole = roleOf(args.role);
    const saved = store.product.promptCombination({
      title: args.title,
      role: promptRole,
      values: args.values ?? promptWorkspace(store)[promptRole].values,
      workspaceRevision: args.workspaceRevision,
    }) as SavedPromptCombination;
    report(saved);
    return { id: saved.id, revision: saved.revision, title: saved.title, values: saved.values };
  }
  if (name === 'prompt.combination.update') {
    const { id: combinationId, ...body } = args;
    const saved = updatePromptCombination(
      store,
      () => promptWorkspace(store),
      text(combinationId, 'option preset', 100),
      body
    ) as SavedPromptCombination;
    report(saved);
    return { id: saved.id, revision: saved.revision, title: saved.title, values: saved.values };
  }
  if (name === 'prompt.combination.delete') {
    fields(args, ['id', 'expectedRevision']);
    const combinationId = text(args.id, 'option preset', 100);
    const item = store.product.get<SavedPromptCombination>('prompt-combination', combinationId);
    deleteLibraryItem(store, 'prompt-combination', combinationId, {
      expectedRevision: args.expectedRevision,
    });
    report(item);
    return { deleted: true, id: combinationId, title: item.title };
  }
  if (name === 'prompt.combination.apply') {
    fields(args, ['role', 'id', 'workspaceRevision']);
    const combinationId = text(args.id, 'option preset', 100);
    const updated = applyPromptCombination(store, {
      role: roleOf(args.role),
      combinationId,
      expectedRevision: number(args.workspaceRevision, 'prompt workspace revision'),
    });
    const item = store.product.get<SavedPromptCombination>('prompt-combination', combinationId);
    report(item);
    return { applied: combinationId, title: item.title, workspaceRevision: updated.revision };
  }
  throw new HelperToolError(400, 'UNKNOWN_HELPER_TOOL');
}
