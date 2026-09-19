import type { ProviderConnectionTest } from './provider-connection-test.js';

/** Connection metadata only. Credentials never enter a library or story archive. */
export type JevProviderStatus = {
  revision: number;
  configured: boolean;
  credentialSource: 'saved' | 'environment' | 'missing';
  hasSavedKey: boolean;
  modelId: string;
  endpoint: string;
  latestTest: ProviderConnectionTest | null;
};

/** Judgment models use their own transport, while sharing provider registration and model lists. */
export const JEV_PROVIDER_DEFINITION = Object.freeze({
  id: 'typesafe-judgment' as const,
  kind: 'judgment' as const,
  label: 'TypeSafe AI',
  modelId: 'jev-latest',
  modelLabel: 'JEV',
  description: '로어 선별 · 생성 거절 판정 · 이미지 배치',
});
export function jevRegistered(status: JevProviderStatus | null): boolean {
  return status?.configured === true;
}
