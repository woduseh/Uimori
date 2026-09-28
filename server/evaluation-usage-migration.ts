import type { DatabaseSync } from 'node:sqlite';

/** Recover only explicit, saved tool definitions. Current model settings and model responses
 * are not evidence of what a historical call did; pruned requests remain unclassified. */
export function classifySavedEvaluationUsage(db: DatabaseSync): void {
  db.exec(`UPDATE attempts SET usage_kind='writing'
    WHERE usage_kind='unclassified' AND role='main' AND usage_detached=0
      AND json_valid(request)
      AND json_extract(request,'$.agentId') IS NULL
      AND json_extract(request,'$.nativeScript') IS NULL
      AND json_extract(request,'$.judgment') IS NULL
      AND 2=(SELECT COUNT(DISTINCT name) FROM (
        SELECT COALESCE(json_extract(t.value,'$.function.name'),json_extract(t.value,'$.name')) AS name
          FROM json_each(request,'$.body.tools') t WHERE t.type='object'
        UNION ALL
        SELECT json_extract(f.value,'$.name') AS name
          FROM json_each(request,'$.body.tools') t,
            json_each(t.value,'$.functionDeclarations') f WHERE t.type='object' AND f.type='object'
      ) WHERE name IN ('eval_create_case','eval_submit_artifact'));`);
}
