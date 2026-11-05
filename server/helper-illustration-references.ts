import type { ProviderTool } from '../core/transport.js';
import {
  illustrationReferenceCandidates,
  illustrationReferences,
  updateIllustrationReferences,
} from './illustrations.js';
import { resolveIllustrationCutImage } from './helper-illustration-cuts.js';
import { choice, fields, HttpError, number, record, text } from './request-validation.js';
import type { Store } from './store.js';

export const HELPER_ILLUSTRATION_REFERENCE_TOOLS: ProviderTool[] = [
  {
    name: 'illustration.references.save',
    description:
      'Assign reference images together using the revision from illustration.profiles.read. For each image supply a candidate ref, or an imageId from a completed cut to reuse that exact variation. Set role to character, style, or null to clear its explicit role. When provided, profileIds replaces the people linked to that image; use an empty list to unlink them. Linked images guide character design. For a character image linked through referenceRef, use illustration.profiles.save instead; this tool is for explicit style roles, reassignment and generated-cut promotion. Omitted roles and links stay as saved.',
    inputSchema: {
      type: 'object',
      properties: {
        expectedRevision: { type: 'integer', minimum: 0 },
        assignments: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              ref: { type: 'string', minLength: 1, maxLength: 300 },
              imageId: { type: 'string', minLength: 1, maxLength: 100 },
              role: { type: ['string', 'null'], enum: ['character', 'style', null] },
              profileIds: {
                type: 'array',
                items: { type: 'string', minLength: 1, maxLength: 100 },
              },
            },
            additionalProperties: false,
          },
        },
      },
      required: ['expectedRevision', 'assignments'],
      additionalProperties: false,
    },
  },
];

/** Promotion and role changes share a transaction so a rejected batch leaves no unused assets. */
export function saveIllustrationReferenceAssignments(
  store: Store,
  chatId: string,
  args: Record<string, unknown>
) {
  fields(args, ['expectedRevision', 'assignments']);
  const expectedRevision = number(args.expectedRevision, 'reference revision', 0);
  const assignments = args.assignments;
  if (!Array.isArray(assignments) || !assignments.length)
    throw new HttpError(400, 'Supply an image assignment.');
  return store.transaction(() => {
    const current = illustrationReferences(store, chatId);
    if (current.revision !== expectedRevision)
      throw new HttpError(409, 'Illustration references changed. Read them again before saving.');
    const previousRoles = new Map(current.references.map(({ ref, role }) => [ref, role]));
    const roles = new Map(previousRoles);
    const titles = new Map(
      illustrationReferenceCandidates(store, chatId).map((image) => [image.id, image.title])
    );
    const knownRefs = new Set([
      ...titles.keys(),
      ...roles.keys(),
      ...current.characterProfiles.flatMap((profile) => profile.referenceRef ?? []),
    ]);
    const profileIds = new Set(current.characterProfiles.map((profile) => profile.id));
    const assignedProfiles = new Map<string, string>();
    const replacedLinks = new Set<string>();
    const editedRefs = new Set<string>();
    const styleRequests = new Set<string>();
    for (const entry of assignments) {
      const item = record(entry);
      fields(item, ['ref', 'imageId', 'role', 'profileIds']);
      if ((item.ref === undefined) === (item.imageId === undefined))
        throw new HttpError(400, 'Supply a reference ref or a generated imageId.');
      if (item.role === undefined && item.profileIds === undefined)
        throw new HttpError(400, 'Supply a role or profileIds.');
      if (item.profileIds !== undefined && !Array.isArray(item.profileIds))
        throw new HttpError(400, 'Invalid profileIds.');
      let ref: string;
      if (item.imageId !== undefined) {
        if (item.role == null && !item.profileIds?.length)
          throw new HttpError(400, 'Choose a role or a character for the generated image.');
        const image = resolveIllustrationCutImage(
          store,
          chatId,
          text(item.imageId, 'image ID', 100)
        );
        const asset = store.product.reuseIllustrationAsset(chatId, image);
        ref = asset.id;
        titles.set(ref, asset.title);
      } else {
        ref = text(item.ref, 'reference', 300);
        if (!knownRefs.has(ref)) throw new HttpError(404, 'Unknown illustration reference');
      }
      if (editedRefs.has(ref)) throw new HttpError(400, 'Duplicate illustration reference');
      editedRefs.add(ref);
      if (item.role === null) roles.delete(ref);
      else if (item.role !== undefined) {
        const role = choice(item.role, ['character', 'style'] as const, 'reference role');
        roles.set(ref, role);
        if (role === 'style') styleRequests.add(ref);
      }
      if (item.profileIds !== undefined) {
        replacedLinks.add(ref);
        for (const value of item.profileIds) {
          const id = text(value, 'profile ID', 100);
          if (!profileIds.has(id)) throw new HttpError(404, 'Unknown illustration profile');
          if (assignedProfiles.has(id))
            throw new HttpError(400, 'Duplicate illustration profile ID');
          assignedProfiles.set(id, ref);
        }
      }
    }
    const changedRefs = new Set<string>();
    const characterProfiles = current.characterProfiles.map((profile) => {
      const { referenceRef, ...identity } = profile;
      const next =
        assignedProfiles.get(profile.id) ??
        (referenceRef && !replacedLinks.has(referenceRef) ? referenceRef : undefined);
      if (next && styleRequests.has(next))
        throw new HttpError(400, 'Unlink the characters from an image before using it for style.');
      if (next === referenceRef) return profile;
      if (next) changedRefs.add(next);
      if (referenceRef) changedRefs.add(referenceRef);
      return next ? { ...identity, referenceRef: next } : identity;
    });
    const results = [...editedRefs].map((ref) => ({
      ref,
      title: titles.get(ref) ?? ref,
      changed: changedRefs.has(ref) || previousRoles.get(ref) !== roles.get(ref),
    }));
    const changed = results.some((item) => item.changed);
    const revision = changed
      ? updateIllustrationReferences(store, chatId, {
          expectedRevision,
          references: [...roles].map(([ref, role]) => ({ ref, role })),
          characterProfiles,
        }).revision
      : current.revision;
    return { chatId, revision, changed, assignments: results };
  });
}
