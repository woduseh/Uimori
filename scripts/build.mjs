import path from 'node:path';
import { command, requireCommand, fingerprint, distHash, root, json, removeOwned } from './lib.mjs';

try {
  const before = await fingerprint();
  await removeOwned(root, path.join(root, 'dist'));
  for (const args of [
    ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.server.json'],
    ['node_modules/vite/bin/vite.js', 'build'],
  ]) {
    const result = await command(args);
    process.stdout.write(result.output);
    requireCommand(result);
  }
  const after = await fingerprint();
  if (before.hash !== after.hash)
    throw new Error('Source changed while building; rerun after edits finish.');
  const manifest = {
    buildId: after.hash,
    sourceHash: after.hash,
    distHash: await distHash(),
    builtAt: new Date().toISOString(),
    inputs: after.files,
    lineEndings: after.lineEndings,
    node: process.version,
  };
  await json(path.join(root, 'dist/build-identity.json'), manifest);
  console.log(`Build identity ${manifest.buildId}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
