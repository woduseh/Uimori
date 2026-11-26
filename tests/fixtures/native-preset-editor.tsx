import { useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { NativeRisuPresetEditor } from '../../web/NativeRisuPresetEditor.js';
import {
  createNativeRisuPresetProgram,
  nativeRisuPresetSource,
} from '../../core/risu-native-preset.js';
import type { PromptValue, RisuPrompt } from '../../core/risu-prompt.js';
import { EditorStudio } from '../../web/EditorStudio.js';
import { presetSections, type PresetSection } from '../../web/studio-sections.js';
import { t } from '../../web/i18n.js';

function Studio({
  program,
  header,
  children,
}: {
  program: RisuPrompt;
  header?: ReactNode;
  children: (onSelect: (section: PresetSection) => void) => ReactNode;
}) {
  const [section, setSection] = useState<PresetSection>('blocks');
  return (
    <EditorStudio
      header={header}
      label={t('native.text_a8a8b42c1a')}
      sections={presetSections(program, false)}
      value={section}
      onSelect={setSection}
      idPrefix="fixture"
    >
      {children(setSection)}
    </EditorStudio>
  );
}

export function mount() {
  function Harness() {
    const [program, setProgram] = useState(() =>
      createNativeRisuPresetProgram(
        nativeRisuPresetSource({
          name: 'Synthetic',
          customPromptTemplateToggle: 'mood=Mood=select=Calm,Vivid',
          promptTemplate: [{ type: 'plain', text: '{{getvar::place}}', role: 'system' }],
          aiModel: 'must-not-import',
          apiKey: 'must-not-import',
        })
      )
    );
    const [values, setValues] = useState<Record<string, PromptValue>>({});
    const [pending, setPending] = useState(false);
    return (
      <Studio
        program={program}
        header={
          <button type="button" disabled={pending}>
            Save
          </button>
        }
      >
        {(onSelect) => (
          <>
            <NativeRisuPresetEditor
              program={program}
              onChange={setProgram}
              values={values}
              onValuesChange={setValues}
              onPendingDraftChange={setPending}
              onSelect={onSelect}
              idPrefix="fixture"
            />
            <output>{JSON.stringify({ program, values })}</output>
          </>
        )}
      </Studio>
    );
  }
  createRoot(document.getElementById('mount')!).render(
    <div style={{ display: 'flex', flexDirection: 'column', height: '100dvh' }}>
      <Harness />
    </div>
  );
}
