import { existsSync, globSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const sourcePath =
  /^(?:\.agents|\.claude|\.githooks|\.github|core|deploy|docs|fixtures|runner|scripts|server|tests|third_party|web)\/\S*$/u;
const internalGuidePath =
  /^(?:\.agents|\.claude|\.githooks|\.github|core|fixtures|runner|scripts|server|tests|third_party|web)\/\S*$/u;
const localOnlyPaths = ['.claude/settings.local.json', '.claude/worktrees'];
const caseIdShape = /\b[A-Z][A-Z0-9]*[A-Z]\d{2}(?![\dA-Za-z_])/gu;
const caseIdMention = /\b([A-Z][A-Z0-9]*[A-Z])(\d{2})(?:[-–]\1?(\d{2}))?(?![\dA-Za-z_])/gu;
const termsShapedLikeCaseIds = new Set(['BM25']);
const shellFence = /^(?:sh|bash|shell|zsh|console|powershell|pwsh|ps1)$/u;
const repositoryCommand = /^(?:node|npm|npx)\s/u;
const scriptShaped = /^([a-z][a-z0-9]*):[a-z0-9][a-z0-9:-]*$/u;
const developerGuideHeading =
  /^#{2,6}\s+(?:(?:구현 참고|기술 명세|개발자)|\S.*\s구현 참고)(?:\s|\(|$)/u;
const guideApiRoute =
  /^(?:(?:GET|POST|PUT|PATCH|DELETE)(?:\/(?:GET|POST|PUT|PATCH|DELETE))*\s+)?(\/api\/\S+)$/u;
const operatorGuideApiRoutes = new Map([
  ['AUTOMATIC-BACKUPS.md', new Set(['/api/backup'])],
  ['SELF-HOST.md', new Set(['/api/maintenance', '/api/session'])],
  ['TAILSCALE-DEPLOY.md', new Set(['/api/library', '/api/prompt-workspace'])],
  ['UPDATES.md', new Set(['/api/maintenance'])],
]);

function markdownFiles(directory, excluded = []) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = resolve(directory, entry.name);
    if (excluded.includes(file)) return [];
    if (entry.isDirectory()) return markdownFiles(file, excluded);
    return entry.name.endsWith('.md') ? [file] : [];
  });
}

