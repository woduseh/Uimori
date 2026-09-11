/** A user-selected package action reserves a source-bound proposal, never an automatic model call. */
export type PackageRequestOrigin = {
  chatId: string;
  branchId: string;
  sourceRevision: string | null;
  dependencies: { id: string; hash: string }[];
  identities: { from: string; to: string }[];
};

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
  /** Imported reservations keep the original expression runtime and prove its current ownership. */
  origin?: PackageRequestOrigin;
};
