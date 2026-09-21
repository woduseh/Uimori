import { reserveFixedControls } from '../../web/risu-message-layout.js';
import { selectedReaderText } from '../../web/reader-dom.js';
import surfaceCss from '../../web/risu-message-surface.css?inline';

const tick = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const settle = async () => {
  for (let i = 0; i < 4; i++) await tick();
};
function check(value: unknown, message: string): void {
  if (!value) throw new Error(message);
}

function trackLayoutResources() {
  const NativeObserver = window.ResizeObserver;
  const add = EventTarget.prototype.addEventListener;
  const remove = EventTarget.prototype.removeEventListener;
  const observers: { targets: Set<Element>; observeCalls: number }[] = [];
  const events = new Set(['resize', 'change', 'toggle', 'load', 'transitionend', 'animationend']);
  const listeners: {
    target: EventTarget;
    type: string;
    callback: EventListenerOrEventListenerObject | null;
  }[] = [];
  class TrackedObserver extends NativeObserver {
    targets = new Set<Element>();
    observeCalls = 0;
    constructor(callback: ResizeObserverCallback) {
      super(callback);
      observers.push(this);
    }
    override observe(node: Element, options?: ResizeObserverOptions) {
      this.targets.add(node);
      this.observeCalls++;
      super.observe(node, options);
    }
    override unobserve(node: Element) {
      this.targets.delete(node);
      super.unobserve(node);
    }
    override disconnect() {
      this.targets.clear();
      super.disconnect();
    }
  }
  window.ResizeObserver = TrackedObserver;
  EventTarget.prototype.addEventListener = function (type, callback, options) {
    if (events.has(type)) listeners.push({ target: this, type, callback });
    add.call(this, type, callback, options);
  };
  EventTarget.prototype.removeEventListener = function (type, callback, options) {
    const at = listeners.findIndex(
      (entry) => entry.target === this && entry.type === type && entry.callback === callback
    );
    if (at >= 0) listeners.splice(at, 1);
    remove.call(this, type, callback, options);
  };
  return {
    observers,
    listeners,
    restore() {
      window.ResizeObserver = NativeObserver;
      EventTarget.prototype.addEventListener = add;
      EventTarget.prototype.removeEventListener = remove;
    },
  };
}

function mountLayout(mount: HTMLElement, html: string, css = '') {
  const host = document.createElement('div');
  host.className = 'risu-message-surface';
  const root = host.attachShadow({ mode: 'open' });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(surfaceCss);
  root.adoptedStyleSheets = [sheet];
  const author = document.createElement('style');
  author.textContent = css;
  const content = document.createElement('div');
  content.className = 'risu-message-content';
  content.innerHTML = html;
  root.append(author, content);
  mount.append(host);
  const release = reserveFixedControls(host, content);
  return {
    host,
    root,
    content,
    dispose() {
      release();
      host.remove();
    },
  };
}

