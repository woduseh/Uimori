import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { RisuContent } from '../../core/risu-content.js';
import { RisuNativeFields } from '../../web/RisuNativeFields.js';

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
    return (
      <>
        <RisuNativeFields
          value={value}
          onChange={setValue}
          onDraftChange={setPending}
          onPortraitBusy={setBusy}
        />
        <button type="button" disabled={pending || busy}>
          Save
        </button>
        <output>{JSON.stringify(value)}</output>
      </>
    );
  }
  createRoot(document.getElementById('mount')!).render(<Harness />);
}
