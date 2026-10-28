import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { HelperMessageProse } from '../../web/HelperMessageProse.js';
import { Prose } from '../../web/Prose.js';
import '../../web/style.css';
import '../../web/helper.css';

export function mountHelperProse(mount: HTMLElement, text: string) {
  const root = createRoot(mount);
  const render = (value: string) =>
    flushSync(() =>
      root.render(
        <>
          <section data-testid="helper">
            <HelperMessageProse text={value} />
          </section>
          <section data-testid="manuscript">
            <Prose text={value} />
          </section>
        </>
      )
    );
  render(text);
  return { render, unmount: () => root.unmount() };
}
