import { createRoot } from 'react-dom/client';
import { RisuMessageFrame } from '../../web/RisuMessageFrame.js';
import { retainReaderNavigation } from '../../web/reader-navigation-scroll.js';

export function mount() {
  let epoch = 0;
  let cancel = () => {};
  function navigate(kind: 'source' | 'end') {
    cancel();
    const active = ++epoch;
    const reader = document.getElementById('reader')!;
    cancel = retainReaderNavigation(
      reader,
      kind === 'end' ? { kind } : { kind, element: document.getElementById('target')! },
      () => epoch === active
    );
  }
  createRoot(document.getElementById('mount')!).render(
    <>
      <button onClick={() => navigate('source')}>Go to source</button>
      <button onClick={() => navigate('end')}>Go to end</button>
      <button onClick={() => epoch++}>Change navigation epoch</button>
      <div
        id="reader"
        style={{ height: 280, width: 320, overflow: 'auto', overflowAnchor: 'none' }}
      >
        <section>
          <div id="before" style={{ height: 160 }} data-source-id="previous">
            Previous source
          </div>
          <article id="target" data-source-id="target">
            <RisuMessageFrame
              html={
                '<p>Native beginning</p><p id="end" style="margin-top:700px">Native end</p><button id="native-focus-button">Native focus</button>'
              }
              onAction={async () => {}}
            />
            <div id="tail" />
          </article>
        </section>
      </div>
    </>
  );
}
