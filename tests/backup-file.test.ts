import { expect, test } from 'vitest';
import { inspectBackupFile } from '../web/backup-file.js';
import { nativeArchiveStream } from '../server/native-transfer-archive-codec.js';

async function archive(kind: 'resources' | 'chat', name: string) {
  const chunks: ArrayBuffer[] = [];
  for await (const chunk of nativeArchiveStream([
    {
      name: 'manifest.json',
      read: () => Buffer.from(JSON.stringify({ format: 'uimori-archive', version: 1, kind })),
    },
  ]))
    chunks.push(new Uint8Array(chunk).buffer);
  return new File(chunks, name);
}

test.each(['resources', 'chat'] as const)(
  'backup entry reads %s archive contents despite a JSON filename',
  async (kind) => {
    expect(await inspectBackupFile(await archive(kind, 'renamed.json'))).toEqual({
      kind,
      archive: true,
    });
  }
);

test.each([
  ['uimori-native-transfer', 'resources'],
  ['uimori-personal-chat', 'chat'],
] as const)(
  'backup entry retains legacy %s JSON despite an archive filename',
  async (format, kind) => {
    const value = { format, version: 1 };
    const inspected = await inspectBackupFile(new File([JSON.stringify(value)], 'renamed.uimori'));
    expect(inspected).toEqual({
      kind,
      archive: false,
      [kind === 'chat' ? 'backup' : 'file']: value,
    });
  }
);

test('SQLite backups use server restore even above the portable archive size limit', async () => {
  const file = new File(['SQLite format 3\0', new Uint8Array(100)], 'renamed.json');
  Object.defineProperty(file, 'size', { value: 1024 * 1024 * 1024 });
  expect(await inspectBackupFile(file)).toEqual({ kind: 'database' });
});

test.each([
  '{}',
  'not a backup',
  '{"format":"uimori-chat-transcript","version":1}',
  'PK\u0003\u0004',
])('unknown or incomplete files stay outside both apply flows: %s', async (text) => {
  await expect(inspectBackupFile(new File([text], 'backup.uimori'))).rejects.toThrow(/백업.*파일/);
});
