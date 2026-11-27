import { createRoot } from 'react-dom/client';
import { StoryUi } from '../../web/StoryUi.js';

export async function mountReader(
  element: HTMLElement,
  source: import('../../core/types.js').Source,
  jobs: import('../../core/types.js').Job[] = []
) {
  const { SourceReader } = await import('../../web/SourceReader.js');
  createRoot(element).render(
    <SourceReader
      source={source}
      index={0}
      latest
      jobs={jobs}
      assets={[]}
      refresh={async () => {}}
      onError={() => {}}
      onFork={async () => {}}
    />
  );
}

export async function mountGallery(
  element: HTMLElement,
  sources: string[],
  style?: import('../../core/story-ui-style.js').StoryUiStyle
) {
  await import('../../web/style.css');
  const { parseStoryUi } = await import('../../core/story-ui.js');
  createRoot(element).render(
    <div style={{ maxWidth: 880, margin: '0 auto', padding: 16, fontSize: 18 }}>
      {sources.map((source, index) => {
        const segment = parseStoryUi(source)[0];
        if (segment.kind !== 'ui') throw new Error(`Gallery block ${index} did not compile`);
        return <StoryUi key={segment.expression} segment={segment} style={style} />;
      })}
    </div>
  );
}
