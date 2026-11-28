export const runtimeRoots = ['core', 'packages', 'server', 'web', 'runner'];
export const sourceRoots = [...runtimeRoots, 'scripts', 'tests'];
const browserRoots = runtimeRoots.filter((root) => root !== 'runner');
export const scriptImportDirectories = [
  'scripts',
  'tests',
  'runner',
  'deploy',
  '.githooks',
  '.claude/hooks',
];
const scriptImportSource = '\\.(?:mjs|js|cjs|ts|tsx|mts|cts)$';

const patterns = {
  biomeFile: /\.(?:ts|tsx|mts|js|mjs|cjs|json|jsonc|css)$/u,
  typeScriptInput:
    /(?:\.(?:ts|tsx|mts)|^(?:core|packages|server|web|tests|scripts)\/.+\.(?:js|mjs)|^package\.json|^tsconfig[^/]*\.json)$/u,
  moduleFile: new RegExp(`^(?:${sourceRoots.join('|')})/.+\\.(?:ts|tsx|mts|js|mjs)$`, 'u'),
  commentSource: /\.(?:ts|tsx|mts|cts|js|mjs|cjs|css)$/u,
  vitestFile: /^tests\/.+\.test\.ts$/u,
  toolingTestFile: /^(?:scripts\/[^/]+\.test\.(?:mjs|ts)|tests\/[^/]+\.node\.test\.mjs)$/u,
  scriptImportInput: new RegExp(
    `^(?:(?:${scriptImportDirectories.map((name) => name.replace('.', '\\.')).join('|')})/[^\\r\\n]+|[^/\\r\\n]+)${scriptImportSource}`,
    'u'
  ),
  fullSuiteInput:
    /^(?:package(?:-lock)?\.json|vitest\.config\.ts|tsconfig[^/]*\.json|biome\.json|scripts\/build[^/]*\.mjs)$/u,
  fullCommentScan: /^scripts\/(?:check-comments\.mjs|comment-allowlist\.json)$/u,
  i18nInput:
    /^(?:(?:web|server|core|packages)\/|scripts\/(?:check-i18n\.mjs|korean-literal-allowlist\.json)$)/u,
  uiMessageInput:
    /^(?:web\/.+\.(?:ts|tsx|mts|js|mjs)$|scripts\/(?:check-ui-message\.mjs|ui-message-allowlist\.json)$)/u,
  endpointCallInput:
    /^(?:web\/.+\.(?:ts|tsx|mts|js|mjs)$|scripts\/(?:check-endpoint-calls\.mjs|legacy-api-allowlist\.json)$)/u,
  userGuide: /^docs\/[^/]+\.md$/u,
  distEntry: /^server\/(?:index|app)\.ts$/u,
  hookFile: /^(?:\.githooks|\.claude\/hooks)\//u,
  scriptFile: /^scripts\//u,
  topLevelScript: /^scripts\/[^/]+$/u,
  markdownFile: /\.md$/u,
  browserInput: new RegExp(
    `^(?:${browserRoots.join('|')})/|^tests/(?:fixtures/|[^/]+\\.spec\\.ts$)|^playwright\\.config\\.ts$`,
    'u'
  ),
  inertDocumentation:
    /^(?:docs\/(?:dev|plans|releases)\/[^\r\n]+\.md|README(?:\.ko)?\.md|AGENTS\.md|LICENSE)$/u,
  windowsInsensitive:
    /^(?:web\/|docs\/[^\r\n]+\.md$|README(?:\.ko)?\.md$|AGENTS\.md$|LICENSE$|tests\/[^/]+\.spec\.ts$)/u,
};

export const is = Object.fromEntries(
  Object.entries(patterns).map(([name, pattern]) => [name, (file) => pattern.test(file)])
);

export function classesOf(file) {
  return Object.keys(patterns).filter((name) => is[name](file));
}

export function withoutModuleExtension(file) {
  return file.replace(/\.(?:[cm]?[jt]sx?)$/u, '');
}

export function docsOnly(files) {
  return files.length > 0 && files.every(is.inertDocumentation);
}

export function windowsSensitive(files) {
  return !files.length || files.some((file) => !is.windowsInsensitive(file));
}
