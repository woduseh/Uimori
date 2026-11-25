import { useId, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ContentEditModel } from '../../core/resource-editing.js';
import { EditorStudio, useStudioSection } from '../../web/EditorStudio.js';
import { RisuNativeFields } from '../../web/RisuNativeFields.js';
import {
  ResourceEditorProvider,
  getActiveEditorContext,
  useResourceEditor,
} from '../../web/resource-editor.js';
import { ResourceEditorSession } from '../../web/resource-editor-session.js';
import {
  availableSections,
  contentSectionRegistry,
  contentSections,
} from '../../web/studio-sections.js';
import { t } from '../../web/i18n.js';
import { nativeContentDraft } from '../../web/native-content-draft.js';
import '../../web/style.css';

declare global {
  interface Window {
    studioLocation: () => unknown;
  }
}

export function mount() {
  const draft = nativeContentDraft('bot');
  const model: ContentEditModel = {
    kind: 'bot',
    title: 'Synthetic',
    description: '',
    text: '',
    loading: 'pinned',
    relatedIds: [],
    package: {
      ...draft,
      nativeRisu: {
        ...draft.nativeRisu,
        card: {
          ...draft.nativeRisu.card,
          name: 'Synthetic',
          first_mes: 'Hello',
          alternate_greetings: ['Second hello'],
          character_book: {
            entries: [
              { keys: ['forest'], content: 'A quiet forest', comment: 'Forest' },
              { keys: ['river'], content: 'A loud river', comment: 'River' },
            ],
          },
          extensions: {
            risuai: {
              customScripts: [
                { comment: 'Emphasis', type: 'editdisplay', in: 'a', out: 'b' },
                { comment: 'Quotes', type: 'editoutput', in: 'c', out: 'd' },
              ],
            },
          },
        },
      },
    },
  };
  window.studioLocation = () => getActiveEditorContext()?.location ?? null;
  function Harness() {
    const [session] = useState(
      () =>
        new ResourceEditorSession({
          editorKey: `fixture:studio-location:${crypto.randomUUID()}`,
          kind: 'content',
          targetId: null,
          initialModel: model,
        })
    );
    const shared = useResourceEditor<ContentEditModel>(session);
    const { model: value, setModel } = shared;
    const idPrefix = useId();
    const [section, select] = useStudioSection(
      'fixture:studio-location',
      availableSections(contentSectionRegistry, value.package),
      'basic',
      false
    );
    if (!shared.state.ready) return null;
    return (
      <ResourceEditorProvider value={shared}>
        <EditorStudio
          header={<span>Studio</span>}
          label={t('native.text_b891876a9a')}
          sections={contentSections(value.package, value.kind, section, [])}
          value={section}
          onSelect={select}
          idPrefix={idPrefix}
        >
          <RisuNativeFields
            value={value.package}
            onChange={(pkg) => setModel((current) => ({ ...current, package: pkg }))}
            onPortraitBusy={() => {}}
            section={section}
            onSelect={select}
            idPrefix={idPrefix}
          />
        </EditorStudio>
      </ResourceEditorProvider>
    );
  }
  createRoot(document.getElementById('mount')!).render(
    <div style={{ display: 'flex', flexDirection: 'column', height: '100dvh' }}>
      <Harness />
    </div>
  );
}
