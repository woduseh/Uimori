import type { UsageKind } from '#contracts';

export { USAGE_KINDS, type UsageKind, type UsageReport, type UsageTotals } from '#contracts';
export const USAGE_KIND_LABELS: Record<UsageKind, string> = {
  writing: '본문 작성',
  translation: '번역',
  'input-translation': '입력 번역',
  'story-guide': '원작 참고',
  summary: '컨텍스트 요약',
  advisor: '협업 조언',
  helper: '도우미',
  'helper-artifact': '도우미 산출물',
  judgment: '판정',
  image: '삽화와 이미지',
  status: '상태 작업',
  script: '카드 스크립트',
  title: '제목',
  'connection-test': '연결 테스트',
  unclassified: '용도 미분류',
};
