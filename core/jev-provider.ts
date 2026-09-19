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
