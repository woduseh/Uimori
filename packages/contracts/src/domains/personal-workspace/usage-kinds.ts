export const USAGE_KINDS = [
  'writing',
  'translation',
  'input-translation',
  'story-guide',
  'summary',
  'advisor',
  'helper',
  'helper-artifact',
  'judgment',
  'image',
  'status',
  'script',
  'title',
  'connection-test',
  'unclassified',
] as const;
export type UsageKind = (typeof USAGE_KINDS)[number];