const testTitle =
  /^\s*(?:test|it)(?:\.(?:skip|only|todo|each|concurrent|fails|fixme|sequential))*\s*\(\s*(?:[`'"])([^`'"]*)/gmu;

function addTitleCaseIds(ids, content) {
  for (const [, title] of content.matchAll(testTitle)) {
    for (const [id] of title.matchAll(caseIdShape)) ids.add(id);
  }
  return ids;
}

function testCaseIds(directory) {
  const ids = new Set();
  for (const file of globSync('tests/**/*.{ts,tsx,js,mjs}', { cwd: directory }))
    addTitleCaseIds(ids, readFileSync(resolve(directory, file), 'utf8'));
  return ids;
}

const featureMapPath = 'tests/feature-map.json';
const registeredSpecPath = /^tests\/[^/]+\.spec\.ts$/u;
const domainName = /^[a-z][a-z0-9-]*$/u;
const environmentName = /^[A-Z][A-Z0-9_]*$/u;
const launchOptions = {
  runner: (value) => value === 'browser-harness' || value === 'self-host',
  providerFixture: (value) => typeof value === 'boolean',
  privateMaterials: (value) => typeof value === 'boolean',
  privateMaterialsEnv: (value) => typeof value === 'string' && environmentName.test(value),
  requiredEnv: (value) =>
    Array.isArray(value) &&
    value.every((name) => typeof name === 'string' && environmentName.test(name)),
};

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

function unknownFieldErrors(where, value, fields) {
  return Object.keys(value)
    .filter((key) => !fields.includes(key))
    .map((key) => `${featureMapPath}: ${where} has unknown field ${key}`);
}

function launchErrors(where, launch) {
  if (!isRecord(launch)) return [`${featureMapPath}: ${where} launch must be an object`];
  return Object.entries(launch).flatMap(([option, value]) => {
    if (!Object.hasOwn(launchOptions, option))
      return [`${featureMapPath}: ${where} launch has unknown option ${option}`];
    return launchOptions[option](value)
      ? []
      : [`${featureMapPath}: ${where} launch.${option} has an invalid value`];
  });
}

function presetErrors(presets, domains, registered) {
  if (presets === undefined) return [];
  if (!isRecord(presets)) return [`${featureMapPath}: presets must be an object`];
  return Object.entries(presets).flatMap(([name, preset]) => {
    const where = `preset ${name}`;
    const issues = [];
    if (!domainName.test(name))
      issues.push(`${featureMapPath}: ${where} must be lowercase words joined by hyphens`);
    if (domains.has(name)) issues.push(`${featureMapPath}: ${where} has the name of a domain`);
    if (!isRecord(preset)) return [...issues, `${featureMapPath}: ${where} must be an object`];
    issues.push(...unknownFieldErrors(where, preset, ['title', 'specs', 'grep']));
    if (typeof preset.title !== 'string' || !preset.title.trim())
      issues.push(`${featureMapPath}: ${where} needs a title`);
    if (!Array.isArray(preset.specs) || !preset.specs.length)
      issues.push(`${featureMapPath}: ${where} needs a list of specs`);
    else
      for (const spec of preset.specs)
        if (!registered.has(spec))
          issues.push(`${featureMapPath}: ${where} names ${spec}, which no domain registers`);
    if (preset.grep !== undefined && !isPattern(preset.grep))
      issues.push(`${featureMapPath}: ${where} grep is not a regular expression`);
    return issues;
  });
}

function isPattern(value) {
  if (typeof value !== 'string' || !value) return false;
  try {
    new RegExp(value);
    return true;
  } catch {
    return false;
  }
}

function featureMapErrors(directory) {
  const issues = [];
  const domains = new Set();
  const file = resolve(directory, featureMapPath);
  let map = { version: 1, domains: {} };
  if (existsSync(file)) {
    try {
      map = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      return { domains, issues: [`${featureMapPath}: ${error.message}`] };
    }
  }
  if (!isRecord(map) || !isRecord(map.domains))
    return { domains, issues: [`${featureMapPath}: domains must be an object`] };
  issues.push(...unknownFieldErrors('the map', map, ['version', 'defaults', 'domains', 'presets']));
  if (map.version !== 1) issues.push(`${featureMapPath}: version must be 1`);
  if (map.defaults !== undefined) {
    if (!isRecord(map.defaults)) issues.push(`${featureMapPath}: defaults must be an object`);
    else {
      issues.push(...unknownFieldErrors('defaults', map.defaults, ['launch']));
      if (map.defaults.launch !== undefined)
        issues.push(...launchErrors('defaults', map.defaults.launch));
    }
  }
  const registered = new Map();
  for (const [name, domain] of Object.entries(map.domains)) {
    domains.add(name);
    const where = `domain ${name}`;
    if (!domainName.test(name))
      issues.push(`${featureMapPath}: ${where} must be lowercase words joined by hyphens`);
    if (!isRecord(domain)) {
      issues.push(`${featureMapPath}: ${where} must be an object`);
      continue;
    }
    issues.push(...unknownFieldErrors(where, domain, ['title', 'sources', 'specs']));
    if (typeof domain.title !== 'string' || !domain.title.trim())
      issues.push(`${featureMapPath}: ${where} needs a title`);
    if (!Array.isArray(domain.sources) || !domain.sources.length)
      issues.push(`${featureMapPath}: ${where} needs a list of source patterns`);
    else
      for (const pattern of domain.sources) {
        if (
          typeof pattern !== 'string' ||
          !sourcePath.test(pattern) ||
          !globSync(pattern, { cwd: directory }).length
        )
          issues.push(`${featureMapPath}: ${where} source ${pattern} matches no file`);
      }
    if (!Array.isArray(domain.specs) || !domain.specs.length) {
      issues.push(`${featureMapPath}: ${where} needs a list of specs`);
      continue;
    }
    for (const entry of domain.specs) {
      if (!isRecord(entry) || typeof entry.file !== 'string') {
        issues.push(`${featureMapPath}: ${where} has a spec entry without a file`);
        continue;
      }
      const spec = entry.file;
      issues.push(...unknownFieldErrors(`${where} ${spec}`, entry, ['file', 'cases', 'launch']));
      if (registered.has(spec)) {
        issues.push(
          `${featureMapPath}: ${spec} is registered in ${registered.get(spec)} and ${name}`
        );
        continue;
      }
      registered.set(spec, name);
      const specFile = resolve(directory, spec);
      if (!registeredSpecPath.test(spec) || !existsSync(specFile)) {
        issues.push(
          `${featureMapPath}: ${where} names ${spec}, which is not a file in tests/*.spec.ts`
        );
        continue;
      }
      if (entry.launch !== undefined)
        issues.push(...launchErrors(`${where} ${spec}`, entry.launch));
      if (entry.cases === undefined) continue;
      if (!Array.isArray(entry.cases)) {
        issues.push(`${featureMapPath}: ${where} ${spec} cases must be a list`);
        continue;
      }
      const titleIds = addTitleCaseIds(new Set(), readFileSync(specFile, 'utf8'));
      for (const id of entry.cases)
        if (!titleIds.has(id))
          issues.push(`${featureMapPath}: ${spec} has no test titled with the case ID ${id}`);
    }
  }
  issues.push(...presetErrors(map.presets, domains, registered));
  for (const spec of globSync('tests/*.spec.ts', { cwd: directory })
    .map((path) => path.split(sep).join('/'))
    .sort())
    if (!registered.has(spec))
      issues.push(`${featureMapPath}: ${spec} is not registered in any domain`);
  return { domains, issues };
}

function caseIdErrors(file, content, knownIds) {
  const issues = [];
  for (const [mention, prefix, first, last] of content.matchAll(caseIdMention)) {
    if (termsShapedLikeCaseIds.has(`${prefix}${first}`)) continue;
    if (last != null && Number(first) > Number(last)) {
      issues.push(`${file}: ${mention} (case ID range is reversed)`);
      continue;
    }
    for (let number = Number(first); number <= Number(last ?? first); number++) {
      const id = `${prefix}${String(number).padStart(first.length, '0')}`;
      if (!knownIds.has(id)) issues.push(`${file}: ${mention} (no test has the case ID ${id})`);
    }
  }
  return issues;
}

function* markdownLines(content) {
  let fence = null;
  for (const line of content.split(/\r?\n/u)) {
    const delimiter = /^\s*(?:```|~~~)\s*(\S*)/u.exec(line);
    if (delimiter) fence = fence === null ? delimiter[1].toLowerCase() : null;
    else yield { line, fence };
  }
}

function headingAnchors(content) {
  const anchors = new Set();
  const repeats = new Map();
  for (const { line, fence } of markdownLines(content)) {
    const heading = fence === null ? /^#{1,6}\s+(.+?)\s*$/u.exec(line) : null;
    if (!heading) continue;
    const anchor = heading[1]
      .toLowerCase()
      .replace(/\[([^\]]*)\]\([^)]*\)/gu, '$1')
      .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
      .replace(/\s/gu, '-');
    const repeat = repeats.get(anchor) ?? 0;
    repeats.set(anchor, repeat + 1);
    anchors.add(repeat ? `${anchor}-${repeat}` : anchor);
  }
  return anchors;
}

function userGuidePurityErrors(file, content) {
  const issues = [];
  const allowedRoutes = operatorGuideApiRoutes.get(basename(file));
  for (const { line, fence } of markdownLines(content)) {
    if (fence !== null) continue;
    if (developerGuideHeading.test(line))
      issues.push(`${file}: user guide must not contain developer heading "${line.trim()}"`);
    for (const [, code] of line.matchAll(/`([^`\n]+)`/gu)) {
      if (internalGuidePath.test(code)) {
        issues.push(`${file}: \`${code}\` (user guide must not reference internal source paths)`);
        continue;
      }
      const apiMatch = guideApiRoute.exec(code);
      if (!apiMatch) continue;
      const route = apiMatch[1].split('?')[0];
      if (route === '/api/...' || allowedRoutes?.has(route)) continue;
      issues.push(`${file}: \`${code}\` (user guide must not document internal API routes)`);
    }
  }
  return issues;
}

export function documentationErrors(directory = root) {
  const broken = [];
  const docsRoot = resolve(directory, 'docs');
  const localOnly = localOnlyPaths.map((path) => resolve(directory, path));
  const files = [
    ...['README.md', 'README.ko.md', 'AGENTS.md'].map((file) => resolve(directory, file)),
    ...markdownFiles(docsRoot),
    ...markdownFiles(resolve(directory, '.claude'), localOnly),
    ...markdownFiles(resolve(directory, '.githooks')),
  ];
  const releaseNotes = resolve(directory, 'docs/releases') + sep;
  const developerDocs = resolve(directory, 'docs/dev') + sep;
  const knownCaseIds = testCaseIds(directory);
  const featureMap = featureMapErrors(directory);
  const featureMapFile = resolve(directory, featureMapPath);
  const anchorsByFile = new Map();
  const anchorsIn = (file) => {
    if (!anchorsByFile.has(file))
      anchorsByFile.set(file, headingAnchors(readFileSync(file, 'utf8')));
    return anchorsByFile.get(file);
  };
  const missingSourcePaths = (text) =>
    text.split(/\s+/u).filter((path) => {
      if (!sourcePath.test(path)) return false;
      const resolved = resolve(directory, path);
      if (localOnly.some((local) => resolved === local || resolved.startsWith(local + sep)))
        return false;
      return !globSync(path.replace(/<[^>]+>/gu, '*'), { cwd: directory }).length;
    });
  const packageFile = resolve(directory, 'package.json');
  const scripts = existsSync(packageFile)
    ? (JSON.parse(readFileSync(packageFile, 'utf8')).scripts ?? {})
    : {};
  const scriptNamespaces = new Set(Object.keys(scripts).map((name) => name.split(':')[0]));
  const missingScripts = (code) => {
    const named = [...code.matchAll(/\bnpm\s+run(?:-script)?\s+([^\s-]\S*)/gu)].map(
      ([, script]) => script
    );
    const [first] = code.split(/\s+/u);
    if (scriptNamespaces.has(scriptShaped.exec(first)?.[1])) named.push(first);
    return named.filter((script) => !/<[^>]+>/u.test(script) && !Object.hasOwn(scripts, script));
  };
  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    for (const match of content.matchAll(/\]\(([^\s)]+)(?:\s+[^)]*)?\)/gu)) {
      if (/^(?:https?:|mailto:)/u.test(match[1])) continue;
      const [path, fragment] = match[1].split('#');
      const target = path ? resolve(dirname(file), decodeURIComponent(path)) : file;
      if (!existsSync(target)) broken.push(`${file}: ${match[1]}`);
      else if (
        fragment &&
        target.endsWith('.md') &&
        !anchorsIn(target).has(decodeURIComponent(fragment))
      )
        broken.push(`${file}: ${match[1]} (no heading has the anchor #${fragment})`);
      else if (fragment && target === featureMapFile && !featureMap.domains.has(fragment))
        broken.push(`${file}: ${match[1]} (the feature map has no domain ${fragment})`);
      if (
        path &&
        dirname(file) === docsRoot &&
        internalGuidePath.test(`${relative(directory, target).split(sep).join('/')}/`)
      )
        broken.push(`${file}: ${match[1]} (user guide must not link to internal source paths)`);
    }
    if (file.startsWith(releaseNotes)) continue;
    if (dirname(file) === docsRoot) broken.push(...userGuidePurityErrors(file, content));
    for (const [, code] of content.matchAll(/`([^`\n]+)`/gu)) {
      for (const path of missingSourcePaths(code))
        broken.push(`${file}: \`${path}\` (no file or directory matches this path)`);
      for (const script of missingScripts(code.trim()))
        broken.push(`${file}: \`${code}\` (package.json has no script named ${script})`);
    }
    for (const { line, fence } of markdownLines(content)) {
      const command = line.trim();
      if (!shellFence.test(fence ?? '') || !repositoryCommand.test(command)) continue;
      for (const script of missingScripts(command))
        broken.push(`${file}: ${command} (package.json has no script named ${script})`);
      for (const path of missingSourcePaths(command))
        broken.push(`${file}: ${command} (no file or directory matches ${path})`);
    }
    if (file.startsWith(developerDocs)) broken.push(...caseIdErrors(file, content, knownCaseIds));
  }
  broken.push(...featureMap.issues);
  for (const file of readdirSync(resolve(directory, 'scripts')).filter(
    (name) => name.startsWith('verify-') && name.endsWith('.mjs')
  )) {
    for (const match of readFileSync(resolve(directory, 'scripts', file), 'utf8').matchAll(
      /['"](tests\/[^'"`$]+\.(?:test\.ts|spec\.ts))['"]/gu
    )) {
      if (!existsSync(resolve(directory, match[1]))) broken.push(`${file}: ${match[1]}`);
    }
  }
  return broken;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const broken = documentationErrors();
  if (broken.length) {
    console.error(broken.join('\n'));
    process.exitCode = 1;
  } else
    console.log(
      'Documentation links, anchors, source paths, fenced commands, case IDs, feature map and verification entry points PASS'
    );
}
