import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildBiomeConfig } from './biome-config.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const target = `${root}biome.json`;
const biome = `${root}node_modules/@biomejs/biome`;

export function formatBiomeConfig(config) {
  const scratch = mkdtempSync(join(tmpdir(), 'uimori-biome-config-'));
  try {
    writeFileSync(
      join(scratch, 'biome.json'),
      JSON.stringify({ formatter: config.formatter, javascript: config.javascript })
    );
    const formatted = spawnSync(
      process.execPath,
      [`${biome}/bin/biome`, 'format', `--stdin-file-path=${join(scratch, 'biome.json')}`],
      { cwd: scratch, input: JSON.stringify(config, null, 2), encoding: 'utf8' }
    );
    if (formatted.status !== 0)
      throw new Error(`biome format failed:\n${formatted.stderr}${formatted.error ?? ''}`);
    return formatted.stdout;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function generateBiomeConfig() {
  const { version } = JSON.parse(readFileSync(`${biome}/package.json`, 'utf8'));
  return formatBiomeConfig(buildBiomeConfig({ schemaVersion: version }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const generated = generateBiomeConfig();
  if (!process.argv.includes('--check')) writeFileSync(target, generated);
  else if (readFileSync(target, 'utf8') !== generated) {
    console.error(
      [
        'biome.json is not what scripts/biome-config.mjs generates.',
        'Edit the import boundaries in scripts/biome-config.mjs, never in biome.json,',
        'then run `npm run biome:generate` and commit the result.',
      ].join('\n')
    );
    process.exit(1);
  }
}
