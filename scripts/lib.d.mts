export function assertBuild(options?: {
  checkSource?: boolean;
}): Promise<{ buildId: string; sourceHash: string; distHash: string }>;
