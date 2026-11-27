import { createApp } from '#dist/server/app.js';
import { randomUUID } from 'node:crypto';

const errors: string[] = [];
process.on('unhandledRejection', (error) => errors.push(String(error)));
const options = { dbPath: process.argv[2], buildId: 'background-failure', testMode: true };
const app = await createApp(options);
let runId: string | undefined;
let failureWrites = 0;
let responseStatus: number | undefined;
try {
  const title = 'Synthetic background failure';
  const owner = app.store.product.content({
    kind: 'bot',
    title,
    description: 'Synthetic',
    text: 'Synthetic background fixture.',
    loading: 'pinned',
    relatedIds: [],
  });
  const chat = app.store.createChat(title, { botId: owner.id });
  app.store.startRun = () => {
    throw new Error('Synthetic storage failure on start');
  };
  app.store.finishRun = () => {
    failureWrites++;
    throw new Error('Synthetic storage failure on terminal write');
  };
  const response = await app.inject({
    method: 'POST',
    url: `/api/chats/${chat.id}/runs`,
    payload: {
      request: 'Synthetic admitted request',
      expectedRevision: null,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: randomUUID(),
    },
  });
  responseStatus = response.statusCode;
  runId = response.json().id;
  await new Promise((resolve) => setImmediate(resolve));
} finally {
  await app.close();
}
const reopened = await createApp(options);
try {
  const recovered = reopened.store.run(runId!);
  const attempts = reopened.store.product.attempts(recovered.chatId);
  console.log(
    JSON.stringify({
      responseStatus,
      failureWrites,
      unhandledRejections: errors,
      recoveredStatus: recovered.status,
      attempts: attempts.length,
    })
  );
} finally {
  await reopened.close();
}
