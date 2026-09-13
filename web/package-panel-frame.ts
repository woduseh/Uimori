import DOMPurify from 'dompurify';
import { PACKAGE_PANEL_CSS_LIMIT, PACKAGE_PANEL_HTML_LIMIT } from '../core/package-panels.js';

export const PACKAGE_PANEL_ACTION_LIMIT = 100;
export const PACKAGE_PANEL_MESSAGE_LIMIT = 32_000;
export const PACKAGE_PANEL_MIN_HEIGHT = 80;
export const PACKAGE_PANEL_MAX_HEIGHT = 900;

const allowedTags = [
  'article',
  'aside',
  'blockquote',
  'br',
  'button',
  'caption',
  'code',
  'dd',
  'details',
  'div',
  'dl',
  'dt',
  'em',
  'fieldset',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'input',
  'label',
  'legend',
  'li',
  'main',
  'ol',
  'optgroup',
  'option',
  'output',
  'p',
  'pre',
  'progress',
  'section',
  'select',
  'small',
  'span',
  'strong',
  'summary',
  'table',
  'tbody',
  'td',
  'textarea',
  'tfoot',
  'th',
  'thead',
  'tr',
  'ul',
] as const;

const allowedAttributes = [
  'aria-label',
  'aria-labelledby',
  'aria-describedby',
  'aria-current',
  'aria-expanded',
  'aria-live',
  'aria-pressed',
  'aria-selected',
  'checked',
  'class',
  'cols',
  'data-uimori-action',
  'data-uimori-input',
  'disabled',
  'for',
  'high',
  'id',
  'label',
  'low',
  'max',
  'maxlength',
  'min',
  'minlength',
  'name',
  'open',
  'optimum',
  'placeholder',
  'readonly',
  'required',
  'role',
  'rows',
  'selected',
  'span',
  'step',
  'title',
  'type',
  'value',
] as const;

const forbiddenTags = [
  'audio',
  'base',
  'canvas',
  'embed',
  'iframe',
  'image',
  'img',
  'link',
  'math',
  'meta',
  'object',
  'picture',
  'script',
  'source',
  'style',
  'svg',
  'template',
  'track',
  'video',
] as const;

const forbiddenAttributes = [
  'action',
  'background',
  'cite',
  'formaction',
  'href',
  'integrity',
  'method',
  'ping',
  'poster',
  'src',
  'srcdoc',
  'srcset',
  'style',
  'target',
  'usemap',
] as const;

export type PreparedPackagePanel =
  | { ok: true; token: string; srcDoc: string }
  | { ok: false; issue: string };

function validActions(actions: string[]): boolean {
  return (
    actions.length <= PACKAGE_PANEL_ACTION_LIMIT &&
    new Set(actions).size === actions.length &&
    actions.every(
      (action) =>
        typeof action === 'string' &&
        /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/u.test(action) &&
        !['__proto__', 'prototype', 'constructor'].includes(action)
    )
  );
}

