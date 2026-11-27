import { useEffect, useState } from 'react';
import type { Connection, LibraryConnection } from '../core/product.js';
import { api } from './api.js';
import { toUiMessage } from './api-errors.js';
import type { UiMessage } from './ui-message.js';

type Catalog = Connection['catalog'];

export const connectionCatalogPath = (connectionId: string) =>
  `/connections/${encodeURIComponent(connectionId)}/catalog`;

export type ConnectionCatalogState = {
  loading: boolean;
  error: UiMessage | null;
  retry: () => void;
};

export function useConnectionCatalog(
  connection: LibraryConnection | undefined,
  active: boolean
): ConnectionCatalogState & { connection: Connection | undefined } {
  const listed = connection?.catalog;
  const id = connection?.id ?? '';
  const [attempt, setAttempt] = useState(0);
  const requestKey = connection
    ? `${connection.id}:${connection.revision}:${connection.catalogUpdatedAt ?? ''}:${attempt}`
    : '';
  const needed = active && !!connection && !listed;
  const [loaded, setLoaded] = useState<{ id: string; key: string; catalog: Catalog } | null>(null);
  const [failure, setFailure] = useState<{ key: string; error: UiMessage } | null>(null);
  useEffect(() => {
    if (!needed) return;
    let current = true;
    api<{ catalog: Catalog }>(connectionCatalogPath(id)).then(
      (value) => {
        if (current) setLoaded({ id, key: requestKey, catalog: value.catalog });
      },
      (caught: unknown) => {
        if (current) setFailure({ key: requestKey, error: toUiMessage(caught) });
      }
    );
    return () => {
      current = false;
    };
  }, [needed, id, requestKey]);
  const retry = () => setAttempt((value) => value + 1);
  if (!connection) return { connection: undefined, loading: false, error: null, retry };
  if (listed)
    return { connection: { ...connection, catalog: listed }, loading: false, error: null, retry };
  const error = failure?.key === requestKey ? failure.error : null;
  return {
    connection: { ...connection, catalog: loaded?.id === id ? loaded.catalog : [] },
    loading: needed && !error && loaded?.key !== requestKey,
    error,
    retry,
  };
}
