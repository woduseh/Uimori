export const USAGE_KINDS = [
  'writing',
  'translation',
  'input-translation',
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
export const USAGE_KIND_LABELS: Record<UsageKind, string> = {
  writing: '본문 작성',
  translation: '번역',
  'input-translation': '입력 번역',
  summary: '문맥 요약',
  advisor: '협업 조언',
  helper: '도우미',
  'helper-artifact': '도우미 산출물',
  judgment: '판정',
  image: '삽화·이미지',
  status: '상태 작업',
  script: '카드 스크립트',
  title: '제목',
  'connection-test': '연결 테스트',
  unclassified: '용도 미분류',
};
export type UsageTotals = {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  unknownInputCalls: number;
  unknownOutputCalls: number;
  reportedUsd: number;
  estimatedUsd: number;
  partialUsd: number;
  partialCalls: number;
  unknownCostCalls: number;
  runningCalls: number;
};
export type UsageReport = {
  from: string;
  to: string;
  timeZone: 'Asia/Seoul';
  totals: UsageTotals;
  days: (UsageTotals & { day: string })[];
  models: (UsageTotals & { modelId: string; connectionId: string })[];
  kinds: (UsageTotals & { kind: UsageKind })[];
  undated: UsageTotals;
  coverageSince: string;
};
