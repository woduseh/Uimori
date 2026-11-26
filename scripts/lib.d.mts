export function assertBuild(options?: {
  checkSource?: boolean;
}): Promise<{ buildId: string; sourceHash: string; distHash: string }>;
export function localVerificationEnv(
  variables?: Record<string, string | undefined>
): NodeJS.ProcessEnv;
