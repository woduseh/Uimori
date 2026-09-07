export const VERTEX_FILE_PREFIX = 'NARRATIVE_PROVIDER_VERTEX_FILE_';
export const isVertexFileReference = (value: string) => value.startsWith(VERTEX_FILE_PREFIX);
export const validVertexFileReference = (value: string) => /^NARRATIVE_PROVIDER_VERTEX_FILE_[A-F0-9]{32}$/u.test(value);
