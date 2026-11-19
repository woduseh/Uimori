/** Locations offered for selection and comparison; other well-formed regions stay valid when saved. */
export const VERTEX_LOCATION_CHOICES = [
  'global',
  'us',
  'eu',
  'us-central1',
  'us-east4',
  'europe-west4',
  'asia-northeast1',
  'asia-northeast3',
] as const;

const PROJECT = /^(?:[a-z][a-z0-9-]{4,28}[a-z0-9]|[0-9]+)$/u;
const REGION = /^[a-z]+(?:-[a-z]+)+[0-9]{1,2}$/u;
const PATH = /^\/v1\/projects\/([^/]+)\/locations\/([^/]+)\/publishers\/google\/models\/?$/u;

export type VertexEndpoint = { projectId: string; location: string };

export function isVertexLocation(location: string): boolean {
  return (
    location === 'global' ||
    location === 'us' ||
    location === 'eu' ||
    (location.length <= 40 && REGION.test(location))
  );
}

/**
 * Google serves `global` from the shared host, the `us`/`eu` multi-regions from their
 * regional endpoint hosts and every other region from `<region>-aiplatform.googleapis.com`.
 */
function vertexHost(location: string): string {
  if (location === 'global') return 'aiplatform.googleapis.com';
  if (location === 'us' || location === 'eu') return `aiplatform.${location}.rep.googleapis.com`;
  return `${location}-aiplatform.googleapis.com`;
}

export function vertexModelsEndpoint(projectId: string, location: string): string {
  return `https://${vertexHost(location)}/v1/projects/${projectId}/locations/${location}/publishers/google/models`;
}

/** Only an endpoint whose host matches its location is a Vertex endpoint. */
export function parseVertexEndpoint(value: string): VertexEndpoint | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  if (url.search || url.hash) return null;
  const match = PATH.exec(url.pathname);
  if (!match) return null;
  const [, projectId, location] = match;
  if (!PROJECT.test(projectId) || !isVertexLocation(location)) return null;
  if (url.hostname !== vertexHost(location)) return null;
  return { projectId, location };
}

/** A credential admitted for one location of a project may serve another location of it. */
export function sameVertexProject(saved: string, candidate: string): boolean {
  const a = parseVertexEndpoint(saved),
    b = parseVertexEndpoint(candidate);
  return a !== null && b !== null && a.projectId === b.projectId;
}
