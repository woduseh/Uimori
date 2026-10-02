import { retainReaderNavigation } from '../../web/reader-navigation-scroll.js';
import { captureReaderLocation } from '../../web/useReadingSync.js';

let cancel = () => {};

export function mount(nested = true) {
  cancel();
  const mount = document.getElementById('mount')!;
  mount.innerHTML = `
    <style>
      body { margin: 0; }
      #reader { width: 360px; height: 320px; overflow: auto; overflow-anchor: none; }
      article { margin: 0 0 40px; }
      [slot="body"] { display: block; }
      [data-block-anchor] { box-sizing: border-box; height: 80px; margin: 0; padding: 12px; }
    </style>
    <div id="reader"><section></section></div>
  `;
  const section = document.querySelector('#reader > section')!;
  for (const sourceId of ['previous', 'target', 'last']) {
    const article = document.createElement('article');
    article.id = sourceId;
    article.dataset.sourceId = sourceId;
    article.dataset.representation = 'original';
    article.dataset.contentHash = `hash-${sourceId}`;
    const host = document.createElement('div');
    host.className = 'theme-frame';
    host.attachShadow({ mode: 'open' }).innerHTML = `
      <style>:host { display: block; } header { height: 120px; } footer { height: 40px; }</style>
      <header>Scene ${sourceId}</header>
      <slot name="body"${nested ? ' data-uimori-body-scroll' : ''}></slot>
      <footer><slot name="actions"></slot></footer>
    `;
    const body = document.createElement('div');
    body.id = `${sourceId}-body`;
    body.slot = 'body';
    if (nested) {
      body.dataset.uimoriBodyScroll = '';
      Object.assign(body.style, {
        maxHeight: '240px',
        overflow: 'auto',
        overflowAnchor: 'none',
      });
    }
    for (let index = 0; index < 12; index++) {
      const paragraph = document.createElement('p');
      paragraph.id = `${sourceId}-block-${index}`;
      paragraph.dataset.blockAnchor = paragraph.id;
      paragraph.textContent = `Scene ${sourceId}, paragraph ${index}`;
      body.append(paragraph);
    }
    const action = document.createElement('button');
    action.id = `${sourceId}-action`;
    action.slot = 'actions';
    action.textContent = 'Edit scene';
    host.append(body, action);
    article.append(host);
    section.append(article);
  }
}

export function navigateSource(anchor?: string, ratio = 0) {
  cancel();
  cancel = retainReaderNavigation(
    document.getElementById('reader')!,
    { kind: 'source', element: document.getElementById('target')!, anchor, ratio },
    () => true
  );
}

export function navigateEnd() {
  cancel();
  cancel = retainReaderNavigation(document.getElementById('reader')!, { kind: 'end' }, () => true);
}

export function capture(sourceId?: string) {
  return captureReaderLocation(
    document.getElementById('reader')!,
    'fixture-chat',
    sourceId ? document.getElementById(sourceId)! : undefined
  );
}

export function restoreAnchor(anchor: string, outerTop: number, offset: number) {
  cancel();
  cancel = retainReaderNavigation(
    document.getElementById('reader')!,
    {
      kind: 'source',
      element: document.getElementById('target')!,
      anchor,
      outerTop,
      offset,
    },
    () => true
  );
}

export function restoreAction(bodyTop: number, offset: number) {
  cancel();
  cancel = retainReaderNavigation(
    document.getElementById('reader')!,
    {
      kind: 'source',
      element: document.getElementById('target-action')!,
      bodyTop,
      offset,
    },
    () => true
  );
}
