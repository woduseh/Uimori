import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { is } from './change-classifier.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

export function readFeatureMap(directory = root) {
  return JSON.parse(readFileSync(path.join(directory, 'tests/feature-map.json'), 'utf8'));
}

export function selectChanged(map, files) {
  const owners = new Set();
  const uncovered = [];
  for (const file of files) {
    const matched = Object.entries(map.domains).filter(
      ([, domain]) =>
        domain.sources.some((pattern) => path.posix.matchesGlob(file, pattern)) ||
        domain.specs.some((entry) => entry.file === file)
    );
    for (const [name] of matched) owners.add(name);
    if (!matched.length && is.browserInput(file)) uncovered.push(file);
  }
  return {
    domains: Object.keys(map.domains).filter((name) => owners.has(name)),
    uncovered,
  };
}
