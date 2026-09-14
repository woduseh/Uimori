import {
  RISU_PLUGIN_API_SUPPORT,
  RISU_PLUGIN_MAX_BYTES,
  type RisuPluginArgument,
  type RisuPluginPreview,
} from '../core/risu-plugin.js';
import { readImportEnvelope, type InlineImportEnvelope } from './import-envelope.js';
import { HttpError } from './request-validation.js';

const invalid = (): never => {
  throw new HttpError(400, 'RISU_PLUGIN_INVALID_FILE');
};
/** Reading a plugin never executes, compiles or transforms it; only its declarations are read. */
const MEMBER = /(?:^|[^\w$.])(?:risuai|Risuai)\s*\.\s*([A-Za-z_$][\w$]*)/gu;
const DESTRUCTURED = /\{([^{}]{0,2000})\}\s*=\s*(?:await\s+)?(?:risuai|Risuai)\b/gu;
/** Only the plain `const r = risuai` shape; the alias is named, never resolved. */
const ALIAS = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:risuai|Risuai)\s*(?![\w$.[])/gu;

/** The declared preview, the exact text the adapter turns into module actions, and the envelope. */
export function readRisuPluginFile(value: unknown): {
  preview: RisuPluginPreview;
  code: string;
  file: InlineImportEnvelope;
  /** Names the file binds the API object to. The adapter cannot see what they register. */
  aliases: string[];
} {
  // A plugin never reaches the staged upload path: the client stages only above the far larger
  // import limit, so anything staged would exceed RISU_PLUGIN_MAX_BYTES and be refused here.
  const envelope = readImportEnvelope(value, {
    maxBytes: RISU_PLUGIN_MAX_BYTES,
    extensions: /\.js$/iu,
    invalid: 'RISU_PLUGIN_INVALID_FILE',
    tooLarge: 'RISU_PLUGIN_TOO_LARGE',
  });
  const { bytes, sha256 } = envelope;
  const source = bytes.toString('utf8').replace(/^\uFEFF/u, '');
  if (source.includes('\u0000')) invalid();
  const findings: RisuPluginPreview['findings'] = [];
  const finding = (
    code: string,
    level: RisuPluginPreview['findings'][number]['level'],
    message: string
  ) => {
    if (!findings.some((item) => item.code === code)) findings.push({ code, level, message });
  };
  let pluginName = '';
  let displayName = '';
  let apiVersion = '2.0';
  let pluginVersion = '';
  let updateUrl = '';
  const allowedIpc: string[] = [];
  const links: RisuPluginPreview['links'] = [];
  const args: RisuPluginArgument[] = [];
  for (const raw of source.split('\n')) {
    const line = raw.replace(/\r$/u, '');
    // Risu assigns on every header line, so the last //@name wins; match that reading exactly.
    if (line.startsWith('//@name')) pluginName = line.slice(7).trim();
    if (line.startsWith('//@display-name')) displayName = line.slice(16).trim();
    if (line.startsWith('//@api')) {
      const declared = line.slice(6).trim().split(/\s+/u).filter(Boolean);
      const supported = declared.find((version) => ['2.0', '2.1', '3.0'].includes(version));
      if (supported) apiVersion = supported;
    }
    if (line.startsWith('//@link')) {
      const parts = line.trim().split(/\s+/u);
      const url = parts[1] ?? '';
      if (url.startsWith('https://') && links.length < 20)
        links.push({
          url: url.slice(0, 2000),
          ...(parts.length > 2 ? { hoverText: parts.slice(2).join(' ').slice(0, 200) } : {}),
        });
    }
    // Risu's own version of the plugin, kept apart from the //@api line it reads separately.
    if (line.startsWith('//@version')) pluginVersion = line.slice(10).trim().slice(0, 100);
    if (line.startsWith('//@update-url')) {
      const url = line.trim().split(/\s+/u)[1] ?? '';
      if (url.startsWith('https://')) updateUrl = url.slice(0, 2000);
    }
    if (line.startsWith('//@allowed-ipc'))
      for (const channel of line.trim().split(/\s+/u).slice(1))
        if (allowedIpc.length < 50 && !allowedIpc.includes(channel))
          allowedIpc.push(channel.slice(0, 100));
    if (line.startsWith('//@arg') || line.startsWith('//@risu-arg')) {
      const parts = line.trim().split(/\s+/u);
      const type = parts[2];
      if (parts.length >= 3 && (type === 'int' || type === 'string') && args.length < 100)
        args.push({
          key: parts[1].slice(0, 100),
          type,
          description: parts.slice(3).join(' ').slice(0, 500),
        });
    }
  }
  if (!pluginName) invalid();
  const used = new Set<string>();
  for (const match of source.matchAll(MEMBER)) used.add(match[1]);
  for (const match of source.matchAll(DESTRUCTURED))
    for (const part of match[1].split(','))
      if (/^[A-Za-z_$][\w$]*$/u.test(part.trim())) used.add(part.trim());
  const apis = [...used]
    .filter((member) => RISU_PLUGIN_API_SUPPORT[member])
    .sort()
    .map((member) => ({ name: member, ...RISU_PLUGIN_API_SUPPORT[member] }));
  const unknownApis = [...used].filter((member) => !RISU_PLUGIN_API_SUPPORT[member]).sort();
  const aliases = [...new Set([...source.matchAll(ALIAS)].map((match) => match[1]))].slice(0, 10);
  finding(
    'plugin-not-executed',
    'info',
    '가져오는 동안에는 플러그인 코드를 실행하지 않고 선언한 정보만 읽어요. 코드는 가져온 뒤 격리된 자료 행동으로만 실행해요.'
  );
  finding(
    'plugin-api-detection',
    'info',
    `사용 API는 글자만 대조해서 찾아요. 별칭(const r = risuai), 계산된 접근, 이름을 바꾼 구조 분해는 놓치니 "미구현" 목록이 비어도 쓰지 않는다는 증거는 아니에요.${
      aliases.length
        ? ` risuai를 다른 이름으로 받는 곳이 있어요: ${aliases.join(', ')}. 이 이름으로 부른 멤버는 판정하지 않았어요.`
        : ''
    }`
  );
  if (allowedIpc.length)
    finding(
      'plugin-allowed-ipc',
      'unsupported',
      `//@allowed-ipc로 플러그인 사이 통신 채널 ${allowedIpc.length}개를 선언해요. 플러그인 채널은 아직 구현하지 않아서 이 선언은 동작하지 않아요.`
    );
  if (apiVersion !== '3.0')
    finding(
      'plugin-api-version',
      'warning',
      `이 파일은 API ${apiVersion}을 선언해요. 지원 범위 판정은 3.0 기준이라 실제 사용 API가 다를 수 있어요.`
    );
  for (const level of ['out-of-scope', 'unimplemented'] as const)
    if (apis.some((api) => api.support === level))
      finding(
        `plugin-api-${level}`,
        'unsupported',
        level === 'out-of-scope'
          ? '결정으로 제공하지 않는 API를 사용해요. 해당 기능은 Uimori 방식으로 다시 설계해야 해요.'
          : '아직 구현하지 않은 API를 사용해요. 해당 기능은 지금 동작하지 않아요.'
      );
  if (unknownApis.length)
    finding(
      'plugin-api-unknown',
      'warning',
      '알려진 목록에 없는 이름도 사용해요. 이 이름들은 판정하지 않고 그대로 보고해요.'
    );
  return {
    preview: {
      name: pluginName.slice(0, 200),
      displayName: (displayName || pluginName).slice(0, 200),
      apiVersion,
      pluginVersion,
      updateUrl,
      allowedIpc,
      links,
      arguments: args,
      apis,
      unknownApis: unknownApis.slice(0, 200),
      findings,
      bytes: bytes.length,
      sha256,
    },
    code: source,
    file: envelope,
    aliases,
  };
}

export const readRisuPlugin = (value: unknown): RisuPluginPreview =>
  readRisuPluginFile(value).preview;
