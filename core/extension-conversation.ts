/** Host-captured references to the selected branch's user-visible conversation at admission. */
export type ExtensionConversationRef =
  | { kind: 'request'; role: 'user'; runId: string; hash: string }
  | { kind: 'source'; role: 'assistant'; runId: string; sourceRevision: string; hash: string }
  | { kind: 'partial'; role: 'assistant'; runId: string; hash: string };

export type ExtensionConversationSnapshot = {
  version: 1;
  chatId: string;
  branchId: string;
  parentRevision: string | null;
  admissionRunId: string | null;
  messages: ExtensionConversationRef[];
};