/** Focused checks run against the real layout/selection modules, without React or server fixtures. */
export async function runSurfaceCleanupRegressions(mount: HTMLElement): Promise<string[]> {
  const passed: string[] = [];
  const cleanup: (() => void)[] = [];
  const create = (html: string, css = '') => {
    const fixture = mountLayout(mount, html, css);
    cleanup.push(() => fixture.dispose());
    return fixture;
  };
  const run = async (
    name: string,
    test: (probe: ReturnType<typeof trackLayoutResources>) => void | Promise<void>
  ) => {
    const probe = trackLayoutResources();
    try {
      await test(probe);
      passed.push(name);
    } catch (error) {
      throw new Error(`${name}: ${(error as Error).message}`);
    } finally {
      window.getSelection()?.removeAllRanges();
      while (cleanup.length) cleanup.pop()!();
      probe.restore();
      mount.replaceChildren();
    }
  };

  await run(
    'Ordinary links and controls install zero layout observers or listeners',
    async (probe) => {
      const s = create(
        '<p>본문 <a href="#next">Link</a></p><button>Button</button><input id="check" type="checkbox"><label for="check">Toggle</label><details><summary>Details</summary>Text</details>',
        'button::after {content:"position: fixed"} /* position:fixed is not a declaration here */'
      );
      (s.root.querySelector('label') as HTMLElement).click();
      s.root.querySelector('details')!.open = true;
      await settle();
      check(probe.observers.length === 0, 'ordinary controls created a layout observer');
      check(probe.listeners.length === 0, 'ordinary controls installed layout event listeners');
      check(s.host.style.minHeight === '', 'normal flow acquired an artificial height');
    }
  );
  await run('Decorative fixed artwork without controls does not reserve space', (probe) => {
    create('<div class="art">Art</div>', '.art {position:fixed;top:10px;height:200px}');
    check(
      probe.observers.length === 0 && probe.listeners.length === 0,
      'noninteractive art enabled toolbar layout'
    );
  });
  await run('A toolbar is observed once, not once per nested control', async (probe) => {
    const s = create(
      '<div class="toolbar"><label for="settings">1</label><label for="settings">2</label><label for="settings">3</label><label for="settings">4</label><label for="settings">5</label></div><input id="settings" hidden type="checkbox">',
      '.toolbar {position:fixed;top:35px;right:12px;display:flex;flex-direction:column;gap:8px}.toolbar label{display:block;width:48px;height:48px}'
    );
    await settle();
    check(s.host.style.minHeight === '307px', `toolbar height was ${s.host.style.minHeight}`);
    check(probe.observers.length === 1, 'multiple observers were created');
    check(
      probe.observers[0].targets.size === 2 &&
        probe.observers[0].targets.has(s.root.querySelector('.toolbar')!),
      'ordinary ancestors were observed'
    );
    check(probe.observers[0].observeCalls === 2, 'shared toolbar was repeatedly observed');
    (s.root.querySelector('label') as HTMLElement).click();
    check(s.root.querySelector<HTMLInputElement>('#settings')!.checked, 'label target changed');
  });
  await run('Checkbox activation adds and removes the fixed observation target', async (probe) => {
    const s = create(
      '<input type="checkbox" id="pin"><div class="toolbar"><button>Go</button></div>',
      '.toolbar{height:80px} #pin:checked ~ .toolbar{position:fixed;top:35px;right:12px}'
    );
    const toolbar = s.root.querySelector('.toolbar')!;
    const input = s.root.querySelector('input')!;
    await settle();
    check(!probe.observers[0].targets.has(toolbar), 'inactive toolbar was observed');
    for (let i = 0; i < 2; i++) {
      input.click();
      await settle();
      check(
        s.host.style.minHeight === '115px' && probe.observers[0].targets.has(toolbar),
        'newly fixed toolbar missed'
      );
      input.click();
      await settle();
      check(
        s.host.style.minHeight === '' && !probe.observers[0].targets.has(toolbar),
        'flow toolbar retained its floor or observation'
      );
    }
  });
  await run('Border-box resize grows and shrinks the height floor', async () => {
    const s = create(
      '<div class="toolbar"><button>Go</button></div>',
      '.toolbar{box-sizing:content-box;position:fixed;top:35px;right:12px;height:80px}'
    );
    const toolbar = s.root.querySelector<HTMLElement>('.toolbar')!;
    await settle();
    toolbar.style.border = '12px solid black';
    await settle();
    check(s.host.style.minHeight === '139px', 'border-only resize was missed');
    toolbar.style.height = '20px';
    await settle();
    check(s.host.style.minHeight === '79px', 'height floor did not shrink');
  });
  await run(
    'Hidden panels do not inflate layout and transition completion releases their space',
    async (probe) => {
      const s = create(
        '<aside class="panel"><button>Go</button></aside>',
        '.panel{position:fixed;top:35px;right:-600px;width:180px;height:200px;opacity:0}'
      );
      const panel = s.root.querySelector<HTMLElement>('.panel')!;
      await settle();
      check(s.host.style.minHeight === '', 'offscreen hidden panel reserved space');
      panel.style.right = '12px';
      panel.style.opacity = '1';
      panel.dispatchEvent(
        new TransitionEvent('transitionend', { bubbles: true, propertyName: 'right' })
      );
      await settle();
      check(s.host.style.minHeight === '235px', 'opened panel was not measured');
      panel.style.opacity = '0';
      panel.dispatchEvent(
        new TransitionEvent('transitionend', { bubbles: true, propertyName: 'opacity' })
      );
      await settle();
      check(s.host.style.minHeight === '', 'hidden panel kept its old height');
      s.content.dispatchEvent(new Event('change'));
      s.dispose();
      await settle();
      check(
        probe.observers.every((observer) => observer.targets.size === 0),
        'teardown retained observer targets'
      );
      check(
        probe.listeners.length === 0 && s.host.style.minHeight === '',
        'teardown retained listeners or queued layout'
      );
    }
  );
  await run('Container width changes activate fixed layout without a window resize', async () => {
    const container = document.createElement('section');
    container.style.cssText = 'container-type:inline-size;width:400px';
    mount.append(container);
    const s = create(
      '<div class="toolbar"><button>Go</button></div>',
      '.toolbar{height:80px} @container(max-width:300px){.toolbar{position:fixed;top:10px;right:12px}}'
    );
    container.append(s.host);
    await settle();
    check(s.host.style.minHeight === '', 'wide container reserved a fixed floor');
    container.style.width = '240px';
    await settle();
    check(s.host.style.minHeight === '90px', 'container-only width change was missed');
    container.style.width = '400px';
    await settle();
    check(s.host.style.minHeight === '', 'wide container kept the fixed floor');
  });
  await run('Position variables inside grouped CSS can activate fixed layout', async () => {
    const s = create(
      '<div class="toolbar"><button>Go</button></div>',
      '@layer card { @media (min-width:1px) { .toolbar{position:var(--pin,static);top:25px;right:12px;height:60px} } }'
    );
    await settle();
    check(s.host.style.minHeight === '', 'inactive position variable reserved space');
    s.host.style.setProperty('--pin', 'fixed');
    s.content.dispatchEvent(new Event('change'));
    await settle();
    check(s.host.style.minHeight === '85px', 'grouped variable-based fixed rule was ignored');
  });
  await run('Inline fixed controls reserve space without a stylesheet', async () => {
    const s = create(
      '<button style="position:fixed;top:35px;right:12px;height:80px">Inline control</button>'
    );
    await settle();
    check(s.host.style.minHeight === '115px', 'inline fixed position was ignored');
  });
  await run('Modern composed selection keeps only the owning reader text', () => {
    const article = document.createElement('section');
    mount.append(article);
    const s = create('<p>선택할 본문</p>');
    article.append(s.host);
    const selection = window.getSelection()!;
    const text = s.root.querySelector('p')!.firstChild!;
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
  });
  return passed;
}

/** Kept mounted while Playwright changes the real viewport, not a mocked matchMedia result. */
export function mountResponsiveLayoutRegression(mount: HTMLElement): void {
  mountLayout(
    mount,
    '<div class="responsive-toolbar"><button>Responsive</button></div>',
    '.responsive-toolbar{height:80px} @media(max-width:700px){.responsive-toolbar{position:fixed;top:35px;right:12px}}'
  );
}
