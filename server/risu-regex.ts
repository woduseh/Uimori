import type { PackageTransform } from '../core/content-package.js';
import type { RisuImportFinding } from '../core/risu-import.js';

/** Format translation only. The existing display worker compiles and executes the patterns. */
export function importRisuDisplayRegex(value: unknown): {
  transforms: PackageTransform[];
  findings: RisuImportFinding[];
} {
  if (value === undefined) return { transforms: [], findings: [] };
  const findings: RisuImportFinding[] = [];
  const rules: { index: number; order: number; rule: PackageTransform }[] = [];
  const skipped = (index: number, reason: string) =>
    findings.push({
      code: `regex-${index}-unsupported`,
      level: 'unsupported',
      message: `정규식 ${index + 1}: ${reason} 원본에 보존하고 자동 적용하지 않아요.`,
    });
  if (!Array.isArray(value) || value.length > 2000)
    return {
      transforms: [],
      findings: [
        {
          code: 'regex-list',
          level: 'unsupported',
          message: '정규식 목록 형식이나 개수가 지원 범위를 벗어났어요.',
        },
      ],
    };
  for (const [index, raw] of value.entries()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      skipped(index, '규칙 형식을 읽을 수 없어요.');
      continue;
    }
    const item = raw as Record<string, unknown>;
    if (item.type === 'disabled' || item.in === '') continue;
    if (item.type !== 'editdisplay') {
      skipped(index, '표시 전용이 아닌 처리 단계예요.');
      continue;
    }
    if (
      typeof item.in !== 'string' ||
      typeof item.out !== 'string' ||
      item.in.length > 4096 ||
      item.out.length > 16_384
    ) {
      skipped(index, '패턴이나 치환문 형식·길이가 지원 범위를 벗어났어요.');
      continue;
    }
    if (/\{\{|\{#|^@@/u.test(item.out)) {
      skipped(index, 'CBS 또는 특수 명령이 포함돼 있어요.');
      continue;
    }
    if (/<\/?[A-Za-z][^>]*>/u.test(item.out)) {
      skipped(index, 'HTML 화면 표현은 별도 이식이 필요해요.');
      continue;
    }
    let flags = item.ableFlag ? (typeof item.flag === 'string' ? item.flag || 'g' : 'g') : 'g';
    let order = 0,
      unsupported = false;
    if (item.ableFlag)
      flags = flags.replace(/<([^>]+)>/gu, (_match, body: string) => {
        for (const action of body.split(',').map((part) => part.trim())) {
          if (/^order -?\d+$/u.test(action)) order = Number(action.slice(6));
          else unsupported = true;
        }
        return '';
      });
    if (unsupported || !Number.isSafeInteger(order)) {
      skipped(index, 'CBS 패턴·주입·이동 등의 특수 플래그가 있어요.');
      continue;
    }
    flags = [...new Set(flags.trim().replace(/[^dgimsuvy]/gu, ''))].join('') || 'u';
    if (flags.includes('v')) {
      skipped(index, 'Unicode 집합(v) 플래그는 아직 지원하지 않아요.');
      continue;
    }
    // Match indices (d) are not read by plain string replacement.
    flags = flags.replace('d', '');
    let replacement = item.out.replaceAll('$n', '\n');
    if (replacement.endsWith('>')) replacement += '\n';
    if (replacement.length > 16_384) {
      skipped(index, '변환한 치환문이 허용 길이를 넘어요.');
      continue;
    }
    rules.push({
      index,
      order,
      rule: { id: `risu-display-${index}`, target: 'source', pattern: item.in, flags, replacement },
    });
  }
  rules.sort((left, right) => right.order - left.order || left.index - right.index);
  if (rules.length > 32)
    return {
      transforms: [],
      findings: [
        ...findings,
        {
          code: 'regex-limit',
          level: 'unsupported',
          message:
            '표시 정규식이 32개를 넘어 전체 묶음을 자동 적용하지 않아요. 순서를 보존한 별도 이식이 필요해요.',
        },
      ],
    };
  if (rules.length)
    findings.unshift({
      code: 'display-regex',
      level: 'warning',
      message: `표시 정규식 ${rules.length}개를 응답 본문의 표시 변환으로 가져와요. 저장 원문은 유지하며, 사용자 메시지·번역 표시와 CBS 재평가는 이 변환에 포함하지 않아요.`,
    });
  return { transforms: rules.map((item) => item.rule), findings };
}
