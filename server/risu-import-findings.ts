import type { RisuImportFinding } from '../core/risu-import.js';

export type RisuImportFindings = {
  readonly list: RisuImportFinding[];
  add: (code: string, level: RisuImportFinding['level'], message: string) => void;
  append: (items: RisuImportFinding[]) => void;
};

export function createRisuImportFindings(): RisuImportFindings {
  const list: RisuImportFinding[] = [];
  return {
    list,
    add: (code, level, message) => {
      if (!list.some((item) => item.code === code)) list.push({ code, level, message });
    },
    append: (items) => {
      list.push(...items);
    },
  };
}
