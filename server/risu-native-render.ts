import MarkdownIt from 'markdown-it';
import {
  nativeRisuAssetNames,
  nativeRisuBackground,
  nativeRisuRegex,
  type RisuContentSource,
} from '../core/risu-native.js';
import { createNativeRisuCbs, type NativeRisuCbsContext } from './risu-native-cbs.js';
import { runNativeRisuWorker } from './risu-native-worker.js';

export type NativeRisuRenderInput = {
  native: RisuContentSource;
  text: string;
  context: Omit<NativeRisuCbsContext, 'native' | 'random'>;
  timeoutMs?: number;
};
export type NativeRisuRenderResult = { html: string; css: string; issues: string[] };
export type NativeRisuTextInput = NativeRisuRenderInput & {
  mode: 'editinput' | 'editoutput' | 'editprocess' | 'editdisplay';
};
export type NativeRisuTextResult = {
  text: string;
  variables: Record<string, string>;
  issues: string[];
};
const escapeAttribute = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
const assetNames = new Set([
  'asset',
  'image',
  'img',
  'emotion',
  'raw',
  'path',
  'source',
  'bg',
  'audio',
  'video',
  'video-img',
  'bgm',
]);

const localAssetUrl = /^\/api\/(?:package-image-blobs|assets)\/[A-Za-z0-9_.-]+$/u;
const assetMaxDifference = 4;

/** Risu's trimmer removes known extensions, then separator characters (not all whitespace). */
function normalizedAssetName(value: string): string {
  let name = value.toLocaleLowerCase();
  for (const extension of [
    'webp',
    'png',
    'jpg',
    'jpeg',
    'gif',
    'mp4',
    'webm',
    'avi',
    'm4p',
    'm4v',
    'mp3',
    'wav',
    'ogg',
  ])
    if (name.endsWith(`.${extension}`)) name = name.slice(0, -extension.length - 1);
  return name.trim().replace(/[_ .-]/gu, '');
}

/** Same UTF-16 Levenshtein distance as Risu, bounded to the only accepted distance band. */
function assetDistance(a: string, b: string, limit: number): number {
  const outside = limit + 1;
  if (Math.abs(a.length - b.length) > limit) return outside;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let previous = new Uint32Array(b.length + 1).fill(outside);
  let current = new Uint32Array(b.length + 1).fill(outside);
  for (let j = 0; j <= Math.min(b.length, limit); j++) previous[j] = j;
  for (let i = 1; i <= a.length; i++) {
    const start = Math.max(1, i - limit);
    const end = Math.min(b.length, i + limit);
    current[start - 1] = start === 1 ? Math.min(i, outside) : outside;
    let smallest = current[start - 1];
    for (let j = start; j <= end; j++) {
      current[j] = Math.min(
        previous[j - 1] + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1),
        previous[j] + 1,
        current[j - 1] + 1
      );
      smallest = Math.min(smallest, current[j]);
    }
    if (smallest > limit) return outside;
    if (end < b.length) current[end + 1] = outside;
    [previous, current] = [current, previous];
  }
  return previous[b.length];
}

