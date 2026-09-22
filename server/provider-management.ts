import { promptWorkspace } from './prompt-workspace.js';
import { workspaceModelRef, type ModelRef, type ModelPreset } from '../core/product.js';
import type { ProductStore } from './product-store.js';

type ReferencingProfile = { chatId: string; title: string; roles: string[] };
export type ManagementImpact = {
  kind: 'connection' | 'model';
  id: string;
  /** Current global role references; every chat uses these on its next request. */
  globalRoles: string[];
  profileCount: number;
  modelCount: number;
  profiles: ReferencingProfile[];
  effects: { editing: string; disabling: string };
};

/** Read only reference metadata; never load run snapshots, source text or model inputs. */
export function managementImpact(
  store: ProductStore,
  kind: 'connection' | 'model',
  id: string
): ManagementImpact {
  store.get(kind, id);
  const matches = (ref: ModelRef | null | undefined) => {
    if (!ref) return false;
    if (kind === 'model') return ref.id === id;
    return store.get<ModelPreset>('model', ref.id).connectionId === id;
  };
  const workspace = promptWorkspace(store.store);
  const globalRoles = Object.entries({
    ...workspace.modelRoutes,
    title: workspaceModelRef(workspace, 'title'),
    helper: workspaceModelRef(workspace, 'helper'),
    context: workspaceModelRef(workspace, 'context'),
    extension: workspace.scriptModel ?? null,
  })
    .filter(([, ref]) => matches(ref))
    .map(([role]) => role);
  for (const agent of workspace.main.program.collaboration?.agents ?? [])
    if (matches(agent.model)) globalRoles.push(`advisor:${agent.id}`);
  const chats = store.db
    .prepare(`SELECT c.id AS chatId,c.title,
    json_extract(p.body,'$.pinned.mainModel') AS mainModel,
    json_extract(p.body,'$.pinned.mainPromptPresetId') AS mainPromptPresetId
    FROM chats c LEFT JOIN profiles p ON p.chat_id=c.id ORDER BY c.id`)
    .all() as {
    chatId: string;
    title: string;
    mainModel: string | null;
    mainPromptPresetId: string | null;
  }[];
  const advisorRoles = new Map<string, string[]>();
  const profiles: ReferencingProfile[] = [];
  for (const chat of chats) {
    const roles = globalRoles.filter((role) =>
      role === 'main' ? !chat.mainModel : !role.startsWith('advisor:') || !chat.mainPromptPresetId
    );
    if (chat.mainModel && matches(JSON.parse(chat.mainModel) as ModelRef)) roles.push('main');
    if (chat.mainPromptPresetId) {
      let selected = advisorRoles.get(chat.mainPromptPresetId);
      if (!selected) {
        const row = store.db
          .prepare(
            "SELECT json_extract(body,'$.program.collaboration.agents') AS agents FROM versions WHERE kind='prompt-preset' AND id=? ORDER BY revision DESC LIMIT 1"
          )
          .get(chat.mainPromptPresetId) as { agents: string | null } | undefined;
        const agents = JSON.parse(row?.agents ?? '[]') as { id: string; model?: ModelRef | null }[];
        selected = agents
          .filter((agent) => matches(agent.model))
          .map((agent) => `advisor:${agent.id}`);
        advisorRoles.set(chat.mainPromptPresetId, selected);
      }
      roles.push(...selected);
    }
    if (roles.length) profiles.push({ chatId: chat.chatId, title: chat.title, roles });
  }
  const count = (query: string, ...params: string[]) =>
    Number((store.db.prepare(query).get(...params) as { count: number }).count);
  const modelCount =
    kind === 'model'
      ? 1
      : count(
          "SELECT COUNT(*) AS count FROM provider_settings WHERE kind='model' AND json_extract(body,'$.connectionId')=?",
          id
        );
  return {
    kind,
    id,
    globalRoles,
    profileCount: profiles.length,
    modelCount,
    profiles,
    effects: {
      editing:
        '저장한 변경은 다음 생성부터 적용돼요. 진행 중인 생성과 과거 결과는 당시 설정을 유지해요.',
      disabling:
        kind === 'connection'
          ? '연결 비활성화나 권한 변경은 다음 호출의 권한 검사에서 차단돼요.'
          : '모델 비활성화는 새 생성에서 차단돼요.',
    },
  };
}
