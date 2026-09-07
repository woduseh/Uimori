/** Model-preset-owned evaluation tool settings. They do not select or configure a provider. */
export type EvaluationToolOptions = {
  contextMode: 'model-selected' | 'preloaded';
  approvalReasoningMode: 'configured' | 'economized';
  maximumToolRounds: number;
  terminalLateCorrections: boolean;
  outputRecovery: boolean;
};

export function defaultEvaluationToolOptions(): EvaluationToolOptions {
  return { contextMode: 'model-selected', approvalReasoningMode: 'configured', maximumToolRounds: 8, terminalLateCorrections: false, outputRecovery: true };
}

export function validateEvaluationToolOptions(value: unknown): EvaluationToolOptions {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('INVALID_EVALUATION_TOOL_OPTIONS');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !['contextMode','approvalReasoningMode','maximumToolRounds','terminalLateCorrections','outputRecovery'].includes(key))) throw new Error('INVALID_EVALUATION_TOOL_OPTIONS');
  if (!['model-selected','preloaded'].includes(String(input.contextMode))) throw new Error('INVALID_EVALUATION_TOOL_OPTIONS');
  if (!['configured','economized'].includes(String(input.approvalReasoningMode))) throw new Error('INVALID_EVALUATION_TOOL_OPTIONS');
  if (!Number.isSafeInteger(input.maximumToolRounds) || Number(input.maximumToolRounds) < 0 || Number(input.maximumToolRounds) > 32) throw new Error('INVALID_EVALUATION_TOOL_OPTIONS');
  if (typeof input.terminalLateCorrections !== 'boolean' || typeof input.outputRecovery !== 'boolean') throw new Error('INVALID_EVALUATION_TOOL_OPTIONS');
  return { contextMode: input.contextMode as EvaluationToolOptions['contextMode'], approvalReasoningMode: input.approvalReasoningMode as EvaluationToolOptions['approvalReasoningMode'], maximumToolRounds: Number(input.maximumToolRounds), terminalLateCorrections: input.terminalLateCorrections, outputRecovery: input.outputRecovery };
}
