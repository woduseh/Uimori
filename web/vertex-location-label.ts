import { t } from './i18n.js';

const named: Record<string, () => string> = {
  global: () => t('providers.vertexLocationGlobal'),
  us: () => t('providers.vertexLocationUs'),
  eu: () => t('providers.vertexLocationEu'),
  'us-central1': () => t('providers.vertexLocationUsCentral1'),
  'us-east4': () => t('providers.vertexLocationUsEast4'),
  'europe-west4': () => t('providers.vertexLocationEuropeWest4'),
  'asia-northeast1': () => t('providers.vertexLocationAsiaNortheast1'),
  'asia-northeast3': () => t('providers.vertexLocationAsiaNortheast3'),
};

export function vertexLocationLabel(location: string): string {
  return named[location]?.() ?? location;
}
