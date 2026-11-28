import type { PromptPreset } from '../core/product.js';
import type { ResourceKind } from '../core/resource-editing.js';
import { diagnoseRisuPreset } from '../core/risu-preset-diagnostics.js';
import { readHelperResource } from './helper-resource-editing.js';
import { DEFAULT_READ_FIT, type HelperReadFit } from './helper-read-fit.js';
import { HelperToolError } from './app-errors.js';
import { fields, HttpError, number, record, text } from './request-validation.js';
import { readResource } from './resource-service.js';
import type { Store } from './store.js';

const selectionFields = [
  'kind',
  'id',
  'version',
  'path',
  'fields',
  'offset',
  'limit',
  'textOffset',
  'textLimit',
  'includeBodies',
];

export function readHelperResources(
  store: Store,
  rawItems: unknown,
  fits: HelperReadFit = DEFAULT_READ_FIT
) {
  if (!Array.isArray(rawItems) || !rawItems.length || rawItems.length > 16)
    throw new HelperToolError(400, 'INVALID_ARGUMENTS', 'items must list 1 to 16 selections');
  const items: unknown[] = [];
  for (const [requestIndex, raw] of rawItems.entries()) {
    let item: unknown;
    try {
      const selection = record(raw);
      fields(selection, selectionFields);
      const kind = selection.kind as ResourceKind;
      if (
        !['content', 'prompt-preset', 'prompt-workspace', 'theme', 'illustration-preset'].includes(
          kind
        )
      )
        throw new HelperToolError(
          400,
          'INVALID_ARGUMENTS',
          'kind must be content, prompt-preset, prompt-workspace, theme or illustration-preset'
        );
      const id = text(selection.id, 'resource ID', 100);
      item = {
        requestIndex,
        result: readHelperResource(store, kind, id, selection, (result) =>
          fits({ items: [{ requestIndex, result }], nextIndex: rawItems.length })
        ),
      };
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      item = { requestIndex, error: error.message, status: error.statusCode };
    }
    const candidate = {
      items: [...items, item],
      nextIndex: requestIndex + 1 < rawItems.length ? requestIndex + 1 : null,
    };
    if (!fits(candidate)) {
      if (!items.length)
        throw new HelperToolError(413, 'HELPER_READ_TOO_LARGE', 'Read a smaller range');
      break;
    }
    items.push(item);
  }
  return { items, nextIndex: items.length < rawItems.length ? items.length : null };
}

export function validateHelperPreset(
  store: Store,
  args: Record<string, unknown>,
  fits: HelperReadFit = DEFAULT_READ_FIT
) {
  fields(args, ['id', 'offset', 'limit']);
  const id = text(args.id, 'preset ID', 100);
  const saved = readResource(store, 'prompt-preset', id) as PromptPreset;
  const undo = store.db
    .prepare('SELECT model FROM resource_undo WHERE kind=? AND id=? AND saved_revision=?')
    .get('prompt-preset', id, saved.revision);
  const previous = undo ? (JSON.parse(String(undo.model)) as PromptPreset) : undefined;
  const report = diagnoseRisuPreset(saved.program, saved.values, previous?.program);
  const offset =
    args.offset === undefined ? 0 : number(args.offset, 'offset', 0, report.diagnostics.length);
  const limit = args.limit === undefined ? 20 : number(args.limit, 'limit', 1, 50);
  const diagnostics: typeof report.diagnostics = [];
  const page = () => ({
    id,
    revision: saved.revision,
    comparedWithPrevious: !!previous,
    coverage: report.coverage,
    totalDiagnostics: report.totalDiagnostics,
    truncated: report.truncated,
    diagnostics,
    nextOffset:
      offset + diagnostics.length < report.diagnostics.length ? offset + diagnostics.length : null,
  });
  for (const diagnostic of report.diagnostics.slice(offset, offset + limit)) {
    diagnostics.push({
      ...diagnostic,
      path: diagnostic.path.startsWith('/values') ? diagnostic.path : `/program${diagnostic.path}`,
    });
    if (!fits(page())) {
      diagnostics.pop();
      if (!diagnostics.length)
        throw new HelperToolError(413, 'HELPER_READ_TOO_LARGE', 'Read a smaller range');
      break;
    }
  }
  return page();
}
