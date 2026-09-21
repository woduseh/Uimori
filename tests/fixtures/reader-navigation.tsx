import { useRef, useState } from 'react';
import type { ReaderDetail } from '../../core/types.js';
import { SceneNavigator } from '../../web/SceneNavigator.js';
import { createRoot } from 'react-dom/client';
import { RisuMessageSurface } from '../../web/RisuMessageSurface.js';
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
            <RisuMessageSurface
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

export function mountMiniNavigator() {
  createRoot(document.getElementById('mount')!).render(<MiniNavigatorFixture />);
}
function MiniNavigatorFixture() {
  const reader = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState('opening:id');
  const [listOpen, setListOpen] = useState(false);
  const [extra, setExtra] = useState(false);
  const entries = [
    { id: 'opening:id', number: 0, label: 'Opening', opening: true },
    { id: 'source:nonsequential:a', number: 1, label: 'Scene one' },
    { id: 'source:nonsequential:z', number: 2, label: 'Scene two' },
    ...(extra ? [{ id: 'source:new', number: 3, label: 'Arrived later' }] : []),
  ];
  const detail = {
    reader: { navigation: entries, order: entries.map((entry) => entry.id) },
  } as ReaderDetail;
  function choose(id: string) {
    setSelected(id);
    const node = reader.current?.querySelector<HTMLElement>(`[data-source-id="${id}"]`);
    if (reader.current && node) reader.current.scrollTop = node.offsetTop;
  }
  return (
    <>
      <button type="button" onClick={() => setExtra(true)}>
        Append scene
      </button>
      <output aria-label="Selected source">{selected}</output>
      <div
        className="reader-stage has-scenes"
        style={{ height: 440, width: 380, flex: 'none', display: 'flex', flexDirection: 'column' }}
      >
        <div
          className="reader-scrollport"
          ref={reader}
          style={{ position: 'relative', overflow: 'auto', flex: 1, minHeight: 0 }}
        >
          <section>
            {entries.map((entry) => (
              <article
                key={entry.id}
                data-testid="source"
                data-source-id={entry.id}
                style={{ height: 400 }}
              >
                {entry.label}
              </article>
            ))}
          </section>
        </div>
        <SceneNavigator
          detail={detail}
          reader={reader}
          target={selected}
          onSelect={choose}
          onLatest={() => {
            if (reader.current) reader.current.scrollTop = reader.current.scrollHeight;
          }}
          compact
          listOpen={listOpen}
          onListOpenChange={setListOpen}
        />
      </div>
    </>
  );
}
