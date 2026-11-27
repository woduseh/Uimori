import {
  RISU_IMPORT_FINDING_LEVELS,
  type FindingParamsArgument,
  type RisuImportFinding,
  type RisuImportFindingCode,
  type RisuImportFindingParams,
} from '../core/risu-import.js';

export type RisuImportFindings = {
  readonly list: RisuImportFinding[];
  add: <C extends RisuImportFindingCode>(
    code: C,
    ...params: FindingParamsArgument<RisuImportFindingParams[C]>
  ) => void;
  append: (items: RisuImportFinding[]) => void;
};

const findingKey = (finding: RisuImportFinding) =>
  JSON.stringify([finding.code, finding.params ?? null]);

export function createRisuImportFindings(): RisuImportFindings {
  const list: RisuImportFinding[] = [];
  const seen = new Set<string>();
  const push = (finding: RisuImportFinding) => {
    const key = findingKey(finding);
    if (seen.has(key)) return;
    seen.add(key);
    list.push(finding);
  };
  return {
    list,
    add: (code, ...params) => {
      push({
        code,
        level: RISU_IMPORT_FINDING_LEVELS[code],
        ...(params[0] === undefined ? {} : { params: params[0] }),
      } as RisuImportFinding);
    },
    append: (items) => {
      for (const item of items) push(item);
    },
  };
}
