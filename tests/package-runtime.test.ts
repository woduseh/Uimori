import { describe, expect, it } from 'vitest';
import type { ContentPackage, PackageTransform } from '../core/content-package.js';
import { compilePackageAttachment, renderPackageStateView } from '../core/package-runtime.js';
import { applyPackageTransforms } from '../server/package-transforms.js';

const pkg = (): ContentPackage => ({ version: 1, id: 'shared', revision: 2, title: 'Shared', description: 'Original description', body: 'Original body', roleBindings: { bot: 'Portray this person.', persona: 'This is the reader reference.' }, lore: [{ id: 'home', title: 'Home', description: 'Original metadata', text: 'Original lore', loading: 'discoverable', relatedIds: ['home'] }], instructions: [{ id: 'style', target: 'main', text: 'Original instruction', when: { control: 'on' } }, { id: 'translate', target: 'translation', text: 'Preserve names.' }], controls: [{ id: 'on', label: 'On', type: 'boolean', default: true }], transforms: [] });
const rule = (pattern: string, replacement: string, flags = 'g'): PackageTransform => ({ id: 'display', target: 'source', pattern, replacement, flags });
describe('package role projection', () => {
  it('isolates role namespaces, keeps discoverable bodies out of pinned, and selects role instructions', () => {
    const value = pkg(), before = structuredClone(value);
    const bot = compilePackageAttachment(value, { id: value.id, revision: 2, role: 'bot' }, { chatId: 'chat', target: 'main' });
    const persona = compilePackageAttachment(value, { id: value.id, revision: 2, role: 'persona' }, { chatId: 'chat', target: 'translation' });
    expect(bot.pinned.map(r => r.text)).toEqual(['Original body']);
    expect(bot.instructions.map(i => i.text)).toEqual(['Portray this person.', 'Original instruction']);
    expect(persona.instructions.map(i => i.text)).toEqual(['This is the reader reference.', 'Preserve names.']);
    expect(bot.resources[1].id).not.toBe(persona.resources[1].id);
    expect(bot.resources[1].relatedIds).toEqual([bot.resources[1].id]); expect(value).toEqual(before);
  });
  it('rejects stale attachment and evaluates typed controls without rewriting instruction text', () => {
    expect(() => compilePackageAttachment(pkg(), { id: 'shared', revision: 1, role: 'module' }, { chatId: 'x', target: 'main' })).toThrow('PACKAGE_REVISION_MISMATCH');
    const result = compilePackageAttachment(pkg(), { id: 'shared', revision: 2, role: 'module' }, { chatId: 'x', target: 'main', values: { on: false } });
    expect(result.instructions).toEqual([]); expect(result.resources[0].text).toBe('Original body');
  });
  it('renders typed state as plain descriptors and distinguishes missing values from zero/false', () => {
    const view = { title: 'Status', fields: [{ key: 'hp', label: 'HP', format: 'number' as const }, { key: 'hidden', label: 'Hidden', format: 'boolean' as const }, { key: 'missing', label: 'Missing' }] };
    expect(renderPackageStateView(view, { hp: 0, hidden: false }).fields.map(f => [f.text, f.missing])).toEqual([['0', false], ['false', false], ['—', true]]);
    expect(() => renderPackageStateView(view, { hp: '3' })).toThrow('PACKAGE_STATE_TYPE');
  });
});
describe('isolated presentation transforms', () => {
  it('supports multiline captures without changing the supplied raw text and respects target', async () => {
    const text = 'Before\n<status>HP: 3\nMood: calm</status>\nAfter';
    const result = await applyPackageTransforms(text, [rule('<status>([\\s\\S]*?)</status>', '[State]\n$1')], 'source');
    expect(result.text).toBe('Before\n[State]\nHP: 3\nMood: calm\nAfter'); expect(text).toContain('<status>'); expect(result.changed).toBe(true);
    expect(await applyPackageTransforms(text, [rule('.', 'X')], 'translation')).toEqual({ text, applied: [], changed: false });
  });
  it('matches ECMAScript replacement semantics including empty unicode matches', async () => {
    for (const [text, pattern, replacement, flags] of [['ab', '(a)', "$$:$&:$1:$12:$`:$'", 'g'], ['😀x', '(?:)', '-', 'gu'], ['ab', '(?<first>a)', '$<first>', 'g']]) {
      expect((await applyPackageTransforms(text, [rule(pattern, replacement, flags)], 'source')).text).toBe(text.replace(new RegExp(pattern, flags), replacement));
    }
  });
  it('reports invalid regex and output expansion instead of swallowing them', async () => {
    await expect(applyPackageTransforms('abc', [rule('(', '')], 'source')).rejects.toThrow('PACKAGE_REGEX_INVALID');
    await expect(applyPackageTransforms('x'.repeat(1000), [rule('x', 'y'.repeat(4096))], 'source')).rejects.toThrow('PACKAGE_TRANSFORM_OUTPUT_LIMIT');
  });
  it('terminates catastrophic backtracking and allows the next independent transform', async () => {
    await expect(applyPackageTransforms('a'.repeat(50_000) + '!', [rule('(a+)+$', '')], 'source', { timeoutMs: 200 })).rejects.toThrow('PACKAGE_TRANSFORM_TIMEOUT');
    expect((await applyPackageTransforms('healthy', [rule('healthy', 'ready')], 'source')).text).toBe('ready');
  });
});
