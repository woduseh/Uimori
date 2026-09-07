import { existsSync } from 'node:fs';
import type { Connection, ModelRef, ModelPreset } from '../core/product.js';
import type { ProductStore } from './product-store.js';
import { isVertexAdcReference, isVertexFileReference, validCredentialEnv } from '../core/credential-reference.js';
import type { VertexCredentialStore } from './vertex-credentials.js';
import type { CodexRuntimeStatus } from '../core/agent-runtime.js';

export type ProviderReadiness = {
  enabled: boolean; originApproved: boolean;
  credentialStatus: 'configured' | 'missing' | 'not-required' | 'adc-configured' | 'adc-unchecked';
  catalogKind: 'remote' | 'local-support' | 'agent-runtime';
};

/** Configuration presence only. This performs no authentication or provider request. */
export function readiness(_store: ProductStore, connection: Connection, approvedOrigins: readonly string[], credentials?:VertexCredentialStore, agent?:CodexRuntimeStatus): ProviderReadiness {
  if (connection.protocol === 'codex-app-server-v1') return { enabled: connection.enabled, originApproved: connection.endpoint === 'codex://local' && agent?.available === true, credentialStatus: agent?.authenticated ? 'configured' : 'missing', catalogKind: 'agent-runtime' };
  let originApproved = false;
  try { originApproved = approvedOrigins.includes(new URL(connection.endpoint).origin); } catch { /* Invalid roots are never ready. */ }
  let credentialStatus: ProviderReadiness['credentialStatus'];
  if (connection.protocol === 'vertex-gemini-v1' && isVertexAdcReference(connection.credentialEnv)) {
    const path = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    credentialStatus = path && existsSync(path) ? 'adc-configured' : 'adc-unchecked';
  } else if (connection.credentialEnv) {
    const reference = connection.credentialEnv;
    const configured = isVertexFileReference(reference) ? credentials?.configured(connection)===true : validCredentialEnv(reference) && Boolean(process.env[reference]) && !/[\r\n]/u.test(process.env[reference]!);
    credentialStatus = configured ? 'configured' : 'missing';
  } else credentialStatus = ['fixture-sse-v1','openai-chat-v1'].includes(connection.protocol) ? 'not-required' : 'missing';
  return {enabled:connection.enabled,originApproved,credentialStatus,catalogKind:connection.protocol === 'vertex-gemini-v1' ? 'local-support' : 'remote'};
}

type ReferencingProfile = {chatId: string; title: string; roles: string[]};
export type ManagementImpact = {
  kind: 'connection' | 'model'; id: string; profileCount: number; storyProfileCount: number;
  modelCount: number;
  profiles: ReferencingProfile[]; storyProfiles: ReferencingProfile[];
  effects: { editing: string; disabling: string };
};

/** Read only reference metadata; never load run snapshots, source text or model inputs. */
export function managementImpact(store: ProductStore, kind: 'connection' | 'model', id: string): ManagementImpact {
  store.get(kind,id);
  const matches = (ref: ModelRef | null | undefined) => {
    if (!ref) return false;
    if (kind === 'model') return ref.id === id;
    return store.get<ModelPreset>('model',ref.id).connectionId === id;
  };
  const profiles: ReferencingProfile[] = [];
  const profileRows = store.db.prepare("SELECT p.chat_id AS chatId,c.title,json_extract(p.body,'$.routes') AS routes FROM profiles p JOIN chats c ON c.id=p.chat_id ORDER BY p.chat_id").all() as {chatId:string;title:string;routes:string}[];
  for (const row of profileRows) {
    const routes = JSON.parse(row.routes) as Record<string,ModelRef|null>;
    const roles = Object.entries(routes).filter(([,ref]) => matches(ref)).map(([role]) => role);
    if (roles.length) profiles.push({chatId:row.chatId,title:row.title,roles});
  }
  const storyProfiles: ReferencingProfile[] = [];
  const storyRows = store.db.prepare("SELECT s.chat_id AS chatId,c.title,json_extract(s.body,'$.stateModel') AS stateModel,json_extract(s.body,'$.memory.model') AS memoryModel FROM story_configs s JOIN chats c ON c.id=s.chat_id WHERE s.revision=(SELECT MAX(n.revision) FROM story_configs n WHERE n.chat_id=s.chat_id) ORDER BY s.chat_id").all() as {chatId:string;title:string;stateModel:string|null;memoryModel:string|null}[];
  for (const row of storyRows) {
    const roles = (['state','memory'] as const).filter(role => matches(JSON.parse((role === 'state' ? row.stateModel : row.memoryModel) ?? 'null') as ModelRef|null));
    if (roles.length) storyProfiles.push({chatId:row.chatId,title:row.title,roles});
  }
  const count = (query: string, ...params: string[]) => Number((store.db.prepare(query).get(...params) as {count:number}).count);
  const modelCount = kind === 'model' ? 1 : count("SELECT COUNT(*) AS count FROM provider_settings WHERE kind='model' AND json_extract(body,'$.connectionId')=?",id);
  return {kind,id,profileCount:profiles.length,storyProfileCount:storyProfiles.length,modelCount,profiles,storyProfiles,
    effects:{editing:'저장한 변경은 다음 생성부터 적용돼요. 진행 중인 생성과 과거 결과는 당시 설정을 유지해요.',disabling:kind === 'connection' ? '연결 비활성화나 권한 변경은 다음 호출의 권한 검사에서 차단돼요.' : '모델 비활성화는 새 생성에서 차단돼요.'}};
}
