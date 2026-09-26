import { describe, expect, it } from 'vitest';
import { compileContentAttachment } from '../core/package-runtime.js';
import { nativeContent } from './fixtures/native-content.js';
const fixture = () =>
  nativeContent({
    name: 'Ari',
    description: 'Authored {{char}} body',
    system_prompt: 'RETIRED_SYSTEM {{user}}',
    post_history_instructions: 'Global note {{user}}',
    character_book: {
      entries: [
        { keys: [], comment: 'Always', content: 'Pinned lore', constant: true, enabled: true },
        {
          keys: ['city'],
          comment: 'Optional',
          content: 'Optional lore',
          constant: false,
          enabled: true,
        },
      ],
    },
  });
describe('native content resource projection', () => {
  it('namespaces roles and retains original text until the Risu runtime evaluates it', () => {
    const pkg = fixture();
    const bot = compileContentAttachment(
      pkg,
      { id: pkg.id, revision: 1, role: 'bot' },
      { chatId: 'chat' }
    );
    const persona = compileContentAttachment(
      pkg,
      { id: pkg.id, revision: 1, role: 'persona' },
      { chatId: 'chat' }
    );
    expect(bot.resources.find((r) => r.id.endsWith(':body'))?.text).toBe('Authored {{char}} body');
    expect(bot.resources.every((r) => r.id.startsWith(`package:${pkg.id}:bot:`))).toBe(true);
    expect(persona.resources.every((r) => r.id.startsWith(`package:${pkg.id}:persona:`))).toBe(
      true
    );
    expect(bot).not.toHaveProperty('instructions');
    expect(pkg.nativeRisu.card.post_history_instructions).toBe('Global note {{user}}');
    expect(JSON.stringify(bot)).not.toContain('RETIRED_SYSTEM');
    expect(JSON.stringify(bot)).not.toContain('Global note');
    expect(bot.pinned.some((r) => r.text === 'Optional lore')).toBe(false);
  });
  it('adds selected optional lore while leaving source and discoverable resources intact', () => {
    const pkg = fixture(),
      before = structuredClone(pkg);
    const result = compileContentAttachment(
      pkg,
      { id: pkg.id, revision: 1, role: 'bot' },
      { chatId: 'chat', loreSelection: new Set(['lore-1']) }
    );
    expect(result.pinned.some((r) => r.text === 'Optional lore')).toBe(true);
    expect(pkg).toEqual(before);
  });
  it('rejects stale revisions and absent ownership before serving resources', () => {
    const pkg = fixture();
    expect(() =>
      compileContentAttachment(pkg, { id: pkg.id, revision: 2, role: 'bot' }, { chatId: 'chat' })
    ).toThrow('PACKAGE_REVISION_MISMATCH');
    expect(() =>
      compileContentAttachment(pkg, { id: pkg.id, revision: 1, role: 'bot' }, { chatId: '' })
    ).toThrow('PACKAGE_CHAT_REQUIRED');
  });
});
