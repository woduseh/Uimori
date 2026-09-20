import DOMPurify from 'dompurify';

export const RISU_FRAME_CHANNEL = 'uimori-risu-message-v1';
export type PreparedRisuMessage = { srcDoc: string; token: string; actions: Set<string> };
const safeCss = (css: string) => css.replaceAll('<', '\\3C ');
export const risuActionKey = (kind: string, name: string) => JSON.stringify([kind, name]);

function messageCss(value: string): string {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(value);
  const selectors = (value: string) => {
    const parts: string[] = [];
    let start = 0,
      depth = 0,
      quote = '';
    for (let index = 0; index < value.length; index++) {
      const char = value[index]!;
      if (char === '\\') {
        index++;
        continue;
      }
      if (quote) {
        if (char === quote) quote = '';
      } else if (char === '"' || char === "'") quote = char;
      else if (char === '(' || char === '[') depth++;
      else if (char === ')' || char === ']') depth--;
      else if (char === ',' && depth === 0) {
        parts.push(value.slice(start, index));
        start = index + 1;
      }
    }
    parts.push(value.slice(start));
    return parts.map((selector) => `.risu-chat-text ${selector.trim()}`).join(',');
  };
  const scope = (rules: CSSRuleList) => {
    for (const rule of rules) {
      if (rule instanceof CSSStyleRule) rule.selectorText = selectors(rule.selectorText);
      else if ('cssRules' in rule && !(rule instanceof CSSKeyframesRule))
        scope((rule as CSSGroupingRule).cssRules);
    }
  };
  scope(sheet.cssRules);
  return [...sheet.cssRules].map((rule) => rule.cssText).join('\n');
}

