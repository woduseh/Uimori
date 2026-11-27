export function tryParseJson(text: string | null | undefined, fallback: unknown): unknown {
  if (text === null || text === undefined) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export function parseOwnJson(text: string): unknown {
  return JSON.parse(text);
}
