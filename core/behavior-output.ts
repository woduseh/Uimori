import {
  BehaviorEvaluationError,
  behaviorOutputConditions,
  parseBehaviorOutput,
  validateBehaviorValue,
  validatePackageBehavior,
  type PackageBehavior,
} from './package-behavior.js';
import type { RuntimeValue } from './prompt-values.js';

function bad(code: string): never {
  throw new BehaviorEvaluationError(400, code);
}

/**
 * Purely projects selected response parsers over one fixed text and state snapshot.
 * Conditions all observe the original base state; enabled parsers then apply in selection order.
 */
export function projectBehaviorOutputs(
  behavior: PackageBehavior,
  parserIds: string[],
  state: RuntimeValue,
  text: string,
  hostRuntime: Record<string, RuntimeValue> = {}
): RuntimeValue {
  const definition = validatePackageBehavior(behavior);
  if (
    !Array.isArray(parserIds) ||
    !parserIds.length ||
    new Set(parserIds).size !== parserIds.length
  )
    bad('BEHAVIOR_PARSER_IDS');
  const selected = parserIds.map((id) => {
    const parser = definition.outputParsers.find((candidate) => candidate.id === id);
    if (!parser) bad('BEHAVIOR_PARSER_UNKNOWN');
    return parser;
  });
  const paths = selected.flatMap((parser) => parser.fields.map((field) => field.path.join('/')));
  for (let index = 0; index < paths.length; index++)
    for (let other = index + 1; other < paths.length; other++)
      if (
        paths[index] === paths[other] ||
        paths[index].startsWith(paths[other] + '/') ||
        paths[other].startsWith(paths[index] + '/')
      )
        bad('BEHAVIOR_OVERLAPPING_PARSERS');

  const base = validateBehaviorValue(definition.stateSchema, state);
  const allowed = behaviorOutputConditions(definition, selected, base, hostRuntime);
  let next = base;
  for (const [index, parser] of selected.entries()) {
    if (!allowed[index]) continue;
    next = parseBehaviorOutput(definition, parser, next, text);
  }
  return next;
}
