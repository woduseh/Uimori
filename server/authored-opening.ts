import type { RunSnapshot } from '../core/types.js';

export function isAuthoredOpening(
  snapshot: Pick<RunSnapshot, 'packageStart' | 'nativeRisuAuthored'>
): boolean {
  return (
    snapshot.packageStart?.mode === 'authored' || snapshot.nativeRisuAuthored?.greeting === true
  );
}

export function authoredOpeningSql(snapshot: string): string {
  return `(COALESCE(json_extract(${snapshot},'$.packageStart.mode')='authored',0) OR COALESCE(json_extract(${snapshot},'$.nativeRisuAuthored.greeting')=1,0))`;
}
