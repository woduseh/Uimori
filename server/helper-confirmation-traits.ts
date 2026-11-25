export type HelperConfirmationTrait = 'delete' | 'paid';

const deleteConfirmedNames = new Set([
  'resource.delete',
  'illustration.cut.delete',
  'font.delete',
  'palette.delete',
  'model.delete',
  'chat.delete',
  'prompt.combination.delete',
]);
const paidConfirmedNames = new Set([
  'scene.request',
  'scene.translate',
  'illustration.generate',
  'illustration.cut.redraw',
  'illustration.cut.revise',
  'task.retry',
]);

export function helperConfirmationTrait(name: string): HelperConfirmationTrait | undefined {
  if (deleteConfirmedNames.has(name)) return 'delete';
  return paidConfirmedNames.has(name) ? 'paid' : undefined;
}
