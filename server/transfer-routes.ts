import type { FastifyInstance } from 'fastify';
import { transferEndpoints as endpoints } from '#contracts';
import { transferOperations as operations, transferRawInputs } from '#contracts/operations';
import type { ChatBackupImport } from '../core/chat-backup.js';
import {
  exportChatBackupArchive,
  importChatBackup,
  importChatBackupArchiveRequest,
} from './chat-backup.js';
import { importChatTranscript } from './chat-transcript.js';
import { databaseBackupStream } from './database-backup.js';
import { noStore, parseInput, registerEndpoint } from './endpoint.js';
import { exportManuscript, manuscriptExportMetadata } from './manuscript-export.js';
import { captureTransferResources, prepareNativeTransfer } from './native-transfer.js';
import {
  applyNativeArchive,
  exportNativeArchive,
  prepareNativeArchiveRequest,
} from './native-transfer-archive.js';
import { importNormalizedResourceBundle } from './resource-bundle.js';
import type { Store } from './store.js';

export function transferRoutes(
  app: FastifyInstance,
  store: Store,
  publish: (chatId: string) => void
): void {
  const published = <T extends { created: boolean; chat: { id: string } }>(result: T) => {
    if (result.created) publish(result.chat.id);
    return result;
  };
  registerEndpoint(app, endpoints.prepareFile, operations.prepareFile, prepareNativeTransfer);
  registerEndpoint(app, endpoints.applyFile, operations.applyFile, (input) =>
    importNormalizedResourceBundle(store, input)
  );
  registerEndpoint(app, endpoints.prepareArchive, operations.prepareArchive, (input, _, reply) =>
    prepareNativeArchiveRequest(store, input.uploadId, reply, 'resources')
  );
  registerEndpoint(app, endpoints.applyArchive, operations.applyArchive, (input) =>
    applyNativeArchive(store, input)
  );
  registerEndpoint(
    app,
    endpoints.prepareChatArchive,
    operations.prepareChatArchive,
    (input, _, reply) => prepareNativeArchiveRequest(store, input.uploadId, reply, 'chat')
  );
  registerEndpoint(app, endpoints.importChatArchive, operations.importChatArchive, (input) =>
    published<ChatBackupImport>(importChatBackupArchiveRequest(store, input))
  );
  registerEndpoint(app, endpoints.importChatBackup, operations.importChatBackup, async (input) =>
    published(await importChatBackup(store, input))
  );
  registerEndpoint(app, endpoints.importTranscript, operations.importTranscript, (input) =>
    published(importChatTranscript(store, input, 'library'))
  );
  registerEndpoint(app, endpoints.readManuscript, operations.readManuscript, ({ id }) =>
    manuscriptExportMetadata(store, id)
  );
  registerEndpoint(
    app,
    endpoints.exportManuscript,
    operations.exportManuscript,
    ({ id, ...rest }) => exportManuscript(store, id, rest)
  );

  app.post('/api/native-transfers/export-archive', { onSend: noStore }, (request, reply) => {
    const input = parseInput(transferRawInputs.exportArchive, request.body);
    return reply
      .type('application/zip')
      .header('Content-Disposition', 'attachment; filename="resources.uimori"')
      .send(exportNativeArchive(store, captureTransferResources(store, input)));
  });
  app.get('/api/chats/:id/backup-archive', { onSend: noStore }, (request, reply) => {
    const { id } = parseInput(transferRawInputs.chatDownload, {
      ...(request.query as object),
      ...(request.params as object),
    });
    return reply
      .type('application/zip')
      .header('Content-Disposition', 'attachment; filename="chat-backup.uimori"')
      .send(exportChatBackupArchive(store, id));
  });
  app.get('/api/backup', { onSend: noStore }, async (_request, reply) =>
    reply
      .header('Content-Disposition', 'attachment; filename="uimori-backup.sqlite"')
      .type('application/vnd.sqlite3')
      .send(await databaseBackupStream(store))
  );
}
