import type { ProviderProtocol } from './product.js';

/** Immutable attachment metadata. Binary data is resolved only at transmission. */
export type RequestFile = {
  hash: string;
  name: string;
  mime: string;
  bytes: number;
  kind: 'document' | 'text' | 'audio' | 'video';
  /** Local extracted-text token estimate, before context admission headroom; absent for unknown media. */
  tokenEstimate?: number;
};
export type RequestFileUpload = { uploadId: string; sha256: string; name: string };
export type RequestFilePart = { type: 'file'; file: RequestFile };
export type ResolvedRequestFile = { mime: string; base64: string };

// Staging safety bounds; selected providers impose their own raw and serialized limits.
export const REQUEST_FILE_MAX_COUNT = 100;
export const REQUEST_FILE_MAX_BYTES = 100_000_000;
export const REQUEST_FILES_MAX_BYTES = 100_000_000;

const extensions: Record<string, { mime: string; kind: RequestFile['kind'] }> = {};
function register(kind: RequestFile['kind'], mime: string, names: string) {
  for (const name of names.split(' ')) extensions[name] = { mime, kind };
}
register('document', 'application/pdf', 'pdf');
register('document', 'application/msword', 'doc dot');
register(
  'document',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'docx'
);
register('document', 'application/rtf', 'rtf');
register('document', 'application/vnd.oasis.opendocument.text', 'odt');
register('document', 'application/vnd.ms-powerpoint', 'ppt pot ppa pps pwz wiz');
register(
  'document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'pptx'
);
register('document', 'application/vnd.ms-excel', 'xls xla xlb xlc xlm xlt xlw');
register('document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx');
register('document', 'application/vnd.apple.pages', 'pages');
register('document', 'application/vnd.apple.keynote', 'key keynote');
register('text', 'text/plain', 'txt text md markdown log iif');
register('text', 'text/csv', 'csv');
register('text', 'text/tab-separated-values', 'tsv');
register('text', 'application/json', 'json');
register('text', 'application/xml', 'xml');
register('text', 'text/html', 'html htm');
register('text', 'text/css', 'css');
register('text', 'text/javascript', 'js jsx ts tsx mjs cjs');
register('text', 'text/plain', 'py java c h cpp hpp cs go rs rb php sh sql yaml yml toml ini');
register(
  'text',
  'text/plain',
  'asm bat cc conf cxx def dic eml hh ics ifb in ksh list mht mhtml mime nws pl rst s srt vcf vtt'
);
register(
  'text',
  'text/plain',
  'ps1 scala kt kts swift lua r jl perl m mm erl ex exs hs clj groovy dart awk tex diff patch make cmake dockerfile gradle properties proto sass scss less hcl tf graphql gql ndjson jsonl json5 astro hbs mustache ejs jinja jinja2 liquid erb twig pug jade tmpl'
);
register('audio', 'audio/mp3', 'mp3');
register('audio', 'audio/mpeg', 'mpga');
register('audio', 'audio/wav', 'wav');
register('audio', 'audio/aiff', 'aiff aif aifc');
register('audio', 'audio/aac', 'aac');
register('audio', 'audio/ogg', 'ogg oga');
register('audio', 'audio/opus', 'opus');
register('audio', 'audio/flac', 'flac');
register('audio', 'audio/m4a', 'm4a');
register('audio', 'audio/l16', 'l16');
register('audio', 'audio/alaw', 'alaw');
register('audio', 'audio/mulaw', 'mulaw');
register('audio', 'audio/webm', 'weba');
register('audio', 'audio/l16', 'l16');
register('audio', 'audio/alaw', 'alaw');
register('audio', 'audio/mulaw', 'mulaw');
register('audio', 'audio/webm', 'weba');
register('video', 'video/mp4', 'mp4');
register('video', 'video/mpeg', 'mpeg');
register('video', 'video/mpg', 'mpg');
register('video', 'video/mov', 'mov');
register('video', 'video/avi', 'avi');
register('video', 'video/x-flv', 'flv');
register('video', 'video/webm', 'webm');
register('video', 'video/wmv', 'wmv');
register('video', 'video/3gpp', '3gp 3gpp');

/** Extension establishes the admitted format; browser MIME is only a fallback for known formats. */
export function classifyRequestFile(name: string, mime?: string) {
  const extension = name.toLowerCase().split('.').at(-1) ?? '';
  const known = extensions[extension];
  if (known) return { ...known };
  const normalized = mime?.split(';')[0].trim().toLowerCase();
  const match = Object.values(extensions).find((entry) => entry.mime === normalized);
  return match ? { ...match } : undefined;
}

