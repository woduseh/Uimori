import { IconButton } from './IconButton.js';
import { HelperIcon } from './ui-icons.js';
import { t, useI18n } from './i18n.js';
import { useEditorHelperAsk } from './resource-editor.js';
import { useStudioSectionId } from './EditorStudio.js';

export function EditorHelperItemAction({
  index,
  label,
  id,
  section,
  menu = false,
}: {
  index: number;
  label: string;
  id?: string;
  section?: string;
  menu?: boolean;
}) {
  useI18n();
  const ask = useEditorHelperAsk();
  const studio = useStudioSectionId(section);
  if (!ask || !studio) return null;
  const name = t('editorHelper.ask', { name: label });
  const run = () =>
    ask({
      section: studio,
      item: { index, label, ...(id ? { id } : {}) },
      withSelection: false,
    });
  if (menu)
    return (
      <button type="button" onClick={run}>
        <HelperIcon aria-hidden="true" />
        {name}
      </button>
    );
  return (
    <IconButton className="editor-helper-action" label={name} icon={HelperIcon} onClick={run} />
  );
}
