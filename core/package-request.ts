/** A user-selected package action reserves a source-bound proposal, never an automatic model call. */
export type PackageRequest = {
  id: string;
  chatId: string;
  branchId: string;
  instanceId: string;
  actionId: string;
  actionKey: string;
  request: string;
  label: string;
  profileRevision: number;
  sourceRevision: string | null;
  sourceHash: string | null;
  stateRevision: number;
};
