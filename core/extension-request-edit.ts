/** A frozen submit-time input edit. Derived from the run journal, so forks preserve it verbatim. */
export type ExtensionRequestEditReceipt = {
  version: 1;
  inputHash: string;
  outputHash: string;
  /** The transmitted text. A receipt exists only when it differs from the original request. */
  text: string;
  applied: string[];
};
