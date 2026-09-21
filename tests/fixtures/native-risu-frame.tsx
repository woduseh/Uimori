import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { RisuMessageSurface } from '../../web/RisuMessageSurface.js';

export function mount(authoredHtml?: string) {
  function Harness() {
    const [revision, setRevision] = useState(0);
    const [calls, setCalls] = useState(0);
    return (
      <>
        <output>{calls}</output>
        <button onClick={() => setRevision((value) => value + 1)}>Render new revision</button>
        <RisuMessageSurface
          revisionKey={String(revision)}
          html={
            authoredHtml ??
            '<p style="margin:40px 0">First</p><button risu-trigger="one">One</button><button risu-trigger="two">Two</button><p id="last" style="margin:30px 0">Last line</p>'
          }
          onAction={async () => {
            setCalls((value) => value + 1);
          }}
        />
      </>
    );
  }
  createRoot(document.getElementById('mount')!).render(<Harness />);
}
