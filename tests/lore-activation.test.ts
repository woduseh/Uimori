import { describe, expect, it } from 'vitest';
import {
  validateContentPackage,
  type ContentPackage,
  type PackageAttachment,
  type PackageLore,
} from '../core/content-package.js';
import {
  LORE_ACTIVATION_LIMITS,
  loreActivationKey,
  loreActivationLore,
  projectLoreActivationReceipt,
  validateLoreActivationReceipt,
  type LoreActivationReceipt,
} from '../core/lore-activation.js';

// The receipt is data: the engine that produced it lives behind the compat layer, and everything here
// is what a reader - compilation, an archive replay, a restored backup - may conclude from the record
// alone.

const ATTACHMENT: PackageAttachment = { id: 'card', revision: 1, role: 'bot' };

function lore(id: string, activation?: PackageLore['activation']): PackageLore {
  return {
    id,
    title: id,
    description: '',
    text: `${id} body`,
    loading: 'discoverable',
    ...(activation ? { activation } : {}),
  };
}

function pkg(partial: Partial<ContentPackage> = {}): ContentPackage {
  return {
    version: 1,
    id: 'card',
    revision: 1,
    title: 'Aria',
    description: '',
    lore: [],
    instructions: [],
    controls: [],
    transforms: [],
    ...partial,
  };
}

const receipt = (): LoreActivationReceipt => ({
  version: 1,
  entries: [
    {
      key: loreActivationKey(ATTACHMENT),
      inputHash: 'a'.repeat(64),
      budget: 48_000,
      activated: ['harbor'],
      omitted: [{ id: 'dragon', reason: 'inactive' }],
    },
  ],
});

describe('receipt contract', () => {
  it('accepts a well formed receipt and rejects a bad hash or an extra field', () => {
    expect(validateLoreActivationReceipt(receipt())).toEqual(receipt());
    const bad = receipt();
    bad.entries[0].inputHash = 'not-a-hash';
    expect(() => validateLoreActivationReceipt(bad)).toThrow('LORE_ACTIVATION_INPUT_HASH');
    expect(() => validateLoreActivationReceipt({ ...receipt(), scannedAt: 'now' })).toThrow(
      'LORE_ACTIVATION_INVALID_FIELDS'
    );
  });

  it('refuses one lore decided twice, whether as two decisions or the same one', () => {
    const overlap = receipt();
    overlap.entries[0].omitted.push({ id: 'harbor', reason: 'budget' });
    expect(() => validateLoreActivationReceipt(overlap)).toThrow('LORE_ACTIVATION_DUPLICATE_LORE');
    const repeated = receipt();
    repeated.entries[0].activated.push('harbor');
    expect(() => validateLoreActivationReceipt(repeated)).toThrow('LORE_ACTIVATION_DUPLICATE_LORE');
  });

  it('refuses a second entry for the same attachment, an unknown reason and a negative budget', () => {
    const duplicate = receipt();
    duplicate.entries.push({ ...duplicate.entries[0] });
    expect(() => validateLoreActivationReceipt(duplicate)).toThrow('LORE_ACTIVATION_DUPLICATE_KEY');
    const reason = receipt();
    reason.entries[0].omitted[0].reason = 'unwanted' as never;
    expect(() => validateLoreActivationReceipt(reason)).toThrow('LORE_ACTIVATION_REASON');
    const budget = receipt();
    budget.entries[0].budget = -1;
    expect(() => validateLoreActivationReceipt(budget)).toThrow('LORE_ACTIVATION_BUDGET');
  });

  it('refuses more entries and more decided ids than the limits allow', () => {
    const entries = receipt();
    entries.entries = Array.from({ length: LORE_ACTIVATION_LIMITS.entries + 1 }, (_, index) => ({
      ...receipt().entries[0],
      key: `card@${index + 1}:bot`,
    }));
    expect(() => validateLoreActivationReceipt(entries)).toThrow('LORE_ACTIVATION_ENTRY_LIMIT');
    const ids = receipt();
    ids.entries[0].activated = Array.from(
      { length: LORE_ACTIVATION_LIMITS.ids + 1 },
      (_, index) => `lore-${index}`
    );
    expect(() => validateLoreActivationReceipt(ids)).toThrow('LORE_ACTIVATION_ID_LIMIT');
  });

  it('projects the decision of one attachment, and no decision at all without an entry', () => {
    expect([...projectLoreActivationReceipt(receipt(), ATTACHMENT)!]).toEqual(['harbor']);
    expect(
      projectLoreActivationReceipt(receipt(), { id: 'other', revision: 1, role: 'module' })
    ).toBeUndefined();
  });

  it('projects an abandoned scan as no decision, not as an empty one', () => {
    const abandoned = receipt();
    abandoned.entries[0] = {
      ...abandoned.entries[0],
      activated: [],
      omitted: [],
      partial: 'error',
      error: 'LORE_ACTIVATION_FAILED',
    };
    expect(projectLoreActivationReceipt(abandoned, ATTACHMENT)).toBeUndefined();
  });
});

describe('scanned lore', () => {
  const entries = [lore('plain'), lore('harbor', { keys: 'harbor' })];

  it('scans the entries carrying a rule, and nothing at all outside keyword mode', () => {
    expect(
      loreActivationLore(pkg({ lore: entries, loreActivation: { mode: 'keyword' } })).map(
        (item) => item.id
      )
    ).toEqual(['harbor']);
    expect(loreActivationLore(pkg({ lore: entries }))).toEqual([]);
    // Switching the mode off keeps the rules stored and stops them deciding anything.
    expect(
      loreActivationLore(pkg({ lore: entries, loreActivation: { mode: 'discoverable' } }))
    ).toEqual([]);
  });
});

describe('package validation', () => {
  it('accepts a keyword package and the rule an import preserves', () => {
    const value = pkg({
      lore: [
        lore('harbor', {
          keys: 'harbor, dock',
          secondaryKeys: 'storm',
          selective: true,
          regex: false,
          child: false,
          rules: '@@probability 50\n@@depth 3',
        }),
      ],
      loreActivation: {
        mode: 'keyword',
        scanDepth: 10,
        recursiveScanning: false,
        fullWordMatching: true,
      },
    });
    expect(validateContentPackage(value)).toEqual(value);
  });

  it('refuses a rule block carrying anything but decorator lines, and an unknown rule field', () => {
    expect(() =>
      validateContentPackage(pkg({ lore: [lore('harbor', { keys: '', rules: 'plain line' })] }))
    ).toThrow('PACKAGE_LORE_ACTIVATION_RULES');
    expect(() =>
      validateContentPackage(pkg({ lore: [lore('harbor', { keys: '', priority: 1 } as never)] }))
    ).toThrow('PACKAGE_INVALID_FIELDS');
  });

  it('refuses a scan depth outside the supported range and an unknown mode', () => {
    expect(() =>
      validateContentPackage(pkg({ loreActivation: { mode: 'keyword', scanDepth: 5000 } }))
    ).toThrow('PACKAGE_LORE_ACTIVATION_SCAN_DEPTH');
    expect(() =>
      validateContentPackage(pkg({ loreActivation: { mode: 'always' } as never }))
    ).toThrow('PACKAGE_LORE_ACTIVATION_MODE');
  });
});
