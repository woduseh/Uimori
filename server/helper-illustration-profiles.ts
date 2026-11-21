import {
  illustrationProfileNameKey,
  inheritIllustrationProfiles,
} from '../core/illustration-profiles.js';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { type IllustrationCharacterProfile } from '../core/illustration.js';
import type { ProviderTool } from '../core/transport.js';
import {
  frozenIllustrationReferences,
  illustrationReferences,
  updateIllustrationReferences,
} from './illustrations.js';
import { fields, HttpError, number, record, text } from './request-validation.js';
import type { Store } from './store.js';

export const HELPER_ILLUSTRATION_PROFILE_TOOLS: ProviderTool[] = [
  {
    name: 'illustration.profiles.read',
    description:
      'Read the character appearance profiles of a chat that illustrations use, the reference images with their explicit roles, effectiveReferences (the roles and linked profileIds actually in effect) and the revision needed for saving. These are the chat-local profiles. The shared defaults of a bot or persona are part of the library resource: read them with resource.read at source.appearanceProfilesPath.',
    inputSchema: {
      type: 'object',
      properties: {
        offset: {
          type: 'integer',
          minimum: 0,
          description: 'Profile offset. Pass the previous nextOffset.',
        },
        limit: { type: 'integer', minimum: 1, description: 'Maximum profiles per page.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'illustration.profiles.save',
    description:
      "Create or edit character appearance profiles for the illustrations of a chat, several at once. Describe what is visible: take the traits from the source text and reference images, or follow the user's brief for an original design. An entry with profileId edits that profile, and fields left out keep their values. An entry without profileId is matched by name: it edits the profile that already has that name, including one inherited from the bot or persona, and creates a profile from name and appearance only when no profile has it. referenceRef links a character image for generation and null removes the link; a linked image is active immediately, so illustration.references.save is not needed for it. Every entry is validated before anything is saved. The result includes effectiveReferences, so no reread is needed to confirm the save. The shared defaults of a bot or persona are edited with resource.patch instead.",
    inputSchema: {
      type: 'object',
      properties: {
        expectedRevision: {
          type: 'integer',
          minimum: 0,
          description: 'Revision from illustration.profiles.read.',
        },
        profiles: {
          type: 'array',
          minItems: 1,
          maxItems: 32,
          description: 'Profiles to create or edit.',
          items: {
            type: 'object',
            properties: {
              profileId: {
                type: 'string',
                minLength: 1,
                maxLength: 100,
                description:
                  'Id of the profile to edit. Omit to match by name, which edits a profile with that name or creates one.',
              },
              name: {
                type: 'string',
                minLength: 1,
                maxLength: 200,
                description: 'Character name. Required when creating.',
              },
              appearance: {
                type: 'string',
                minLength: 1,
                maxLength: 2000,
                description: 'Visible appearance of the character. Required when creating.',
              },
              referenceRef: {
                type: ['string', 'null'],
                minLength: 1,
                maxLength: 300,
                description:
                  'Image ref from illustration.image.list to link as the character reference, or null to remove the link.',
              },
            },
            additionalProperties: false,
          },
        },
      },
      required: ['expectedRevision', 'profiles'],
      additionalProperties: false,
    },
  },
];

function effectiveReferences(
  store: Store,
  chatId: string,
  profiles: IllustrationCharacterProfile[]
) {
  return frozenIllustrationReferences(store, chatId).map(({ ref, role }) => ({
    ref,
    role,
    profileIds: profiles
      .filter((profile) => profile.referenceRef === ref)
      .map((profile) => profile.id),
  }));
}

export function readIllustrationProfiles(
  store: Store,
  chatId: string,
  args: Record<string, unknown>
) {
  fields(args, ['offset', 'limit']);
  const offset = number(args.offset === undefined ? 0 : args.offset, 'offset', 0);
  const { revision, references, characterProfiles } = illustrationReferences(store, chatId);
  const limit = args.limit === undefined ? characterProfiles.length : number(args.limit, 'limit');
  return {
    chatId,
    revision,
    references,
    effectiveReferences: effectiveReferences(store, chatId, characterProfiles),
    characterProfiles: characterProfiles.slice(offset, offset + limit),
    total: characterProfiles.length,
    nextOffset: offset + limit < characterProfiles.length ? offset + limit : null,
  };
}

function editedProfile(args: Record<string, unknown>, previous?: IllustrationCharacterProfile) {
  const profile: IllustrationCharacterProfile = {
    id: previous?.id ?? randomUUID(),
    name: text(args.name === undefined ? previous?.name : args.name, 'character name', 200),
    appearance: text(
      args.appearance === undefined ? previous?.appearance : args.appearance,
      'character appearance',
      2000
    ),
  };
  const ref = args.referenceRef === undefined ? previous?.referenceRef : args.referenceRef;
  if (ref !== undefined && ref !== null)
    profile.referenceRef = text(ref, 'character reference', 300);
  return profile;
}

export function saveIllustrationProfiles(
  store: Store,
  chatId: string,
  args: Record<string, unknown>
) {
  fields(args, ['expectedRevision', 'profiles']);
  const expectedRevision = number(args.expectedRevision, 'reference revision', 0);
  if (!Array.isArray(args.profiles) || !args.profiles.length || args.profiles.length > 32)
    throw new HttpError(400, 'Supply one to 32 illustration profiles.');
  const current = illustrationReferences(store, chatId);
  if (current.revision !== expectedRevision)
    throw new HttpError(409, 'Illustration profiles changed. Read them again before saving.');
  const next = new Map(current.chatCharacterProfiles.map((profile) => [profile.id, profile]));
  const effective = new Map(current.characterProfiles.map((profile) => [profile.id, profile]));
  const seen = new Set<string>();
  const profiles = args.profiles.map((entry) => {
    const edit = record(entry);
    fields(edit, ['profileId', 'name', 'appearance', 'referenceRef']);
    const id = edit.profileId === undefined ? undefined : text(edit.profileId, 'profile ID', 100);
    const previous = id
      ? effective.get(id)
      : typeof edit.name === 'string'
        ? [...effective.values()].find(
            (item) =>
              illustrationProfileNameKey(item.name) ===
              illustrationProfileNameKey(edit.name as string)
          )
        : undefined;
    if (id && !previous) throw new HttpError(404, 'Unknown illustration profile');
    const profile = editedProfile(edit, previous);
    if (seen.has(profile.id)) throw new HttpError(400, 'Duplicate illustration profile ID');
    seen.add(profile.id);
    if (!isDeepStrictEqual(previous, profile)) next.set(profile.id, profile);
    effective.set(profile.id, profile);
    return {
      profileId: profile.id,
      name: profile.name,
      referenceRef: profile.referenceRef ?? null,
      changed: !isDeepStrictEqual(previous, profile),
    };
  });
  const changed = profiles.some((item) => item.changed);
  const revision = changed
    ? updateIllustrationReferences(store, chatId, {
        expectedRevision,
        references: current.references,
        chatCharacterProfiles: [...next.values()],
      }).revision
    : current.revision;
  return {
    chatId,
    revision,
    profiles,
    changed,
    effectiveReferences: effectiveReferences(
      store,
      chatId,
      inheritIllustrationProfiles(current.defaultCharacterProfiles, [...next.values()])
    ),
  };
}
