import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { IllustrationCharacterProfile } from '../core/illustration.js';
import type { ProviderTool } from '../core/transport.js';
import { illustrationReferences, updateIllustrationReferences } from './illustrations.js';
import { fields, HttpError, number, record, text } from './request-validation.js';
import type { Store } from './store.js';

export const HELPER_ILLUSTRATION_PROFILE_TOOLS: ProviderTool[] = [
  {
    name: 'illustration.profiles.read',
    description:
      'Read character appearance profiles, selected image references and the chat’s revision. Use illustration.image.list to find reference images.',
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
      'Save the requested character appearances together in the current chat. For an extraction, use traits described in the source or visible in the reference. For an original design, follow the user’s brief. Create with name and appearance, or pass the existing profile’s id as profileId and only the fields to change. Use referenceRef to link an image or null to unlink it. Use the revision from illustration.profiles.read as expectedRevision.',
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
  return { chatId, revision, profiles, changed };
}
