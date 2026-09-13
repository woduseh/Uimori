import type { ProfileSnapshot } from './product.js';

/** Preserve only historical execution permissions; new snapshots have no personaReference flag. */
export function historicalPersonaExcluded(
  profile: Pick<ProfileSnapshot, 'personaReference'> | undefined,
  role: string | undefined,
  target = 'main'
): boolean {
  return target === 'main' && role === 'persona' && profile?.personaReference === false;
}
