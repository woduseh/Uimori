import type { DatabaseSync } from 'node:sqlite';

const RETIRED_EVALUATION_CONTROLS = [
  '$.evaluationTools.maximumToolRounds',
  '$.evaluationTools.terminalLateCorrections',
  '$.evaluationTools.outputRecovery',
];

export function upgradeProviderStoredShapes(db: DatabaseSync): void {
  db.prepare(
    `UPDATE provider_settings SET body=json_remove(body,${RETIRED_EVALUATION_CONTROLS.map(() => '?').join(',')})
    WHERE kind='model' AND json_valid(body) AND (${RETIRED_EVALUATION_CONTROLS.map(() => 'json_type(body,?) IS NOT NULL').join(' OR ')})`
  ).run(...RETIRED_EVALUATION_CONTROLS, ...RETIRED_EVALUATION_CONTROLS);
}
