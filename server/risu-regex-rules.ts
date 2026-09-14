import { validateTextTransformRule } from '../core/text-transform.js';

/** Both importers report the same shape; each caller widens it to its own finding type. */
export type RisuRegexFinding = { code: string; level: 'unsupported' | 'warning'; message: string };
export type RisuRegexStage = 'input' | 'display';
/** One Risu script that survived parsing, ready for the caller's own rule shape. */
export type RisuRegexCandidate = {
  index: number;
  id: string;
  stage: RisuRegexStage;
  item: Record<string, unknown>;
  pattern: string;
  flags: string;
  replacement: string;
};
export type RisuRegexOptions<T> = {
  /** Risu script type to the stage it becomes. Types outside this map stay unconverted. */
  stages: Record<string, RisuRegexStage>;
  stageReason: string;
  /** Replacements to leave unconverted, in check order. Patterns must not carry the `g` flag. */
  rejectedReplacements: { pattern: RegExp; reason: string }[];
  allowNoEndNewline: boolean;
  ruleId(index: number): string;
  findingCode(index: number, kind: 'list' | 'unsupported'): string;
  /** Returns undefined after reporting through `skip` when the rule cannot be converted. */
  build(candidate: RisuRegexCandidate, skip: (reason: string) => void): T | undefined;
};

/** Format translation only: patterns are never compiled or executed here. */
export function collectRisuRegexRules<T>(
  value: unknown,
  options: RisuRegexOptions<T>
): { rules: T[]; findings: RisuRegexFinding[] } {
  const findings: RisuRegexFinding[] = [];
  if (value === undefined) return { rules: [], findings };
  if (!Array.isArray(value) || value.length > 2000) {
    findings.push({
      code: options.findingCode(0, 'list'),
      level: 'unsupported',
      message: '정규식 목록 형식이나 개수가 지원 범위를 벗어났어요.',
    });
    return { rules: [], findings };
  }
  const stages = new Map(Object.entries(options.stages));
  const ordered: { index: number; order: number; rule: T }[] = [];
  for (const [index, raw] of value.entries()) {
    const id = options.ruleId(index);
    const skip = (reason: string) =>
      findings.push({
        code: options.findingCode(index, 'unsupported'),
        level: 'unsupported',
        message: `정규식 ${index + 1}: ${reason} 원본에 보존하고 자동 적용하지 않아요.`,
      });
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      skip('규칙 형식을 읽을 수 없어요.');
      continue;
    }
    const item = raw as Record<string, unknown>;
    if (item.type === 'disabled' || item.in === '') continue;
    const stage = typeof item.type === 'string' ? stages.get(item.type) : undefined;
    if (!stage) {
      skip(options.stageReason);
      continue;
    }
    const source = validated(id, item.in, '', item.out);
    if (!source) {
      skip('패턴이나 치환문 형식·길이가 지원 범위를 벗어났어요.');
      continue;
    }
    const rejected = options.rejectedReplacements.find((entry) =>
      entry.pattern.test(source.replacement)
    );
    if (rejected) {
      skip(rejected.reason);
      continue;
    }
    let flags = item.ableFlag ? (typeof item.flag === 'string' ? item.flag || 'g' : 'g') : 'g';
    let order = 0,
      unsupportedAction = false,
      noEndNewline = false;
    if (item.ableFlag)
      flags = flags.replace(/<([^>]+)>/gu, (_match, body: string) => {
        for (const action of body.split(',').map((part) => part.trim())) {
          if (/^order -?\d+$/u.test(action)) order = Number(action.slice(6));
          else if (options.allowNoEndNewline && action === 'no_end_nl') noEndNewline = true;
          else unsupportedAction = true;
        }
        return '';
      });
    if (unsupportedAction || !Number.isSafeInteger(order)) {
      skip('CBS 패턴·주입·이동 등의 특수 플래그가 있어요.');
      continue;
    }
    flags = [...new Set(flags.trim().replace(/[^dgimsuvy]/gu, ''))].join('') || 'u';
    if (flags.includes('v')) {
      skip('Unicode 집합(v) 플래그는 아직 지원하지 않아요.');
      continue;
    }
    // Match indices (d) are not read by plain string replacement.
    flags = flags.replace('d', '');
    let replacement = source.replacement.replaceAll('$n', '\n');
    if (replacement.endsWith('>') && !noEndNewline) replacement += '\n';
    // The id, pattern and flags already passed validation, so only the grown replacement can fail.
    const rule = validated(id, source.pattern, flags, replacement);
    if (!rule) {
      skip('변환한 치환문이 허용 길이를 넘어요.');
      continue;
    }
    const built = options.build({ index, stage, item, ...rule }, skip);
    if (built !== undefined) ordered.push({ index, order, rule: built });
  }
  ordered.sort((left, right) => right.order - left.order || left.index - right.index);
  return { rules: ordered.map((entry) => entry.rule), findings };
}

/** Shared pattern, flag and length limits. Returns undefined instead of throwing. */
function validated(id: string, pattern: unknown, flags: string, replacement: unknown) {
  if (typeof pattern !== 'string' || typeof replacement !== 'string') return undefined;
  try {
    return validateTextTransformRule({ id, pattern, flags, replacement });
  } catch {
    return undefined;
  }
}
