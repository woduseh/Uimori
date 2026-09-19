import { describe, expect, it } from 'vitest';
import { validateRisuContent, validateContentAttachment } from '../core/risu-content.js';
import { nativeContent } from './fixtures/native-content.js';

describe('Risu content storage contract', () => {
  it('preserves authored CBS, Lua and regex data and returns an independent copy', () => {
    const pkg = nativeContent({
      name: 'Ari',
      description: '{{char}} meets {{user}}',
      first_mes: '<button risu-trigger="start">Start</button>',
      extensions: {
        risuai: {
          backgroundHTML: '<style>.card{color:red}</style>',
          customScripts: [{ in: '<image>', out: '<img src="asset">', type: 'editdisplay' }],
          triggerscript: [{ type: 'start', effect: [{ type: 'triggerlua', code: 'return 1' }] }],
        },
      },
    });
    const saved = validateRisuContent(pkg);
    expect(saved).toEqual(pkg);
    expect(saved.nativeRisu).not.toBe(pkg.nativeRisu);
    saved.nativeRisu.card.name = 'Changed';
    expect(pkg.nativeRisu.card.name).toBe('Ari');
    for (const role of ['bot', 'persona', 'module'])
      expect(validateContentAttachment({ id: pkg.id, revision: 1, role }).role).toBe(role);
  });
  it('requires native authorship and rejects removed independent authoring fields', () => {
    const pkg = nativeContent();
    const { nativeRisu: _, ...missing } = pkg;
    expect(() => validateRisuContent(missing)).toThrow();
    for (const field of [
      'controls',
      'transforms',
      'bodyTemplate',
      'behavior',
      'panels',
      'stateView',
      'sourceSegments',
    ])
      expect(() => validateRisuContent({ ...pkg, [field]: [] })).toThrow();
    expect(() => validateRisuContent({ ...pkg, version: 2 })).toThrow(
      'PACKAGE_VERSION_UNSUPPORTED'
    );
    expect(() =>
      validateRisuContent({ ...pkg, nativeRisu: { ...pkg.nativeRisu, sourceHash: 'bad' } })
    ).toThrow();
  });
  it('rejects dangling projected lore references without mutating the card', () => {
    const pkg = nativeContent({
      character_book: {
        entries: [
          { keys: ['city'], content: 'City facts', comment: 'City', enabled: true, constant: true },
        ],
      },
    });
    pkg.lore[0].relatedIds = ['missing'];
    expect(() => validateRisuContent(pkg)).toThrow('PACKAGE_LORE_REFERENCE');
  });
});
