import { afterEach, expect, test, vi } from 'vitest';
import {
  completePendingStoryProfile,
  PendingStoryProfileConflict,
  savePendingStoryProfile,
  acceptSavedStoryProfile,
} from '../web/pendingStory.js';

const original = [{ id: 'bot', revision: 1, role: 'bot' as const }];
const changed = [...original, { id: 'module', revision: 1, role: 'module' as const }];

function fixture() {
  const values = new Map<string, string>();
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  let profile = {
    chatId: 'chat',
    revision: 1,
    image: false,
    packageAttachments: [] as typeof changed,
  };
  let fail = true;
  let puts = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    if (init?.method !== 'PUT') return Response.json(profile);
    puts++;
    const body = JSON.parse(String(init.body));
    if (body.expectedRevision !== profile.revision)
      return Response.json({ error: 'Profile revision conflict' }, { status: 409 });
    profile = {
      ...profile,
      revision: profile.revision + 1,
      packageAttachments: body.packageAttachments,
    };
    if (fail) {
      fail = false;
      throw new TypeError('Response lost');
    }
    return Response.json(profile);
  });
  savePendingStoryProfile('chat', { packageAttachments: original });
  return {
    values,
    get puts() {
      return puts;
    },
    get profile() {
      return profile;
    },
    change() {
      profile = { ...profile, revision: profile.revision + 1, packageAttachments: changed };
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('a lost profile response followed by a different saved attachment never overwrites it', async () => {
  const f = fixture();
  await expect(completePendingStoryProfile('chat')).rejects.toThrow('Response lost');
  f.change();
  await expect(completePendingStoryProfile('chat')).rejects.toThrow();
  expect(f.profile.packageAttachments).toEqual(changed);
  expect(f.puts).toBe(1);
  expect(f.values.has('pending-profile:chat')).toBe(true);
});

test('an unchanged profile confirms a lost response without a second profile write', async () => {
  const f = fixture();
  await expect(completePendingStoryProfile('chat')).rejects.toThrow('Response lost');
  await expect(completePendingStoryProfile('chat')).resolves.toBeUndefined();
  expect(f.profile.packageAttachments).toEqual(original);
  expect(f.puts).toBe(1);
  expect(f.values.has('pending-profile:chat')).toBe(false);
});

test('using saved settings discards only the exact conflict the user reviewed', async () => {
  const f = fixture();
  await expect(completePendingStoryProfile('chat')).rejects.toThrow('Response lost');
  f.change();
  let conflict: PendingStoryProfileConflict | undefined;
  try {
    await completePendingStoryProfile('chat');
  } catch (error) {
    expect(error).toBeInstanceOf(PendingStoryProfileConflict);
    conflict = error as PendingStoryProfileConflict;
  }
  expect(conflict).toBeDefined();
  f.values.set('pending-profile:chat', 'newer intent');
  expect(() => acceptSavedStoryProfile('chat', conflict!.savedIntent)).toThrow();
  expect(f.values.get('pending-profile:chat')).toBe('newer intent');
  f.values.set('pending-profile:chat', conflict!.savedIntent);
  acceptSavedStoryProfile('chat', conflict!.savedIntent);
  expect(f.values.has('pending-profile:chat')).toBe(false);
  expect(f.profile.packageAttachments).toEqual(changed);
});
