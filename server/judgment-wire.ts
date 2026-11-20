import { isDeepStrictEqual } from 'node:util';
import type { JudgmentRequest } from '../core/judgment.js';
import type { WireRecord } from '../core/transport.js';
import { buildJudgmentWire, targetFromJudgmentWire } from './judgment.js';

export function matchesJudgmentWire(
  wire: WireRecord,
  request: JudgmentRequest,
  kind: NonNullable<WireRecord['judgment']>['kind'],
  inputHash: string
): boolean {
  try {
    const target = targetFromJudgmentWire(wire);
    if (!target || wire.agentId || wire.nativeScript) return false;
    const expected = buildJudgmentWire(request, inputHash, {
      target,
      kind,
      settings: {
        images: !!request.assets && Object.keys(request.assets).length > 0,
        longContext: wire.headers['TypeSafe-Danger-Zone-Long-Context'] === 'true',
      },
    });
    return (
      wire.role === expected.role &&
      wire.method === expected.method &&
      wire.judgment?.kind === kind &&
      wire.judgment.inputHash === inputHash &&
      isDeepStrictEqual(wire.headers, expected.headers) &&
      isDeepStrictEqual(wire.body, expected.body) &&
      wire.bodySha256 === expected.bodySha256 &&
      wire.stablePrefixSha256 === expected.stablePrefixSha256
    );
  } catch {
    return false;
  }
}