export function providerFileLimits(protocol: ProviderProtocol) {
  if (
    protocol === 'openai-responses-v1' ||
    protocol === 'openai-chat-v1' ||
    protocol === 'vercel-chat-v1'
  )
    return { maxFileBytes: 50_000_000, maxTotalBytes: 50_000_000, maxRequestBytes: 100_000_000 };
  if (protocol === 'anthropic-messages-v1')
    return { maxFileBytes: 32_000_000, maxTotalBytes: 32_000_000, maxRequestBytes: 32_000_000 };
  return {
    maxFileBytes: REQUEST_FILE_MAX_BYTES,
    maxTotalBytes: REQUEST_FILES_MAX_BYTES,
    maxRequestBytes: 100_000_000,
  };
}

export function fileInputUnsupportedReason(
  protocol: ProviderProtocol,
  modelId: string,
  file: Pick<RequestFile, 'mime' | 'kind'>
): string | undefined {
  if (protocol === 'codex-app-server-v1' || protocol === 'deepseek-chat-v1')
    return 'FILE_INPUT_UNSUPPORTED_PROTOCOL';
  if (/^(?:deepseek\/)?deepseek-(?:chat|reasoner|v4-pro|v4-flash)$/u.test(modelId))
    return 'FILE_INPUT_UNSUPPORTED_MODEL';
  if (protocol === 'fixture-sse-v1') return;
  if (protocol === 'google-gemini-v1' || protocol === 'vertex-gemini-v1') {
    if (file.kind !== 'document' || file.mime === 'application/pdf') return;
  } else if (protocol === 'openai-responses-v1') {
    if (file.kind === 'text' || file.kind === 'document') return;
  } else if (protocol === 'anthropic-messages-v1') {
    if (file.kind === 'text' || file.mime === 'application/pdf') return;
  } else if (protocol === 'openai-chat-v1' || protocol === 'vercel-chat-v1') {
    if (file.mime === 'application/pdf') return;
  }
  return 'FILE_INPUT_UNSUPPORTED_TYPE';
}
export function fileInputSupported(
  protocol: ProviderProtocol,
  modelId: string,
  file: Pick<RequestFile, 'mime' | 'kind'>
): boolean {
  return fileInputUnsupportedReason(protocol, modelId, file) === undefined;
}

/** File-picker hints use the same format registry and selected-provider policy as admission. */
export function requestFileAccept(protocol: ProviderProtocol, modelId: string): string {
  return Object.entries(extensions)
    .filter(([, file]) => fileInputSupported(protocol, modelId, file))
    .map(([extension]) => `.${extension}`)
    .join(',');
}

const invalid = (): never => {
  throw new Error('REQUEST_FILES_INVALID');
};
export function validateRequestFile(value: unknown): RequestFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const file = value as Record<string, unknown>;
  if (
    Object.keys(file).some(
      (key) => !['hash', 'name', 'mime', 'bytes', 'kind', 'tokenEstimate'].includes(key)
    ) ||
    typeof file.hash !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(file.hash) ||
    typeof file.name !== 'string' ||
    !file.name.trim() ||
    file.name.length > 300 ||
    /[\p{Cc}/\\]/u.test(file.name) ||
    typeof file.mime !== 'string' ||
    !Number.isSafeInteger(file.bytes) ||
    Number(file.bytes) < 1 ||
    Number(file.bytes) > REQUEST_FILE_MAX_BYTES ||
    (file.tokenEstimate !== undefined &&
      (!Number.isSafeInteger(file.tokenEstimate) || Number(file.tokenEstimate) < 1))
  )
    return invalid();
  const classified = classifyRequestFile(file.name, file.mime);
  if (!classified || classified.mime !== file.mime || classified.kind !== file.kind)
    return invalid();
  return {
    hash: file.hash,
    name: file.name,
    mime: file.mime,
    bytes: Number(file.bytes),
    kind: classified.kind,
    ...(file.tokenEstimate === undefined ? {} : { tokenEstimate: Number(file.tokenEstimate) }),
  };
}
export function validateRequestFiles(value: unknown): RequestFile[] {
  if (!Array.isArray(value) || value.length > REQUEST_FILE_MAX_COUNT) return invalid();
  const files = value.map(validateRequestFile);
  if (files.reduce((sum, file) => sum + file.bytes, 0) > REQUEST_FILES_MAX_BYTES) return invalid();
  return files;
}