function bridgeSource(token: string): string {
  return `(() => {
  'use strict';
  const channel = 'uimori-package-panel-v1';
  const token = ${JSON.stringify(token)};
  const parentWindow = window.parent;
  const maxMessageChars = ${PACKAGE_PANEL_MESSAGE_LIMIT};
  const minHeight = ${PACKAGE_PANEL_MIN_HEIGHT};
  const maxHeight = ${PACKAGE_PANEL_MAX_HEIGHT};
  const forbiddenNames = new Set(['__proto__', 'prototype', 'constructor']);
  const fieldTypes = new Set(['checkbox', 'email', 'hidden', 'number', 'radio', 'search', 'select-one', 'tel', 'text', 'textarea', 'url']);
  const post = (kind, detail = {}) => parentWindow.postMessage({ channel, token, kind, ...detail }, '*');
  const issue = (code) => post('issue', { code });
  const action = (actionId, input, submitted) => {
    if (typeof actionId !== 'string' || actionId.length > 100) return issue('PACKAGE_PANEL_ACTION_INVALID');
    const detail = { actionId, input, ...(submitted ? { submitted } : {}) };
    const message = { channel, token, kind: 'action', ...detail };
    let encoded;
    try { encoded = JSON.stringify(message); } catch { return issue('PACKAGE_PANEL_INPUT_INVALID'); }
    if (encoded === undefined || encoded.length > maxMessageChars) return issue('PACKAGE_PANEL_INPUT_LIMIT');
    parentWindow.postMessage(message, '*');
  };
  const hostDisabled = new WeakSet();
  const setDisabled = (value) => {
    document.body.dataset.uimoriDisabled = value ? 'true' : 'false';
    for (const node of document.querySelectorAll('button, input, select, textarea')) {
      if (value && !node.disabled) {
        hostDisabled.add(node);
        node.disabled = true;
      } else if (!value && hostDisabled.has(node)) {
        hostDisabled.delete(node);
        node.disabled = false;
      }
    }
  };
  // The frame becomes interactive only after its parent installs the matching token listener.
  setDisabled(true);
  const fieldType = (field) => field instanceof HTMLSelectElement ? 'select-one' : field instanceof HTMLTextAreaElement ? 'textarea' : field.type;
  const descriptor = (form, field) => ({
    formAction: form.dataset.uimoriAction || '',
    fieldName: field.name,
    fieldType: fieldType(field),
  });
  const matchingFields = (draft) => {
    const matches = [];
    for (const form of document.querySelectorAll('form[data-uimori-action]')) {
      if (form.dataset.uimoriAction !== draft.formAction) continue;
      for (const field of form.elements) {
        if (!(field instanceof HTMLInputElement || field instanceof HTMLSelectElement || field instanceof HTMLTextAreaElement)) continue;
        if (field.name === draft.fieldName && fieldType(field) === draft.fieldType) matches.push(field);
      }
    }
    if (!matches.length) return [];
    const forms = new Set(matches.map((field) => field.form));
    if (matches.length > 1 && !(draft.fieldType === 'radio' && forms.size === 1)) throw new Error('ambiguous');
    return matches;
  };
  const ownedDescriptor = (field) => {
    const form = field.form;
    if (!(form instanceof HTMLFormElement) || !form.dataset.uimoriAction || !field.name) throw new Error('owner');
    const draft = descriptor(form, field);
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/.test(draft.fieldName) || forbiddenNames.has(draft.fieldName) || !fieldTypes.has(draft.fieldType)) throw new Error('field');
    matchingFields(draft);
    return draft;
  };
  const draftValue = (field) => {
    if (field instanceof HTMLInputElement && field.type === 'checkbox') return field.checked;
    if (field instanceof HTMLInputElement && field.type === 'radio') return field.checked ? field.value : undefined;
    if (field instanceof HTMLInputElement && field.type === 'number') return field.value === '' ? '' : field.valueAsNumber;
    return field.value;
  };
  const applyDraft = (draft, clear = false) => {
    const matches = matchingFields(draft);
    for (const field of matches) {
      if (field instanceof HTMLInputElement && field.type === 'checkbox') field.checked = clear ? false : draft.value === true;
      else if (field instanceof HTMLInputElement && field.type === 'radio') field.checked = !clear && field.value === String(draft.value);
      else field.value = clear ? '' : String(draft.value ?? '');
    }
  };
  const applyDrafts = (drafts, clear = false) => {
    if (!Array.isArray(drafts) || drafts.length > 100) return issue('PACKAGE_PANEL_DRAFT_INVALID');
    try {
      for (const draft of drafts) {
        if (!draft || typeof draft !== 'object' || typeof draft.formAction !== 'string' || typeof draft.fieldName !== 'string' || typeof draft.fieldType !== 'string') throw new Error('draft');
        applyDraft(draft, clear);
      }
      scheduleHeight();
    } catch { issue('PACKAGE_PANEL_DRAFT_INVALID'); }
  };
  const scalarForm = (form) => {
    const result = Object.create(null);
    const submitted = [];
    const seen = new Set();
    for (const field of form.elements) {
      if (!(field instanceof HTMLInputElement || field instanceof HTMLSelectElement || field instanceof HTMLTextAreaElement)) continue;
      if (field.disabled || !field.name) continue;
      const name = field.name;
      if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/.test(name) || forbiddenNames.has(name)) throw new Error('name');
      if (field instanceof HTMLSelectElement && field.multiple) throw new Error('multiple');
      if (field instanceof HTMLInputElement && ['button', 'submit', 'reset', 'image', 'file'].includes(field.type)) continue;
      if (field instanceof HTMLInputElement && field.type === 'radio' && !field.checked) continue;
      if (seen.has(name)) throw new Error('duplicate');
      seen.add(name);
      let value;
      if (field instanceof HTMLInputElement && field.type === 'checkbox') value = field.checked;
      else if (field instanceof HTMLInputElement && field.type === 'number') {
        if (field.value === '') throw new Error('number');
        value = field.valueAsNumber;
        if (!Number.isFinite(value)) throw new Error('number');
      } else value = field.value;
      if (typeof value === 'string' && value.length > 8000) throw new Error('length');
      result[name] = value;
      submitted.push({ ...ownedDescriptor(field), value });
      if (submitted.length > 100) throw new Error('fields');
    }
    return { input: result, submitted };
  };
  const sendDraft = (event) => {
    if (!event.isTrusted) return;
    const field = event.target;
    if (!(field instanceof HTMLInputElement || field instanceof HTMLSelectElement || field instanceof HTMLTextAreaElement)) return;
    try {
      const draft = ownedDescriptor(field);
      const value = draftValue(field);
      if (value !== undefined) post('draft', { ...draft, value });
    } catch { issue('PACKAGE_PANEL_DRAFT_INVALID'); }
  };
  document.addEventListener('input', sendDraft, true);
  document.addEventListener('change', sendDraft, true);
  document.addEventListener('click', (event) => {
    if (!event.isTrusted || document.body.dataset.uimoriDisabled === 'true') return;
    const target = event.target instanceof Element ? event.target.closest('button[data-uimori-action]') : null;
    if (!(target instanceof HTMLButtonElement)) return;
    event.preventDefault();
    let input = {};
    try { input = JSON.parse(target.dataset.uimoriInput || '{}'); }
    catch { return issue('PACKAGE_PANEL_INPUT_INVALID'); }
    action(target.dataset.uimoriAction || '', input);
  }, true);
  document.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!event.isTrusted || document.body.dataset.uimoriDisabled === 'true') return;
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.dataset.uimoriAction) return;
    try {
      const submission = scalarForm(form);
      action(form.dataset.uimoriAction, submission.input, submission.submitted);
    }
    catch { issue('PACKAGE_PANEL_FORM_INVALID'); }
  }, true);
  window.addEventListener('message', (event) => {
    const data = event.data;
    if (event.source !== parentWindow || !data || data.channel !== channel || data.token !== token) return;
    if (data.kind === 'init') {
      applyDrafts(data.drafts);
      setDisabled(data.disabled === true);
      post('ready');
      scheduleHeight();
    } else if (data.kind === 'clear-drafts') {
      applyDrafts(data.drafts, true);
    } else if (data.kind === 'disabled') setDisabled(data.value === true);
  });
  let resizeFrame = 0;
  const reportHeight = () => {
    resizeFrame = 0;
    const height = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
    post('resize', { height: Math.max(minHeight, Math.min(maxHeight, Math.ceil(height))) });
  };
  const scheduleHeight = () => {
    if (!resizeFrame) resizeFrame = requestAnimationFrame(reportHeight);
  };
  new ResizeObserver(scheduleHeight).observe(document.documentElement);
  document.addEventListener('toggle', scheduleHeight, true);
  document.addEventListener('input', scheduleHeight, true);
  window.addEventListener('load', scheduleHeight, { once: true });
})();`;
}