/** Author HTML is sanitized before the sole trusted bridge is appended. The iframe has an opaque origin. */
export function prepareRisuMessage(html: string, css = ''): PreparedRisuMessage {
  if (html.length > 4_000_000 || css.length > 2_000_000) throw new Error('RISU_NATIVE_FRAME_LIMIT');
  const token = crypto.randomUUID(),
    nonce = crypto.randomUUID().replaceAll('-', '');
  const template = document.createElement('template');
  template.innerHTML = `<div>${html}</div>`;
  const styles = new Map<string, string>();
  // Preserve native CSS (including SVG data URLs) as text; it never re-enters an HTML parser.
  for (const node of template.content.querySelectorAll('style')) {
    const key = crypto.randomUUID(),
      placeholder = document.createElement('span');
    const value = node.textContent ?? '';
    // Upstream message styles are descendants of .chattext. In particular, authored
    // html/body rules must not resize the host document merely because it is an iframe.
    styles.set(key, node.closest('.risu-chat-text') ? messageCss(value) : value);
    placeholder.setAttribute('data-risu-style', key);
    node.replaceWith(placeholder);
  }
  const clean = DOMPurify.sanitize(template.innerHTML, {
    ADD_ATTR: ['risu-trigger', 'risu-btn', 'risu-ctrl', 'risu-id', 'risu-mark', 'data-risu-style'],
    ADD_TAGS: ['style'],
    ALLOW_DATA_ATTR: true,
    ALLOW_ARIA_ATTR: true,
    FORBID_TAGS: ['script', 'iframe', 'frame', 'object', 'embed', 'base', 'meta', 'link', 'form'],
    FORBID_ATTR: ['srcdoc', 'formaction', 'action', 'autofocus', 'nonce'],
    RETURN_TRUSTED_TYPE: false,
  });
  template.innerHTML = clean;
  for (const node of template.content.querySelectorAll('[data-risu-style]')) {
    const value = styles.get(node.getAttribute('data-risu-style') ?? '');
    if (value === undefined) {
      node.remove();
      continue;
    }
    const style = document.createElement('style');
    style.textContent = safeCss(value);
    node.replaceWith(style);
  }
  const actions = new Set<string>();
  for (const node of template.content.querySelectorAll('[risu-trigger],[risu-btn]')) {
    const kind = node.hasAttribute('risu-trigger') ? 'trigger' : 'button';
    const name = node.getAttribute(kind === 'trigger' ? 'risu-trigger' : 'risu-btn') ?? '';
    if (name.length > 1000 || !name) {
      node.removeAttribute('risu-trigger');
      node.removeAttribute('risu-btn');
      continue;
    }
    actions.add(risuActionKey(kind, name));
  }
  // Relative media may only address imported asset routes. No authored external requests.
  for (const node of template.content.querySelectorAll('[src],[poster],[href],[srcset]')) {
    node.removeAttribute('srcset');
    for (const attr of ['src', 'poster', 'href']) {
      const value = node.getAttribute(attr);
      if (
        value !== null &&
        (attr === 'href'
          ? !value.startsWith('#')
          : !/^\/api\/(?:package-image-blobs|assets)\/[A-Za-z0-9_.-]+$/u.test(value) &&
            !/^data:image\/(?:png|jpeg|gif|webp|avif|svg\+xml);/iu.test(value))
      )
        node.removeAttribute(attr);
    }
  }
  const channel = RISU_FRAME_CHANNEL;
  const bridge = `(()=>{
    const channel=${JSON.stringify(channel)},token=${JSON.stringify(token)};let disabled=true,queued=false,fixedWidth=-1,fixedFloor=0,fixed=[];
    const send=(kind,values={})=>parent.postMessage({channel,token,kind,...values},'*');
    const size=()=>{queued=false;
      if(fixedWidth!==innerWidth){fixedWidth=innerWidth;fixedFloor=0;const nodes=new Set();
        for(const control of document.querySelectorAll('[risu-trigger],[risu-btn],button,label[for],a[href],input,select,textarea,summary,[role="button"],[tabindex]')){
          for(let node=control;node&&node!==document.body;node=node.parentElement){if(getComputedStyle(node).position==='fixed'){nodes.add(node);observer.observe(node);}}
        }fixed=[...nodes];
      }
      for(const node of fixed){const rect=node.getBoundingClientRect(),style=getComputedStyle(node);if(!rect.height||rect.right<=0||rect.left>=innerWidth||style.visibility==='hidden'||style.opacity==='0')continue;const bottom=Number.parseFloat(style.bottom);fixedFloor=Math.max(fixedFloor,rect.bottom,rect.height+(Number.isFinite(bottom)?Math.max(0,bottom):0));}
      const rect=document.body.getBoundingClientRect();send('resize',{height:Math.ceil(Math.max(rect.height,rect.bottom,fixedFloor))});
    };
    const schedule=()=>{if(!queued){queued=true;requestAnimationFrame(size);}};
    addEventListener('message',event=>{const d=event.data;if(event.source!==parent||!d||d.channel!==channel||d.token!==token)return;
      if(d.kind==='disabled'){disabled=!!d.value;document.body.dataset.risuDisabled=String(disabled);}
      if(d.kind==='appearance'){const root=document.documentElement;
        if(typeof d.color==='string'&&CSS.supports('color',d.color))root.style.setProperty('--uimori-text',d.color);
        if(Number.isFinite(d.fontSize))root.style.setProperty('--uimori-font-size',Math.max(9,Math.min(28,d.fontSize))+'px');
        if(Number.isFinite(d.lineHeight))root.style.setProperty('--uimori-line-height',String(Math.max(1,Math.min(3,d.lineHeight))));
        if(typeof d.fontFamily==='string'&&d.fontFamily.length<300)root.style.setProperty('--uimori-font-family',d.fontFamily);
        root.style.colorScheme=d.colorScheme==='dark'?'dark':'light';schedule();
      }
    });
    document.addEventListener('click',event=>{const target=event.target instanceof Element?event.target.closest('[risu-trigger],[risu-btn]'):null;if(!target)return;event.preventDefault();event.stopPropagation();if(disabled)return;const actionKind=target.hasAttribute('risu-trigger')?'trigger':'button';const name=target.getAttribute(actionKind==='trigger'?'risu-trigger':'risu-btn');if(name&&name.length<=1000){disabled=true;send('action',{actionKind,name});}},true);
    document.addEventListener('submit',event=>event.preventDefault(),true);
    for(const name of ['wheel','touchstart','pointerdown','keydown'])document.addEventListener(name,event=>{
      if(event.isTrusted&&(name!=='keydown'||['ArrowUp','ArrowDown','PageUp','PageDown','Home','End',' '].includes(event.key)))send('interaction');
    },{capture:true,passive:true});
    const observer=new ResizeObserver(schedule);observer.observe(document.body);addEventListener('resize',schedule);document.addEventListener('load',schedule,true);document.addEventListener('toggle',schedule,true);send('ready');schedule();
  })();`;
  const origin = location.origin.replaceAll('"', '');
  const media = `${origin}/api/package-image-blobs/ ${origin}/api/assets/ data:`;
  // A flow root includes the first/last paragraph margins in body's measured natural height.
  // It preserves overflow and fixed controls while avoiding an iframe-height feedback loop.
  const srcDoc = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src ${media}; media-src ${media}; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'"><style>html,body{margin:0;padding:0;min-width:0;background:transparent;color:inherit;overflow-wrap:anywhere}body{display:flow-root;font:var(--uimori-font-size,16px)/var(--uimori-line-height,1.6) var(--uimori-font-family,system-ui,sans-serif);color:var(--uimori-text,var(--uimori-fallback-text,#24242b))}img,video{max-width:100%}*,*::before,*::after{box-sizing:border-box}button{font:inherit;cursor:pointer}.risu-background{position:fixed;inset:0;background-size:cover;z-index:-1}body[data-risu-disabled="true"] [risu-trigger],body[data-risu-disabled="true"] [risu-btn]{pointer-events:none!important}@media(prefers-color-scheme:dark){body{--uimori-fallback-text:#eee}}${safeCss(css)}</style></head><body data-risu-disabled="true">${template.innerHTML}<script nonce="${nonce}">${bridge}</script></body></html>`;
  return { srcDoc, token, actions };
}
