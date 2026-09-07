import type { Connection, ContentRef, ModelPreset } from './product.js';
import type { Json, ProviderUsage, WireRecord } from './transport.js';

export type RegistrationConnectionDraft = Pick<Connection,'title'|'protocol'|'endpoint'|'credentialEnv'|'requestTier'|'enabled'>;
export type RegistrationModelDraft = Omit<ModelPreset,'id'|'revision'|'connectionId'|'connectionRevision'|'source'|'userOverrides'>;
export type RegistrationPlan = {
  connection: {kind:'existing';id:string;revision:number} | {kind:'new';draft:RegistrationConnectionDraft};
  model: RegistrationModelDraft;
};
export type RegistrationAttempt = {
  id:string; request:WireRecord; status:string; usage:ProviderUsage|null; error:string|null;
};
export type RegistrationRun = ContentRef & {
  intentHash:string; createdAt:string; finishedAt:string|null;
  status:'running'|'ready'|'failed'|'cancelled'|'interrupted'|'applied';
  request:string; target:ContentRef; connection:ContentRef;
  attempts:RegistrationAttempt[]; plan:RegistrationPlan|null; planHash:string|null; error:string|null;
  applied:{connection:ContentRef;model:ContentRef}|null;
};
export type RegistrationView = Omit<RegistrationRun,'intentHash'|'attempts'> & {
  modelCalls:number; usage:ProviderUsage|null;
};
export const REGISTRATION_LIMITS = {maxCalls:1, timeoutMs:60_000, requestCharacters:6000} as const;
export const registrationJson = (value:unknown):Json => JSON.parse(JSON.stringify(value)) as Json;
