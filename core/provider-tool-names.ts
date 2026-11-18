import type { ProviderTool } from './transport.js';

/**
 * Replace unsupported characters in canonical names. Noncolliding aliases are independent
 * of tool order. When aliases collide, later occurrences gain numeric suffixes.
 */
export function providerToolNames(names: readonly string[]): string[] {
  const used = new Set<string>();
  return names.map((name) => {
    const base = name.replace(/[^A-Za-z0-9_-]/gu, '_').slice(0, 56);
    let alias = base;
    for (let suffix = 2; used.has(alias); suffix++) alias = `${base}_${suffix}`;
    used.add(alias);
    return alias;
  });
}

/** Guidance and results cite canonical names, so an alias that differs states its mapping. */
export const providerToolDescription = (tool: ProviderTool, wireName: string): string =>
  wireName === tool.name ? tool.description : `Host tool: ${tool.name}. ${tool.description}`;
