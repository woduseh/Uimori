import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { RisuContent } from '../../core/risu-content.js';
import { RisuNativeFields } from '../../web/RisuNativeFields.js';
import { EditorStudio } from '../../web/EditorStudio.js';
import { t } from '../../web/i18n.js';
import { contentSections, type ContentSection } from '../../web/resource-sections.js';

export function mount() {
  function Harness() {
    const [value, setValue] = useState<RisuContent>({
      version: 2,
      id: 'native-editor-fixture',
      revision: 1,
      title: 'Synthetic',
      description: '',
      lore: [],
      nativeRisu: {
        version: 1,
        sourceHash: '0'.repeat(64),
        assets: [],
        card: {
          name: 'Synthetic',
          character_book: {
            entries: [{ id: 1, name: 'Place', keys: ['forest'], content: 'A quiet forest' }],
          },
        },
      },
    });
    const [pending, setPending] = useState(false);
    const [busy, setBusy] = useState(false);
    const [section, setSection] = useState<ContentSection>('basic');
    return (
      <EditorStudio
        header={
          <button type="button" disabled={pending || busy}>
            Save
          </button>
        }
        label={t('native.text_b891876a9a')}
        sections={contentSections(value)}
        value={section}
        onSelect={setSection}
        idPrefix="fixture"
      >
        <RisuNativeFields
          value={value}
          onChange={setValue}
          onDraftChange={setPending}
          onPortraitBusy={setBusy}
          section={section}
          onSelect={setSection}
          idPrefix="fixture"
        />
        <output>{JSON.stringify(value)}</output>
      </EditorStudio>
    );
  }
  createRoot(document.getElementById('mount')!).render(
    <div style={{ display: 'flex', flexDirection: 'column', height: '100dvh' }}>
      <Harness />
    </div>
  );
}
