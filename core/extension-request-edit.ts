/** A frozen submit-time input edit. Derived from the run journal, so forks preserve it verbatim. */
export type ExtensionRequestEditReceipt = {
  version: 1;
  inputHash: string;
  outputHash: string;
  /** The transmitted text. A receipt exists only when it differs from the original request. */
  text: string;
  applied: string[];
};

/** A frozen send-time edit of the transmitted conversation copy. Roles and message count stay fixed. */
export type ExtensionMessageEditReceipt = {
  version: 1;
  entries: {
    index: number;
    role: 'user' | 'assistant';
    inputHash: string;
    outputHash: string;
    /** Present only for a message whose transmitted text differs from its input. */
    text?: string;
  }[];
  applied: string[];
  /** A declared edit that the host could not run: no conversation grant, over the limit, or a false condition. */
  skipped?: true;
};
