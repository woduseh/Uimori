export type HelperConfirmationTrait = 'delete' | 'paid';

const deleteConfirmedNames = new Set([
  'resource.delete',
  'illustration.cut.delete',
  'font.delete',
  'palette.delete',
  'model.delete',
]);
const paidConfirmedNames = new Set([
  'scene.request',
  'scene.translate',
  'illustration.generate',
  'illustration.cut.redraw',
  'illustration.cut.revise',
  'task.retry',
]);

export function helperConfirmationTrait(
  name: string,
  args: Record<string, unknown>
): HelperConfirmationTrait | undefined {
  if (deleteConfirmedNames.has(name) || (name === 'chat.lore' && args.action === 'remove'))
    return 'delete';
  return paidConfirmedNames.has(name) ? 'paid' : undefined;
}
