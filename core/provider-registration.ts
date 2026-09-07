import type { Connection, ContentRef, ModelPreset, ModelSnapshot } from './product.js';
import type { Json, ProviderUsage, WireRecord } from './transport.js';

export type RegistrationConnectionDraft = Pick<Connection,'title'|'protocol'|'endpoint'|'credentialEnv'|'enabled'>;
export type RegistrationModelDraft = Omit<ModelPreset,'id'|'revision'|'connectionId'|'source'|'userOverrides'|'capabilityRevision'>;
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
  targetSnapshot:ModelSnapshot;
  attempts:RegistrationAttempt[]; plan:RegistrationPlan|null; planHash:string|null; error:string|null;
  planConnectionSnapshot:Connection|null;
  applied:{connection:ContentRef;model:ContentRef}|null;
  appliedSnapshot:{connection:Connection;model:ModelPreset}|null;
};
export type RegistrationView = Omit<RegistrationRun,'intentHash'|'attempts'|'targetSnapshot'|'planConnectionSnapshot'|'appliedSnapshot'> & {
  modelCalls:number; usage:ProviderUsage|null;
};
export const REGISTRATION_LIMITS = {maxCalls:1, timeoutMs:60_000, requestCharacters:6000} as const;
export const registrationJson = (value:unknown):Json => JSON.parse(JSON.stringify(value)) as Json;
