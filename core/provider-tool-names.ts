import type { ProviderTool } from './transport.js';

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

export const providerToolDescription = (tool: ProviderTool, wireName: string): string =>
  wireName === tool.name ? tool.description : `Host tool: ${tool.name}. ${tool.description}`;
