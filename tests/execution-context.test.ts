import { describe, expect, it } from 'vitest';
import { executionContext } from '../core/execution-context.js';
import { defaultProfile } from '../core/product.js';
import type { RunSnapshot } from '../core/types.js';
import { nativeContent } from './fixtures/native-content.js';
function snapshot(): RunSnapshot {
  const pkg = nativeContent({ name: 'Ari', description: 'Card description' });
  return {
    chatId: 'chat',
    branchId: 'branch',
    parentRevision: null,
    settingsRevision: 1,
    settings: { status: false, maxCalls: 4 },
    request: 'Continue',
    history: [],
    resources: [],
    profile: {
      ...defaultProfile('chat'),
      models: {},
      packages: [pkg],
      packageAttachments: [{ id: pkg.id, revision: 1, role: 'bot' }],
    },
  };
}
describe('frozen host context', () => {
  it('reads identities and a captured clock without mutating the snapshot', () => {
    const s = snapshot();
    s.executionClock = { iso: '2026-09-19T00:00:00.000Z', unix: 1789776000 };
    const before = structuredClone(s),
      value = executionContext(s);
    expect(value.bot).toMatchObject({ name: 'Ari' });
    expect(value.input).toEqual({ text: 'Continue' });
    expect(value.time).toEqual({ ...s.executionClock, timezone: 'UTC' });
    expect(s).toEqual(before);
  });
  it('limits recent history while retaining its latest ending and total count', () => {
    const s = snapshot();
    s.logicalHistory = Array.from({ length: 110 }, (_, i) => ({
      id: `m${i}`,
      role: i % 2 ? ('assistant' as const) : ('user' as const),
      text: `${i}:` + 'x'.repeat(1000),
    }));
    const history = executionContext(s).history as {
      recent: { text: string }[];
      total: number;
      truncated: boolean;
    };
    expect(history.total).toBe(110);
    expect(history.truncated).toBe(true);
    expect(history.recent.at(-1)!.text).toContain('109:');
    expect(history.recent.reduce((n, item) => n + item.text.length, 0)).toBeLessThanOrEqual(60000);
  });
  it('excludes resources outside the captured attachment scope', () => {
    const s = snapshot();
    s.resources = [
      {
        id: 'package:other:bot:body',
        chatId: 'chat',
        revision: 1,
        title: 'Other',
        description: 'Private',
        text: 'Secret',
        kind: 'lore',
        loading: 'pinned',
      },
    ];
    expect(executionContext(s).catalog).toMatchObject({ items: [], total: 0 });
  });
});
