import { storageKeys } from './storage-keys.js';

let fallback: string | undefined;
export function browserClientId(): string {
  try {
    const saved = localStorage.getItem(storageKeys.readingClient);
    if (saved && /^[a-f0-9-]{36}$/i.test(saved)) return saved;
    const id = crypto.randomUUID();
    localStorage.setItem(storageKeys.readingClient, id);
    return id;
  } catch {
    return (fallback ??= crypto.randomUUID());
  }
}
