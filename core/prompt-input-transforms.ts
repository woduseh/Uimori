/** A frozen calculation, independent of database/source IDs so forks can preserve it verbatim. */
export type PromptInputTransformReceipt = {
  version: 1;
  configurationHash: string;
  inputHash: string;
  entries: {
    index: number;
    role: 'user' | 'assistant';
    inputHash: string;
    outputHash: string;
    text?: string;
    applied: string[];
  }[];
  error?: string;
};
