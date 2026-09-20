import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LORE_CONTEXT,
  DEFAULT_TOKEN_LORE_CONTEXT,
  type LoreContextSnapshot,
} from '../core/lore-context.js';
import { parseLorePolicyDraft } from '../web/LoreContextPolicyEditor.js';
import { LoreContextDiagnostics } from '../web/LoreContextDiagnostics.js';

const common = {
  enabled: true,
  maxRetainedEntries: '64',
  threshold: '0.65',
  maxSelectedTokens: '8000',
  maxInputTokens: '28000',
};

describe('lore token policy UI contracts', () => {
  it('retains old draft inputs and their character semantics', () => {
    expect(
      parseLorePolicyDraft({ ...common, maxRetainedChars: '48000', maxPinnedChars: '200000' })
    ).toEqual(DEFAULT_LORE_CONTEXT);
  });

  it('serializes token fields without character fields', () => {
    expect(
      parseLorePolicyDraft({
        ...common,
        budgetUnit: 'tokens',
        maxRetainedTokens: '16000',
        maxPinnedTokens: '64000',
      })
    ).toEqual(DEFAULT_TOKEN_LORE_CONTEXT);
  });

  it('does not substitute legacy numbers for missing token inputs', () => {
    expect(() =>
      parseLorePolicyDraft({
        ...common,
        budgetUnit: 'tokens',
        maxRetainedChars: '48000',
        maxPinnedChars: '200000',
      })
    ).toThrow();
    expect(() =>
      parseLorePolicyDraft({
        ...common,
        budgetUnit: 'tokens',
        maxRetainedTokens: '',
        maxPinnedTokens: '64000',
      })
    ).toThrow();
  });

  it('shows token estimates and preserves source-length diagnostics', () => {
    const snapshot: LoreContextSnapshot = {
      version: 1,
      policy: DEFAULT_TOKEN_LORE_CONTEXT,
      canonHash: 'a'.repeat(64),
      dependencies: [],
      entries: [],
      stats: {
        retainedChars: 200,
        retainedTokens: 100,
        retainedEntries: 0,
        appendedChars: 200,
        droppedEntries: 0,
        reasons: [],
      },
    };
    const html = renderToStaticMarkup(createElement(LoreContextDiagnostics, { snapshot }));
    expect(html).toContain('유지한 추정 토큰');
    expect(html).toContain('100');
    expect(html).toContain('새로 더한 문자');
    expect(html).not.toContain('미측정');
    const { retainedTokens: _tokens, ...unknown } = snapshot.stats;
    expect(
      renderToStaticMarkup(
        createElement(LoreContextDiagnostics, { snapshot: { ...snapshot, stats: unknown } })
      )
    ).toContain('미측정');
  });
});
