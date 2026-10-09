import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Content } from '../../core/product.js';
import type { Source } from '../../core/types.js';
import { usePackagePresentation } from '../../web/PackagePresentation.js';
import { RisuMessageSurface } from '../../web/RisuMessageSurface.js';
import { RisuStartPreview } from '../../web/RisuStartPreview.js';

const source: Source = {
  id: 'source',
  chatId: 'chat',
  runId: 'run',
  parentRevision: null,
  hash: 'source-hash',
  text: 'Saved original',
};
const content = { id: 'bot', revision: 1 } as Content;

export function mount() {
  function Harness() {
    const [enabled, setEnabled] = useState(true);
    const [showPreview, setShowPreview] = useState(false);
    const [calls, setCalls] = useState(0);
    const [refresh, setRefresh] = useState(0);
    const presentation = usePackagePresentation(source, undefined, enabled, String(refresh));
    return (
      <>
        <button onClick={() => setEnabled((value) => !value)}>Toggle presentation</button>
        <button onClick={() => setShowPreview((value) => !value)}>Toggle preview</button>
        <button onClick={() => setRefresh((value) => value + 1)}>Refresh native revision</button>
        <output aria-label="Presentation status">
          {presentation?.pending ? 'pending' : 'ready'}
        </output>
        <output aria-label="Action calls">{calls}</output>
        <section aria-label="Presentation">
          {presentation?.data?.original.html ? (
            <RisuMessageSurface
              html={presentation.data.original.html}
              css={presentation.data.original.css}
              revisionKey={`${source.id}:${presentation.data.nativeAction?.expectedHeadRevision ?? ''}:${presentation.data.nativeAction?.expectedVariableRevision ?? ''}`}
              disabled={presentation.pending}
              onAction={async () => {
                setCalls((value) => value + 1);
              }}
            />
          ) : (
            source.text
          )}
        </section>
        {showPreview && (
          <section aria-label="Preview">
            <RisuStartPreview content={content} startId="start" />
          </section>
        )}
      </>
    );
  }
  createRoot(document.getElementById('mount')!).render(<Harness />);
}
