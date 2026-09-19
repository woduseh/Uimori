import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { NativeRisuPresetEditor } from '../../web/NativeRisuPresetEditor.js';
import {
  createNativeRisuPresetProgram,
  nativeRisuPresetSource,
} from '../../core/risu-native-preset.js';
import type { PromptValue } from '../../core/risu-prompt.js';

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
      <>
        <NativeRisuPresetEditor
          program={program}
          onChange={setProgram}
          values={values}
          onValuesChange={setValues}
          onPendingDraftChange={setPending}
        />
        <button type="button" disabled={pending}>
          Save
        </button>
        <output>{JSON.stringify({ program, values })}</output>
      </>
    );
  }
  createRoot(document.getElementById('mount')!).render(<Harness />);
}
