import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { IllustrationCharacterProfile } from '../core/illustration.js';
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
      'Read appearance profiles, explicit references, effectiveReferences (actual character/style roles and linked profileIds) and revision. Find image refs via illustration.image.list.',
    inputSchema: {
      type: 'object',
      properties: {
        offset: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'illustration.profiles.save',
    description:
      'Save character appearances together in this chat. Extract visible/source-backed traits, or follow the brief for original designs. Create with name and appearance; edit using profileId. referenceRef links the character image for generation (null unlinks); no second references.save is needed. Use expectedRevision from profiles.read. The result includes effectiveReferences, so do not reread solely to confirm a successful save.',
    inputSchema: {
      type: 'object',
      properties: {
        expectedRevision: { type: 'integer', minimum: 0 },
        profiles: {
          type: 'array',
          minItems: 1,
          maxItems: 32,
          items: {
            type: 'object',
            properties: {
              profileId: { type: 'string', minLength: 1, maxLength: 100 },
              name: { type: 'string', minLength: 1, maxLength: 200 },
              appearance: { type: 'string', minLength: 1, maxLength: 2000 },
              referenceRef: { type: ['string', 'null'], minLength: 1, maxLength: 300 },
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

/** All edits share one reference revision and one helper operation receipt. */
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
  const next = new Map(current.characterProfiles.map((profile) => [profile.id, profile]));
  const seen = new Set<string>();
  const profiles = args.profiles.map((entry) => {
    const edit = record(entry);
    fields(edit, ['profileId', 'name', 'appearance', 'referenceRef']);
    const id = edit.profileId === undefined ? undefined : text(edit.profileId, 'profile ID', 100);
    const previous = id ? next.get(id) : undefined;
    if (id && !previous) throw new HttpError(404, 'Unknown illustration profile');
    if (id && seen.has(id)) throw new HttpError(400, 'Duplicate illustration profile ID');
    const profile = editedProfile(edit, previous);
    seen.add(profile.id);
    next.set(profile.id, profile);
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
        characterProfiles: [...next.values()],
      }).revision
    : current.revision;
  return {
    chatId,
    revision,
    profiles,
    changed,
    effectiveReferences: effectiveReferences(store, chatId, [...next.values()]),
  };
}
