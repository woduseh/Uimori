import type { PackageTransform } from '../core/content-package.js';
import type { RisuImportFinding } from '../core/risu-import.js';
import { collectRisuRegexRules } from './risu-regex-rules.js';

/** Format translation only. The existing display worker compiles and executes the patterns. */
export function importRisuDisplayRegex(value: unknown): {
  transforms: PackageTransform[];
  findings: RisuImportFinding[];
} {
  const { rules, findings } = collectRisuRegexRules<PackageTransform>(value, {
    stages: { editdisplay: 'display' },
    stageReason: '표시 전용이 아닌 처리 단계예요.',
    rejectedReplacements: [
      { pattern: /\{\{|\{#|^@@/u, reason: 'CBS 또는 특수 명령이 포함돼 있어요.' },
      { pattern: /<\/?[A-Za-z][^>]*>/u, reason: 'HTML 화면 표현은 별도 이식이 필요해요.' },
    ],
    // Risu's no_end_nl only reaches the display copy through a port the package format lacks.
    allowNoEndNewline: false,
    ruleId: (index) => `risu-display-${index}`,
    findingCode: (index, kind) => (kind === 'list' ? 'regex-list' : `regex-${index}-unsupported`),
    build: ({ id, pattern, flags, replacement }) => ({
      id,
      target: 'source',
      pattern,
      flags,
      replacement,
    }),
  });
  const result: RisuImportFinding[] = findings;
  if (rules.length > 32) {
    result.push({
      code: 'regex-limit',
      level: 'unsupported',
      message:
        '표시 정규식이 32개를 넘어 전체 묶음을 자동 적용하지 않아요. 순서를 보존한 별도 이식이 필요해요.',
    });
    return { transforms: [], findings: result };
  }
  if (rules.length)
    result.unshift({
      code: 'display-regex',
      level: 'warning',
      message: `표시 정규식 ${rules.length}개를 응답 본문의 표시 변환으로 가져와요. 저장 원문은 유지하며, 사용자 메시지·번역 표시와 CBS 재평가는 이 변환에 포함하지 않아요.`,
    });
  return { transforms: rules, findings: result };
}