function createAssetResolver(input: NativeRisuRenderInput): (name: string) => string | undefined {
  const urls = input.context.assetUrls ?? {};
  const exact = new Map<string, string>();
  const candidates: { name: string; url: string }[] = [];
  for (const asset of input.native.assets) {
    const aliases = nativeRisuAssetNames(input.native, asset);
    const url = aliases.map((name) => urls[name]).find(Boolean) ?? urls[asset.imageId];
    if (!url || !localAssetUrl.test(url)) continue;
    for (const alias of aliases) exact.set(alias.toLocaleLowerCase(), url);
    candidates.push({ name: normalizedAssetName(asset.name), url });
  }
  // Attached modules may have extension aliases not described in the active card's JSON.
  // Keep only aliases pointing to an already admitted, stored local asset.
  const storedUrls = new Set(candidates.map((asset) => asset.url));
  for (const [name, url] of Object.entries(urls))
    if (storedUrls.has(url)) exact.set(name.toLocaleLowerCase(), url);
  const resolved = new Map<string, string | undefined>();
  return (rawName) => {
    const name = rawName.trim().toLocaleLowerCase();
    // Some authored cards leave literal references to optional, now-removed capture groups.
    const match = exact.get(name) ?? exact.get(name.replace(/\$\d{1,2}/gu, '').trim());
    if (match) return match;
    if (resolved.has(name)) return resolved.get(name);
    const normalized = normalizedAssetName(name);
    let closest: string | undefined;
    let distance = assetMaxDifference + 1;
    for (const asset of candidates) {
      const next = assetDistance(normalized, asset.name, distance - 1);
      // Strictly smaller preserves original asset order when multiple names tie.
      if (next < distance) {
        closest = asset.url;
        distance = next;
        if (distance === 0) break;
      }
    }
    resolved.set(name, closest);
    return closest;
  };
}

/** Asset tags keep their native HTML/CSS meaning; only local imported asset URLs are resolved. */
function assets(text: string, resolve: (name: string) => string | undefined, issues: string[]) {
  return text.replace(
    /{{(raw|path|img|image|video|audio|bgm|bg|emotion|asset|video-img|source)::([^{}]*?)}}/gims,
    (tag, rawType: string, name: string) => {
      const type = rawType.toLowerCase();
      const url = resolve(name);
      if (!url) {
        issues.push(`asset:${name.trim()}`);
        return type === 'raw' || type === 'path' || type === 'source' ? '' : tag;
      }
      if (['raw', 'path', 'source'].includes(type)) return url;
      const safe = escapeAttribute(url);
      if (type === 'audio' || type === 'bgm') return `<audio controls src="${safe}"></audio>`;
      if (type === 'video' || type === 'video-img') return `<video controls src="${safe}"></video>`;
      if (type === 'bg')
        return `<div class="risu-background" style="background-image:url('${safe}')"></div>`;
      const img = `<img src="${safe}" alt="${escapeAttribute(name)}">`;
      return type === 'image' ? `<div class="risu-inlay-image">${img}</div>` : img;
    }
  );
}

/** Runs only inside the bounded worker. Based on Risu ParseMarkdown/processScriptFull ordering. */
export function processNativeRisuTextInWorker(input: NativeRisuTextInput): NativeRisuTextResult {
  if (input.text.length > 2_000_000) throw new Error('RISU_NATIVE_TEXT_LIMIT');
  const context = {
    ...input.context,
    native: input.native,
    variables: { ...input.context.variables },
  };
  const cbs = createNativeRisuCbs(context);
  const issues: string[] = [];
  let text = cbs.parse(input.text);
  const scripts = nativeRisuRegex(input.native)
    .filter((script) => script.type === input.mode)
    .map((script, index) => {
      const actions: string[] = [];
      let order = 0;
      const flag = (script.ableFlag ? script.flag || 'g' : 'g').replace(
        /<([^>]+)>/gu,
        (_tag, metas: string) => {
          for (const meta of metas.split(',').map((value) => value.trim())) {
            if (meta.startsWith('order ')) order = Number.parseInt(meta.slice(6), 10) || 0;
            else actions.push(meta);
          }
          return '';
        }
      );
      return { script, index, order, actions, flag };
    })
    .sort((a, b) => b.order - a.order || a.index - b.index);
  for (const { script, index, actions, flag } of scripts) {
    if (!script.in) continue;
    try {
      let replacement = script.out.replaceAll('$n', '\n').replaceAll('{{data}}', '$&');
      const moving =
        replacement.startsWith('@@move_top') ||
        replacement.startsWith('@@move_bottom') ||
        actions.includes('move_top') ||
        actions.includes('move_bottom');
      let flags = [...new Set(flag.replace(/[^dgimsuvy]/gu, '').split(''))].join('') || 'u';
      if (moving) flags = flags.replaceAll('g', '');
      if (replacement.endsWith('>') && !actions.includes('no_end_nl')) replacement += '\n';
      const pattern = actions.includes('cbs') ? cbs.parse(script.in) : script.in;
      const regex = new RegExp(pattern, flags);
      if (moving) {
        const found = regex.exec(text);
        if (found) {
          const moved = found[0].replace(
            new RegExp(pattern, flags),
            replacement.replace(/^@@move_(?:top|bottom)\s*/u, '')
          );
          text = text.replace(regex, '');
          text =
            replacement.startsWith('@@move_top') || actions.includes('move_top')
              ? `${moved}\n${text}`
              : `${text}\n${moved}`;
        }
      } else if (replacement.startsWith('@@')) {
        issues.push(`regex-command:${index}`);
      } else text = text.replace(regex, replacement);
      if (text.length > 2_000_000) throw new Error('RISU_NATIVE_TEXT_LIMIT');
      text = cbs.parse(text);
    } catch (error) {
      if (error instanceof Error && /LIMIT|TIMEOUT/u.test(error.message)) throw error;
      issues.push(`regex:${index}`);
    }
  }
  return { text, variables: context.variables, issues: [...new Set([...issues, ...cbs.issues])] };
}

