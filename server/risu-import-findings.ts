import type { RisuImportFinding } from '../core/risu-import.js';

/**
 * What one import could not carry over. Every stage records through the same collector, so the
 * preview keeps one entry per code, in the order the stages ran.
 */
export type RisuImportFindings = {
  /** The findings so far, in reporting order. The preview shows this list. */
  readonly list: RisuImportFinding[];
  /** Records a finding once per code; a repeated code keeps the message reported first. */
  add: (code: string, level: RisuImportFinding['level'], message: string) => void;
  /** Appends findings another importer produced, which carry their own codes and order. */
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
