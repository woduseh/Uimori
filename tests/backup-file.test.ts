import { expect, test } from 'vitest';
import { inspectBackupFile } from '../web/backup-file.js';
import { nativeArchiveStream } from '../server/native-transfer-archive-codec.js';
import { shownRejection } from './shown-error.js';

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

test('backup entry follows archive and legacy JSON contents rather than the filename', async () => {
  for (const kind of ['resources', 'chat'] as const)
    expect(await inspectBackupFile(await archive(kind, 'renamed.json'))).toEqual({
      kind,
      archive: true,
    });
  for (const [format, kind] of [
    ['uimori-native-transfer', 'resources'],
    ['uimori-personal-chat', 'chat'],
  ] as const) {
    const value = { format, version: 1 };
    const inspected = await inspectBackupFile(new File([JSON.stringify(value)], 'renamed.uimori'));
    expect(inspected).toEqual({
      kind,
      archive: false,
      [kind === 'chat' ? 'backup' : 'file']: value,
    });
  }
});

test('SQLite backups use server restore even above the portable archive size limit', async () => {
  const file = new File(['SQLite format 3\0', new Uint8Array(100)], 'renamed.json');
  Object.defineProperty(file, 'size', { value: 1024 * 1024 * 1024 });
  expect(await inspectBackupFile(file)).toEqual({ kind: 'database' });
});

test('unknown or incomplete files stay outside both apply flows', async () => {
  for (const text of [
    '{}',
    'not a backup',
    '{"format":"uimori-chat-transcript","version":1}',
    'PK\u0003\u0004',
  ])
    expect(
      await shownRejection(inspectBackupFile(new File([text], 'backup.uimori'))),
      text
    ).toMatch(/백업.*파일/);
});