function safeCss(css: string): string {
  // CSP blocks all fetches; replacing '<' also prevents an authored </style> from ending the host tag.
  return css.replaceAll('<', '\\3C ');
}

export function preparePackagePanel(
  html: string,
  css: string,
  actions: string[],
  issue?: string
): PreparedPackagePanel {
  if (issue)
    return {
      ok: false,
      issue:
        issue === 'PACKAGE_PANEL_RENDER_FAILED'
          ? '패키지 패널의 표시 내용을 만들지 못했어요.'
          : '패키지 패널을 표시할 수 없어요.',
    };
  if (html.length > PACKAGE_PANEL_HTML_LIMIT || css.length > PACKAGE_PANEL_CSS_LIMIT)
    return { ok: false, issue: '패키지 패널의 크기 제한을 넘었어요.' };
  if (!validActions(actions))
    return { ok: false, issue: '패키지 패널의 행동 목록이 올바르지 않아요.' };
  try {
    const clean = DOMPurify.sanitize(html, {
      ALLOWED_TAGS: [...allowedTags],
      ALLOWED_ATTR: [...allowedAttributes],
      ALLOW_ARIA_ATTR: true,
      ALLOW_DATA_ATTR: false,
      FORBID_TAGS: [...forbiddenTags],
      FORBID_ATTR: [...forbiddenAttributes],
      KEEP_CONTENT: true,
      RETURN_TRUSTED_TYPE: false,
    });
    if (!clean.trim()) return { ok: false, issue: '패키지 패널에 표시할 안전한 내용이 없어요.' };
    const token = crypto.randomUUID();
    const nonce = crypto.randomUUID().replaceAll('-', '');
    const bootstrap = bridgeSource(token);
    const srcDoc = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; form-action 'none'; base-uri 'none'; img-src 'none'; connect-src 'none'; font-src 'none'; frame-src 'none'; media-src 'none'; object-src 'none'"><style>${safeCss(css)}</style><style>*,*::before,*::after{box-sizing:border-box}html,body{margin:0;min-width:0;overflow-wrap:anywhere}body{padding:12px;color:#1b1b1f;background:transparent;font:14px/1.5 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}button,input,select,textarea,summary{font:inherit;min-block-size:44px!important}button,input,select,textarea{max-width:100%}body[data-uimori-disabled="true"] [data-uimori-action],body[data-uimori-disabled="true"] button,body[data-uimori-disabled="true"] input,body[data-uimori-disabled="true"] select,body[data-uimori-disabled="true"] textarea{pointer-events:none!important;opacity:.58!important}@media(prefers-color-scheme:dark){body{color:#f0f0f3}}</style></head><body>${clean}<script nonce="${nonce}">${bootstrap}</script></body></html>`;
    return { ok: true, token, srcDoc };
  } catch {
    return { ok: false, issue: '패키지 패널의 안전한 표시 문서를 만들지 못했어요.' };
  }
}
