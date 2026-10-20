import { t, useI18n } from './i18n.js';
import { ContextPanel } from './ContextPanel.js';
import { Dialog } from './Dialog.js';
import { LastSceneLore } from './LastSceneLore.js';

const ignoreDirty = () => {};

export function ChatContextDialog({
  mode,
  chatId,
  headRevision,
  refreshKey,
  onClose,
  onRefresh,
  onError,
}: {
  mode: 'lore' | 'compact' | null;
  chatId: string;
  headRevision: string | null;
  refreshKey: unknown;
  onClose: () => void;
  onRefresh: () => Promise<void>;
  onError: (message: string) => void;
}) {
  useI18n();
  return (
    <>
      <Dialog open={mode === 'lore'} title={t('settings.m104')} onClose={onClose}>
        <LastSceneLore chatId={chatId} headRevision={headRevision} />
      </Dialog>
      <Dialog open={mode === 'compact'} title={t('settings.m105')} onClose={onClose}>
        <ContextPanel
          mode="compact"
          chatId={chatId}
          headRevision={headRevision}
          active={mode === 'compact'}
          refreshKey={refreshKey}
          onRefreshStory={onRefresh}
          onChanged={() => void onRefresh()}
          onError={onError}
          onDirtyChange={ignoreDirty}
        />
      </Dialog>
    </>
  );
}
