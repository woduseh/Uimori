import { useEffect, useState } from 'react';
import type { Connection, ContentRef, ModelPreset } from '../core/product.js';
import { api } from './api.js';

const key = (value: ContentRef) => `${value.id}@${value.revision}`;
export function isModelSelectable(model: ModelPreset, latestModels: readonly ModelPreset[], currentConnections: readonly Connection[], pinnedConnections: readonly Connection[] = []): boolean {
  const latest = latestModels.find(item => item.id === model.id);
  const current = currentConnections.find(item => item.id === model.connectionId);
  const pinned = [...currentConnections,...pinnedConnections].find(item => item.id === model.connectionId && item.revision === model.connectionRevision);
  return Boolean(latest && latest.enabled !== false && current?.enabled && pinned?.enabled && ['protocol','endpoint','credentialEnv','requestTier'].every(field => current[field as keyof Connection] === pinned[field as keyof Connection]));
}

/** Deduplicate immutable connection revisions; a failed read disables only affected new choices. */
export function useModelSelection(models: readonly ModelPreset[], connections: readonly Connection[], additionalModels: readonly ModelPreset[] = []) {
  const [resolved, setResolved] = useState<{scope:string;connections:Connection[]}>({scope:'',connections:[]});
  const missing = [...new Map([...models,...additionalModels].filter(model => !connections.some(connection => connection.id === model.connectionId && connection.revision === model.connectionRevision)).map(model => {const ref={id:model.connectionId,revision:model.connectionRevision};return [key(ref),ref];})).values()];
  const scope = JSON.stringify(missing);
  useEffect(() => {
    let alive = true;
    const refs = JSON.parse(scope) as ContentRef[];
    void Promise.allSettled(refs.map(ref => api<Connection>(`/revisions/connection/${encodeURIComponent(ref.id)}/${ref.revision}`))).then(results => {
      if (alive) setResolved({scope,connections:results.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])});
    });
    return () => {alive=false;};
  },[scope]);
  const resolving=missing.length>0&&resolved.scope!==scope;
  const pinned=resolved.scope===scope?resolved.connections:[];
  const canSelect = (model:ModelPreset) => isModelSelectable(model,models,connections,pinned);
  return {canSelect,choices:models.filter(canSelect),resolving};
}
