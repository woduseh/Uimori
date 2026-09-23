import { describe, expect, it } from 'vitest';
import { compiledPackages, packageContext, packageSlots } from '../core/package-context.js';
import { defaultProfile } from '../core/product.js';
import type { RunSnapshot } from '../core/types.js';
import { nativeContent } from './fixtures/native-content.js';
function snapshot(): RunSnapshot {
  const pkg = nativeContent({
    name: 'Ari',
    description: 'EXACT_BODY',
    system_prompt: 'RETIRED_MAIN_ONLY',
    post_history_instructions: 'ACTIVE_GLOBAL_NOTE',
    character_book: {
      entries: [
        { keys: [], comment: 'Facts', content: 'EXACT_LORE', constant: true, enabled: true },
      ],
    },
  });
  return {
    chatId: 'chat',
    parentRevision: null,
    settingsRevision: 1,
    settings: { status: false, maxCalls: 4 },
    request: 'Continue.',
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
describe('frozen Risu resource context', () => {
  it('provides pinned body and lore while leaving global-note placement to the native preset', () => {
    const s = snapshot(),
      before = structuredClone(s),
      result = packageContext(s, 'main')!;
    expect(result.pinned.map((r) => r.text)).toEqual(
      expect.arrayContaining(['EXACT_BODY', 'EXACT_LORE'])
    );
    expect(result).not.toHaveProperty('instructions');
    expect(s.profile!.packages![0].nativeRisu.card.post_history_instructions).toBe(
      'ACTIVE_GLOBAL_NOTE'
    );
    expect(JSON.stringify(result)).not.toContain('RETIRED_MAIN_ONLY');
    expect(packageSlots(s, 'main')).toMatchObject({ char: 'Ari', lore: 'EXACT_LORE' });
    expect(packageContext(s, 'translation')).not.toHaveProperty('instructions');
    expect(s).toEqual(before);
  });
  it('rejects incomplete snapshots before providing any package context', () => {
    const s = snapshot();
    s.profile!.packageAttachments![0].revision = 2;
    expect(() => compiledPackages(s, 'main')).toThrow('PACKAGE_SNAPSHOT_REVISION_MISSING');
  });
  it('preserves frozen records independently of later authored changes', () => {
    const s = snapshot(),
      frozen = structuredClone(s);
    s.profile!.packages![0].body = 'Later body';
    expect(packageContext(frozen, 'main')!.pinned.some((r) => r.text === 'EXACT_BODY')).toBe(true);
    expect(packageContext(frozen, 'main')!.pinned.some((r) => r.text === 'Later body')).toBe(false);
  });
});
