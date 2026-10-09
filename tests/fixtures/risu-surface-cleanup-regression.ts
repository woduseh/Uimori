import { selectedReaderText } from '../../web/reader-dom.js';
import { prepareRisuMessage } from '../../web/risu-message.js';
import { mountRisuMessageSurface } from '../../web/risu-message-surface.js';

/** Real composed selections must remain scoped to the owning reader. */
export function runSurfaceCleanupRegressions(mount: HTMLElement): string[] {
  const article = document.createElement('section');
  const host = document.createElement('div');
  article.append(host);
  mount.append(article);
  const surface = mountRisuMessageSurface(host, prepareRisuMessage('<p>선택할 본문</p>'), () => {});
  const check = (value: unknown, message: string) => {
    if (!value) throw new Error(message);
  };
  const selection = window.getSelection()!;
  try {
    const text = surface.root.querySelector('p')!.firstChild!;
    selection.setBaseAndExtent(text, 0, text, 3);
    check(selectedReaderText(article) === '선택할', 'forward shadow selection failed');
    selection.setBaseAndExtent(text, 3, text, 0);
    check(selectedReaderText(article) === '선택할', 'backward shadow selection failed');
    const outside = document.createElement('p');
    outside.textContent = 'Outside';
    mount.append(outside);
    check(selectedReaderText(outside) === '', 'another reader accepted the selection');
    selection.setBaseAndExtent(outside.firstChild!, 0, outside.firstChild!, 7);
    check(selectedReaderText(article) === '', 'outside selection leaked');
    check(selectedReaderText(mount) === 'Outside', 'ordinary DOM selection failed');
    selection.removeAllRanges();
    check(
      selectedReaderText(article) === '' && selectedReaderText(null) === '',
      'empty selection was not empty'
    );
    return ['Modern composed selection keeps only the owning reader text'];
  } finally {
    selection.removeAllRanges();
    surface.destroy();
    mount.replaceChildren();
  }
}
