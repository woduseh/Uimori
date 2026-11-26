import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const releaseCommands = [
  [
    /\bgit(?:\s+-[cC]\s+\S+)*\s+tag\s+(?!-l\b|--list\b|-n\d*\b|--contains\b|--points-at\b|--merged\b|--no-merged\b|--sort\b)\S/u,
    'git tag creates a release tag',
  ],
  [/\bnpm(?:\.cmd)?\s+(?:version\b|pkg\s+set\s+["']?version=)/u, 'npm version changes the app version'],
  [/\bgh\s+release\s+(?:create|edit|delete|upload)\b/u, 'gh release publishes a release'],
  [
    /\brelease:(?:oracle|smoke)\b|\b(?:release-oracle|oracle-smoke)\.mjs\b/u,
    'the Oracle release scripts deploy to production',
  ],
  [/>\s*["']?[^\s|;&"']*docs[\\/]releases[\\/]/u, 'it writes release notes'],
  [
    /\b(?:tee|cp|mv|Copy-Item|Move-Item|New-Item|Set-Content|Add-Content|Out-File)\b[^|;&\n]*docs[\\/]releases[\\/]/iu,
    'it writes release notes',
  ],
];

const version = (text) => /"version"\s*:\s*"([^"]*)"/u.exec(text)?.[1] ?? null;
const applyEdit = (text, { old_string: from = '', new_string: to = '', replace_all: all }) =>
  all ? text.replaceAll(from, () => to) : text.replace(from, () => to);

function editedText(tool, input, current) {
  if (tool === 'Write') return input.content ?? '';
  if (tool === 'Edit') return applyEdit(current, input);
  if (tool === 'MultiEdit') return (input.edits ?? []).reduce(applyEdit, current);
  return current;
}

export function releaseRefusal(
  { tool_name: tool, tool_input: input = {} },
  {
    env = process.env,
    readText = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : null),
  } = {}
) {
  if (env.UIMORI_ALLOW_RELEASE === '1') return null;
  if (tool === 'Bash' || tool === 'PowerShell') {
    const command = String(input.command ?? '');
    return releaseCommands.find(([pattern]) => pattern.test(command))?.[1] ?? null;
  }
  const file = String(input.file_path ?? '').replaceAll('\\', '/');
  if (!file) return null;
  const current = readText(input.file_path);
  if (/(?:^|\/)docs\/releases\/[^/]+$/u.test(file) && current === null)
    return 'it creates release notes';
  if (/(?:^|\/)package\.json$/u.test(file) && !file.includes('/node_modules/')) {
    const next = editedText(tool, input, current ?? '');
    if (version(next) !== version(current ?? '')) return 'it changes the package.json version';
  }
  return null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    process.exit(0);
  }
  const reason = releaseRefusal(input);
  if (reason) {
    process.stderr.write(
      `Blocked by .claude/hooks/release-guard.mjs: ${reason}. Version changes, tags, release notes and deployments are the user's to start: they run Claude Code with UIMORI_ALLOW_RELEASE=1 for a release. Leave this step to the user.\n`
    );
    process.exit(2);
  }
}
