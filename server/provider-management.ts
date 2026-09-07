import { existsSync } from 'node:fs';
import type { Connection, ContentRef, ModelPreset } from '../core/product.js';
import type { ProductStore } from './product-store.js';
import { isVertexFileReference } from '../core/credential-reference.js';
import type { VertexCredentialStore } from './vertex-credentials.js';

export type ProviderReadiness = {
  enabled: boolean; originApproved: boolean;
  credentialStatus: 'configured' | 'missing' | 'not-required' | 'adc-configured' | 'adc-unchecked';
  catalogKind: 'remote' | 'local-support';
};

/** Configuration presence only. This performs no authentication or provider request. */
export function readiness(_store: ProductStore, connection: Connection, approvedOrigins: readonly string[], credentials?:VertexCredentialStore): ProviderReadiness {
  let originApproved = false;
  try { originApproved = approvedOrigins.includes(new URL(connection.endpoint).origin); } catch { /* Invalid roots are never ready. */ }
  let credentialStatus: ProviderReadiness['credentialStatus'];
  if (connection.credentialEnv) {
    const reference = connection.credentialEnv;
    const configured = isVertexFileReference(reference) ? credentials?.configured(connection)===true : /^NARRATIVE_PROVIDER_[A-Z0-9_]+$/.test(reference) && Boolean(process.env[reference]) && !/[\r\n]/u.test(process.env[reference]!);
    credentialStatus = configured ? 'configured' : 'missing';
  } else if (connection.protocol === 'vertex-gemini-v1') {
    const path = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    credentialStatus = path && existsSync(path) ? 'adc-configured' : 'adc-unchecked';
  } else credentialStatus = ['fixture-sse-v1','openai-chat-v1'].includes(connection.protocol) ? 'not-required' : 'missing';
  return {enabled:connection.enabled,originApproved,credentialStatus,catalogKind:connection.protocol === 'vertex-gemini-v1' ? 'local-support' : 'remote'};
}

type ReferencingProfile = {chatId: string; title: string; roles: string[]};
export type ManagementImpact = {
  kind: 'connection' | 'model'; id: string; profileCount: number; storyProfileCount: number;
  modelRevisionCount: number; archivedRevisionCount: number;
  profiles: ReferencingProfile[]; storyProfiles: ReferencingProfile[];
  effects: { pinnedRevisions: string; disabling: string };
};

/** Read only reference metadata; never load run snapshots, source text or model inputs. */
export function managementImpact(store: ProductStore, kind: 'connection' | 'model', id: string): ManagementImpact {
  store.get(kind,id);
  const matches = (ref: ContentRef | null | undefined) => {
    if (!ref) return false;
    if (kind === 'model') return ref.id === id;
    return store.get<ModelPreset>('model',ref.id,ref.revision).connectionId === id;
  };
  const profiles: ReferencingProfile[] = [];
  const profileRows = store.db.prepare("SELECT p.chat_id AS chatId,c.title,json_extract(p.body,'$.routes') AS routes FROM profiles p JOIN chats c ON c.id=p.chat_id ORDER BY p.chat_id").all() as {chatId:string;title:string;routes:string}[];
  for (const row of profileRows) {
    const routes = JSON.parse(row.routes) as Record<string,ContentRef|null>;
    const roles = Object.entries(routes).filter(([,ref]) => matches(ref)).map(([role]) => role);
    if (roles.length) profiles.push({chatId:row.chatId,title:row.title,roles});
  }
  const storyProfiles: ReferencingProfile[] = [];
  const storyRows = store.db.prepare("SELECT s.chat_id AS chatId,c.title,json_extract(s.body,'$.stateModel') AS stateModel,json_extract(s.body,'$.memory.model') AS memoryModel FROM story_configs s JOIN chats c ON c.id=s.chat_id WHERE s.revision=(SELECT MAX(n.revision) FROM story_configs n WHERE n.chat_id=s.chat_id) ORDER BY s.chat_id").all() as {chatId:string;title:string;stateModel:string|null;memoryModel:string|null}[];
  for (const row of storyRows) {
    const roles = (['state','memory'] as const).filter(role => matches(JSON.parse((role === 'state' ? row.stateModel : row.memoryModel) ?? 'null') as ContentRef|null));
    if (roles.length) storyProfiles.push({chatId:row.chatId,title:row.title,roles});
  }
  const count = (query: string, ...params: string[]) => Number((store.db.prepare(query).get(...params) as {count:number}).count);
  const modelRevisionCount = kind === 'model' ? count("SELECT COUNT(*) AS count FROM versions WHERE kind='model' AND id=?",id)
    : count("SELECT COUNT(*) AS count FROM versions WHERE kind='model' AND json_extract(body,'$.connectionId')=?",id);
  const archivedRevisionCount = count('SELECT COUNT(*) AS count FROM versions WHERE kind=? AND id=? AND revision < (SELECT MAX(revision) FROM versions WHERE kind=? AND id=?)',kind,id,kind,id);
  return {kind,id,profileCount:profiles.length,storyProfileCount:storyProfiles.length,modelRevisionCount,archivedRevisionCount,profiles,storyProfiles,
    effects:{pinnedRevisions:'기존에 지정된 모델·연결 revision과 과거 Run은 변경하지 않아요.',disabling:kind === 'connection' ? '연결 비활성화나 권한 변경은 과거 revision을 사용하는 경우에도 다음 호출의 권한 검사에서 차단돼요.' : '모델 비활성화는 신규 선택·배정에서 제외하며 기존에 지정된 모델 실행을 취소하지 않아요.'}};
}
