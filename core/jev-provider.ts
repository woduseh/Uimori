import type { ProviderConnectionTest } from './provider-connection-test.js';

export type JevSettings = { revision: number; images: boolean; longContext: boolean };

export const DEFAULT_JEV_SETTINGS: JevSettings = {
  revision: 0,
  images: false,
  longContext: false,
};

export type JevProviderStatus = {
  revision: number;
  configured: boolean;
  credentialSource: 'saved' | 'environment' | 'missing';
  hasSavedKey: boolean;
  modelId: string;
  endpoint: string;
  latestTest: ProviderConnectionTest | null;
  settings: JevSettings;
};

export const JEV_PROVIDER_DEFINITION = Object.freeze({
  id: 'typesafe-judgment' as const,
  kind: 'judgment' as const,
  label: 'TypeSafe AI',
  modelId: 'jev-latest',
  modelLabel: 'JEV',
});
export function jevRegistered(status: JevProviderStatus | null): boolean {
  return status?.configured === true;
}
