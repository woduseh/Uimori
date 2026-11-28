import { randomUUID } from 'node:crypto';
import { prepareRisuImport } from '../../../server/risu-import.js';
import { prepareRisuPresetImport } from '../../../server/risu-preset-import.js';
import { defineCommandSamples } from '../command-registry.js';

function importSample(document: unknown, preview: (value: unknown) => { digest: string }) {
  const source = {
    name: 'sample.json',
    base64: Buffer.from(JSON.stringify(document)).toString('base64'),
  };
  return {
    inputs: [
      {
        source,
        digest: preview({ source }).digest,
        allowPartial: true,
        idempotencyKey: randomUUID(),
      },
    ],
  };
}

export default defineCommandSamples({
  samples: {
    'risu.import.apply': () =>
      importSample(
        { spec: 'chara_card_v3', data: { name: 'Probe', description: 'Receipt probe' } },
        prepareRisuImport
      ),
    'risuPreset.import.apply': () =>
      importSample(
        {
          name: 'Probe',
          promptTemplate: [{ type: 'plain', type2: 'normal', role: 'system', text: 'Probe' }],
        },
        prepareRisuPresetImport
      ),
  },
});
