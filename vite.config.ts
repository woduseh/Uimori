import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { brotliCompress, gzip } from 'node:zlib';
import { defineConfig, runnerImport, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const brotli = promisify(brotliCompress);
const gzipped = promisify(gzip);

function precompressedAssets(): Plugin {
  return {
    name: 'uimori-precompressed-assets',
    apply: 'build',
    async writeBundle(options, bundle) {
      if (!options.dir) return;
      await Promise.all(
        Object.keys(bundle)
          .filter((name) => /^assets\/.+\.(?:js|css|svg|json)$/u.test(name))
          .map(async (name) => {
            const file = path.join(options.dir!, name);
            const source = await readFile(file);
            if (source.length < 1024) return;
            await Promise.all([
              writeFile(`${file}.br`, await brotli(source)),
              writeFile(`${file}.gz`, await gzipped(source, { level: 9 })),
            ]);
          })
      );
    },
  };
}

function localeCatalogs(): Plugin {
  return {
    name: 'uimori-locale-catalogs',
    apply: 'build',
    async load(id) {
      if (!/[\\/]web[\\/]locales[\\/](?:ko|en|ja|zh)\.ts$/u.test(id)) return;
      const { module } = await runnerImport<{ default: Record<string, string> }>(id, {
        configFile: false,
      });
      return `export default ${JSON.stringify(module.default)};`;
    },
  };
}

export default defineConfig({
  plugins: [react(), localeCatalogs(), precompressedAssets()],
  root: 'web',
  build: { outDir: '../dist/web', emptyOutDir: true },
});
