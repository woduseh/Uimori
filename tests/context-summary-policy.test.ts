import { describe, expect, test } from 'vitest';
import { contextSummaryPolicy } from '../core/context-summary-policy.js';
import { validateGenerationShape } from '../core/model-capabilities.js';
import type { ModelGeneration } from '../core/product.js';

describe('summary goals and provider output headroom', () => {
  test.each([
    { output: 8192, thinking: 8191, goal: 2048, cap: 4096, budget: 2048 },
    { output: 4096, thinking: 1536, goal: 2048, cap: 4096, budget: 1536 },
    { output: 1500, thinking: 1200, goal: 476, cap: 1500, budget: 1024 },
    { output: 1025, thinking: 1024, goal: 1, cap: 1025, budget: 1024 },
    { output: 1024, thinking: 1024, goal: 512, cap: 1024, budget: undefined },
    { output: 512, thinking: 1024, goal: 256, cap: 512, budget: undefined },
  ])(
    '$output output with $thinking numeric thinking leaves room for the $goal-token summary goal',
    ({ output, thinking, goal, cap, budget }) => {
      const generation: ModelGeneration = {
        maxOutputTokens: output,
        temperature: null,
        ...(output <= 1024 ? { thinkingMode: 'enabled' as const } : {}),
        thinkingBudgetTokens: thinking,
        stopSequences: ['UNCHANGED_STOP'],
      };
      const original = structuredClone(generation);
      const policy = contextSummaryPolicy({
        purpose: 'conversation',
        consumerInputTokenLimit: 65536,
        generation,
      });
      expect(policy.targetSummaryTokens).toBe(goal);
      expect(policy.generation.maxOutputTokens).toBe(cap);
      expect(policy.generation.thinkingBudgetTokens).toBe(budget);
      expect(policy.generation.thinkingMode).toBe(budget === undefined ? 'disabled' : undefined);
      expect(policy.targetSummaryTokens + (budget ?? 0)).toBeLessThanOrEqual(cap);
      expect(() => validateGenerationShape(policy.generation)).not.toThrow();
      policy.generation.stopSequences!.push('RESULT_ONLY');
      expect(generation).toEqual(original);
    }
  );

  test.each(['conversation', 'tool-results', 'helper'] as const)(
    '%s uses its consumer headroom without changing nonnumeric thinking controls',
    (purpose) => {
      const generation: ModelGeneration = {
        maxOutputTokens: 8192,
        temperature: 0.2,
        thinkingLevel: 'LOW',
        reasoningEffort: 'medium',
      };
      const original = structuredClone(generation);
      const policy = contextSummaryPolicy({
        purpose,
        consumerInputTokenLimit: 8000,
        fixedInputTokens: 7900,
        generation,
      });
      // One token is still only guidance; the caller rejects an infeasible fixed input.
      expect(policy.targetSummaryTokens).toBe(purpose === 'conversation' ? 1 : 100);
      expect(policy.generation).toEqual({ ...original, maxOutputTokens: 4096 });
      expect(generation).toEqual(original);
    }
  );
});
