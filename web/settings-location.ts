/** Only navigation identifiers belong here; editor contents keep their existing owners. */
export function readSettingsLocation(key: string, available: readonly string[], fallback: string) {
  try {
    const saved = localStorage.getItem(key);
    return saved && available.includes(saved) ? saved : fallback;
  } catch {
    return fallback;
  }
}

export function rememberSettingsLocation(key: string, section: string) {
  try {
    localStorage.setItem(key, section);
  } catch {
    // Navigation remains usable when browser storage is unavailable.
  }
}
