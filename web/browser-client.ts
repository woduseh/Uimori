/** Shared device identity, not authentication. Keep the existing key across upgrades. */
let fallback: string | undefined;
export function browserClientId(): string {
  try {
    const saved = localStorage.getItem('uimori:reading-client');
    if (saved && /^[a-f0-9-]{36}$/i.test(saved)) return saved;
    const id = crypto.randomUUID();
    localStorage.setItem('uimori:reading-client', id);
    return id;
  } catch {
    return (fallback ??= crypto.randomUUID());
  }
}
