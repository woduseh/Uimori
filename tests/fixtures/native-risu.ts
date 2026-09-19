import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { NativeRisuContent } from '../../core/risu-native.js';
import { readCharacterCard } from '../../server/character-card-file.js';
import { importRisuVariableDefaults } from '../../server/risu-variable-defaults.js';

/** Opt-in sample reader: keeps originals read-only and never exports authored text or image bytes. */
export function readNativeRisuSample(path: string): {
  native: NativeRisuContent;
  variables: Record<string, string>;
} {
  const card = readCharacterCard({ name: basename(path), uploadId: 'local-read-only' }, 'bot', () =>
    readFileSync(path)
  );
  const native: NativeRisuContent = {
    version: 1,
    card: card.nativeCard,
    module: card.nativeModule,
    assets: [],
    sourceHash: card.hash,
  };
  const extensions = native.card.extensions as
    | { risuai?: { defaultVariables?: unknown } }
    | undefined;
  return {
    native,
    variables: importRisuVariableDefaults(extensions?.risuai?.defaultVariables) ?? {},
  };
}
