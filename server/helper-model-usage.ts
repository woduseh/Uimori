import { illustrationSettings } from './illustrations.js';
import { managementImpact } from './provider-management.js';
import type { Store } from './store.js';

const globalRoleSettings: Record<string, string> = {
  main: 'global.mainModel',
  translation: 'global.translationModel',
  title: 'global.titleModel',
  helper: 'global.helperModel',
  context: 'global.contextModel',
  extension: 'global.scriptModel',
};

export function modelInUse(store: Store, modelId: string): string | null {
  if (!store.product.isLive('model', modelId)) return null;
  const impact = managementImpact(store.product, 'model', modelId);
  const settings = illustrationSettings(store);
  const illustration = [
    settings.codex.model,
    settings.codex.promptModel,
    settings.comfyui.promptModel,
    settings.novelai.promptModel,
  ].some((ref) => ref?.id === modelId);
  const roles = impact.globalRoles.map((role) =>
    role.startsWith('advisor:')
      ? `the ${role.slice('advisor:'.length)} advisor of the default writing prompt`
      : (globalRoleSettings[role] ?? role)
  );
  const parts = [
    ...(roles.length
      ? [`it is chosen for ${roles.join(', ')}; change that with settings.update`]
      : []),
    ...(!roles.length && impact.profileCount
      ? [
          `chats use it as their pinned model or advisor: ${impact.profiles
            .slice(0, 5)
            .map((profile) => `${profile.title} (${profile.chatId})`)
            .join(', ')}${impact.profileCount > 5 ? ` and ${impact.profileCount - 5} more` : ''}`,
        ]
      : []),
    ...(illustration ? ['the illustration settings use it; change that in the app settings'] : []),
  ];
  return parts.length ? `${parts.join('. ')}.` : null;
}
