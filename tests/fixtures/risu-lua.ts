/**
 * The public action-id rule of the Risu Lua import: `<idPrefix>-<triggerIndex>-<event>`, with
 * `risu-lua` as the default prefix (server/risu-lua-adapter.ts). Only the naming rule lives here,
 * so a change to it is one edit instead of one per expectation.
 */
export function luaActionIds(
  events: readonly string[],
  triggerIndex = 0,
  idPrefix = 'risu-lua'
): string[] {
  return events.map((event) => `${idPrefix}-${triggerIndex}-${event}`);
}
