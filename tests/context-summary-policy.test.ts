import { describe, expect, test } from 'vitest';
import { contextSummaryPolicy } from '../core/context-summary-policy.js';
import { validateGenerationShape } from '../core/model-capabilities.js';
import type { ModelGeneration } from '../core/product.js';

describe('summary goals and provider output headroom', () => {
  test('automatic and manual soft limits respect output headroom and consumer budget', () => {
    const generation: ModelGeneration = { maxOutputTokens: 65536, temperature: null };
    const policy = (
      purpose: 'conversation' | 'helper' | 'tool-results',
      summaryLength?: 2048 | 4096 | 8192 | 16384 | 'auto'
    ) =>
      contextSummaryPolicy({ purpose, summaryLength, consumerInputTokenLimit: 262144, generation });
    expect(policy('conversation', 'auto')).toMatchObject({
      targetSummaryTokens: 8192,
      generation: { maxOutputTokens: 16384 },
    });
    expect(policy('helper', 'auto')).toMatchObject({
      targetSummaryTokens: 4096,
      generation: { maxOutputTokens: 8192 },
    });
    expect(policy('conversation', 16384)).toMatchObject({
      targetSummaryTokens: 16384,
      generation: { maxOutputTokens: 32768 },
    });
    expect(policy('helper', 2048)).toMatchObject({
      targetSummaryTokens: 2048,
      generation: { maxOutputTokens: 4096 },
    });
    expect(policy('tool-results', 16384)).toMatchObject({
      targetSummaryTokens: 2048,
      generation: { maxOutputTokens: 4096 },
    });
    expect(
      contextSummaryPolicy({
        purpose: 'conversation',
        summaryLength: 'auto',
        consumerInputTokenLimit: 8192,
        generation,
      }).targetSummaryTokens
    ).toBe(1024);
    expect(
      contextSummaryPolicy({
        purpose: 'conversation',
        summaryLength: 'auto',
        consumerInputTokenLimit: 262144,
        generation: { ...generation, maxOutputTokens: 4096 },
      }).targetSummaryTokens
    ).toBe(2048);
  });
  test.each([
    { output: 8192, goal: 2048, cap: 4096 },
    { output: 1500, goal: 750, cap: 1500 },
    { output: 512, goal: 256, cap: 512 },
  ])('$output output leaves room for the $goal-token summary goal', ({ output, goal, cap }) => {
    const generation: ModelGeneration = {
      maxOutputTokens: output,
      temperature: null,
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
    expect(policy.targetSummaryTokens).toBeLessThanOrEqual(cap);
    expect(() => validateGenerationShape(policy.generation)).not.toThrow();
    policy.generation.stopSequences!.push('RESULT_ONLY');
    expect(generation).toEqual(original);
  });

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
