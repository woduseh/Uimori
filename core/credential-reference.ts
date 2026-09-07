export const CREDENTIAL_ENV_PATTERN = '^[A-Za-z_][A-Za-z0-9_]*$';
export const validCredentialEnv = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 200 && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(value);
export const VERTEX_ADC_ENV = 'GOOGLE_APPLICATION_CREDENTIALS';
export const isVertexAdcReference = (value: string | undefined) =>
  value === undefined || value === VERTEX_ADC_ENV;
export const VERTEX_FILE_PREFIX = 'NARRATIVE_PROVIDER_VERTEX_FILE_';
export const isVertexFileReference = (value: string) => value.startsWith(VERTEX_FILE_PREFIX);
export const validVertexFileReference = (value: string) =>
  /^NARRATIVE_PROVIDER_VERTEX_FILE_[A-F0-9]{32}$/u.test(value);
