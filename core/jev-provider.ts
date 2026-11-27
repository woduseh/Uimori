import type { JevProviderStatus, JevSettings } from '#contracts';

export type { JevProviderStatus, JevSettings };

export const DEFAULT_JEV_SETTINGS: JevSettings = {
  revision: 0,
  images: false,
  longContext: false,
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
