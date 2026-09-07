import { describe, expect, it } from 'vitest';
import { validateContentPackage, validatePackageAttachment, validatePackageTransform, type ContentPackage } from '../core/content-package.js';

const modulePackage = (): ContentPackage => ({ version: 1, id: 'style-kit', revision: 1, title: '장면 지침', description: '인물이 없는 모듈', body: 'Keep the supplied premise.', lore: [], instructions: [{ id: 'style', target: 'main', text: 'Use concrete detail.' }], controls: [], transforms: [] });
describe('content package data contract', () => {
  it('keeps body, internal lore and metadata byte-for-byte and accepts every attachment role without identity', () => {
    const value = modulePackage(); value.lore = [{ id: 'city', title: '도시', description: 'alias: 항구', text: '\r\n원문 {{opaque}}\n', loading: 'discoverable' }];
    const copy = validateContentPackage(value); expect(copy).toEqual(value); expect(copy).not.toBe(value);
    for (const role of ['bot', 'persona', 'module']) expect(validatePackageAttachment({ id: value.id, revision: 1, role }).role).toBe(role);
  });
  it('rejects executable extension fields, unsupported versions and unresolved internal lore links', () => {
    expect(() => validateContentPackage({ ...modulePackage(), lua: 'return 1' })).toThrow('PACKAGE_INVALID_FIELDS');
    expect(() => validateContentPackage({ ...modulePackage(), version: 2 })).toThrow('PACKAGE_VERSION_UNSUPPORTED');
    expect(() => validateContentPackage({ ...modulePackage(), lore: [{ id: 'a', title: '', description: '', text: '', loading: 'discoverable', relatedIds: ['missing'] }] })).toThrow('PACKAGE_LORE_REFERENCE');
  });
  it('reuses typed controls and validates conditional templates before execution', () => {
    const p = modulePackage(); p.controls = [{ id: 'detail', label: '상세', type: 'boolean', default: true }];
    p.instructions[0].when = { control: 'missing' };
    expect(() => validateContentPackage(p)).toThrow('PROMPT_UNKNOWN_CONTROL');
    p.instructions[0].when = { control: 'detail' }; expect(validateContentPackage(p)).toEqual(p);
  });
  it('accepts conventional regex data for worker execution but rejects duplicate flags', () => {
    const rule = { id: 'view', target: 'source', pattern: '<status>([\\s\\S]*?)</status>', flags: 'g', replacement: '$1' };
    expect(validatePackageTransform(rule).pattern).toBe(rule.pattern);
    expect(() => validatePackageTransform({ ...rule, flags: 'gg' })).toThrow('PACKAGE_REGEX_FLAGS');
  });
});
