import { historicalPersonaExcluded } from './persona-scope.js';
import type { ProfileSnapshot } from './product.js';
import {
  resolveSourceSegmentPolicy,
  validateSourceSegmentPolicy,
  SourceSegmentError,
  type SourceSegmentPolicy,
} from './source-segments.js';

function sameDeclaration(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => sameDeclaration(item, right[index]))
    );
  const a = left as Record<string, unknown>,
    b = right as Record<string, unknown>;
  const keys = Object.keys(a).filter((key) => a[key] !== undefined);
  return (
    keys.length === Object.keys(b).filter((key) => b[key] !== undefined).length &&
    keys.every((key) => Object.hasOwn(b, key) && sameDeclaration(a[key], b[key]))
  );
}

/** The same revision-pinned package options govern preview, execution and source rendering. */
export function freezeSourceSegments(
  profile: ProfileSnapshot | undefined
): SourceSegmentPolicy | undefined {
  const rules: SourceSegmentPolicy['rules'] = [];
  for (const ref of profile?.packageAttachments ?? []) {
    if (historicalPersonaExcluded(profile, ref.role)) continue;
    const pkg = profile?.packages?.find((p) => p.id === ref.id && p.revision === ref.revision);
    if (!pkg?.sourceSegments) continue;
    const instance = `${ref.id}@${ref.revision}:${ref.role}`;
    for (const rule of resolveSourceSegmentPolicy(
      pkg.sourceSegments,
      pkg.controls,
      profile?.packageValues?.[instance]
    ).rules) {
      const { id: _id, ...body } = rule;
      const existing = rules.find(
        (r) =>
          r.open === rule.open ||
          r.close === rule.close ||
          r.open === rule.close ||
          r.close === rule.open
      );
      if (existing) {
        const { id: _existingId, ...existingBody } = existing;
        if (!sameDeclaration(body, existingBody))
          throw new SourceSegmentError('SEGMENT_DELIMITER_CONFLICT');
      } else rules.push({ ...rule, id: `${instance}:${rule.id}` });
    }
  }
  return rules.length ? validateSourceSegmentPolicy({ version: 1, rules }) : undefined;
}
