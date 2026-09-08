const apiPrerequisites = [
  'supported-node-runtime',
  'node-child-ready-exit',
  'writable-directory',
  'file-sqlite-transaction-reopen',
  'localhost-bind-http',
];

/** Classify a non-PASS doctor without downgrading failed probes to missing prerequisites. */
export function doctorFailureState(result) {
  const checks = result.checks ?? [];
  const status =
    result.status === 'BLOCKED' &&
    result.cleanup?.status === 'PASS' &&
    !checks.some((check) => check.status === 'FAIL')
      ? 'BLOCKED'
      : 'FAIL';
  const incomplete = checks.filter((check) => check.required !== false && check.status !== 'PASS');
  const browserOnly =
    status === 'BLOCKED' &&
    apiPrerequisites.every((name) =>
      checks.some((check) => check.name === name && check.status === 'PASS')
    ) &&
    incomplete.length === 1 &&
    incomplete[0].name === 'browser-launch-and-local-page' &&
    incomplete[0].status === 'BLOCKED';
  return { status, browserOnly };
}