export function processNativeRisuText(input: NativeRisuTextInput): Promise<NativeRisuTextResult> {
  return runNativeRisuWorker(
    new URL('./risu-native-render.js', import.meta.url),
    'processNativeRisuTextInWorker',
    input,
    input.timeoutMs
  );
}

export function renderNativeRisuMessageInWorker(
  input: NativeRisuRenderInput
): NativeRisuRenderResult {
  const issues: string[] = [];
  const resolveAsset = createAssetResolver(input);
  const processed = processNativeRisuTextInWorker({
    ...input,
    text: assets(input.text, resolveAsset, issues),
    mode: 'editdisplay',
  });
  issues.push(...processed.issues);
  const cbs = createNativeRisuCbs({
    ...input.context,
    native: input.native,
    variables: processed.variables,
  });
  let text = assets(processed.text, resolveAsset, issues);
  const background = assets(cbs.parse(nativeRisuBackground(input.native)), resolveAsset, issues);
  // Styles are restored after Markdown parsing, preventing CSS content from becoming Markdown.
  const styles: string[] = [];
  text = text.replace(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/giu, (_tag, css: string) => {
    styles.push(css);
    return `\n\n<risu-style data-index="${styles.length - 1}"></risu-style>\n\n`;
  });
  const md = new MarkdownIt({ html: true, breaks: true, linkify: false, typographer: false });
  // Risu/PocketRisu allow indented authored HTML; only fenced blocks are Markdown code.
  md.disable(['code']);
  let html = md.render(text);
  html = html.replace(
    /<risu-style data-index="(\d+)"><\/risu-style>/gu,
    (_tag, index: string) =>
      `<style>${styles[Number(index)]!.replace(/<\/(?=style)/giu, '<\\/')}</style>`
  );
  // CSS is scoped by the opaque iframe document, preserving native class/selectors and @keyframes.
  html = `${background}<div class="risu-chat risu-chat-text">${html}</div>`;
  if (html.length > 4_000_000) throw new Error('RISU_NATIVE_TEXT_LIMIT');
  return {
    html,
    css: '',
    issues: [...new Set([...issues, ...cbs.issues].filter((name) => !assetNames.has(name)))],
  };
}

export function renderNativeRisuMessage(
  input: NativeRisuRenderInput
): Promise<NativeRisuRenderResult> {
  return runNativeRisuWorker(
    new URL('./risu-native-render.js', import.meta.url),
    'renderNativeRisuMessageInWorker',
    input,
    input.timeoutMs
  );
}
