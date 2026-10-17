import type { Content } from '../../core/product.js';
import type { Settings } from '../../core/types.js';
import type { ChatBackup, CopiedMessageState } from '../../core/chat-backup.js';
import type { ChatTranscript } from '../../core/chat-transcript.js';
import type { NativeTransferFile } from '../../core/native-transfer.js';
import type { Store } from '../../server/store.js';
import { captureChatCopy } from '../../server/chat-copy.js';
import { captureResourceBundle } from '../../server/resource-bundle.js';
import { encodedImage } from '../../server/image-storage.js';

function copiedMessageTexts(messages: readonly CopiedMessageState[]): string[] {
  return messages.flatMap((state) => [
    ...(state.changes?.updated.map((item) => item.message.text) ?? []),
    ...(state.authored?.messages.map((message) => message.data) ?? []),
  ]);
}

/** Include bytes referenced by authored Markdown/HTML even when they are not part of the bot. */
function transcriptImages(store: Store, transcripts: readonly ChatTranscript[]) {
  const hashes = new Set<string>();
  for (const transcript of transcripts)
    for (const entry of transcript.entries) {
      for (const image of entry.requestImages ?? []) {
        hashes.add(image.hash);
        hashes.add(image.input.hash);
      }
      for (const text of [entry.text, entry.translation ?? ''])
        for (const match of text.matchAll(/\/api\/package-image-blobs\/([a-f0-9]{64})/gu))
          hashes.add(match[1]);
    }
  return [...hashes].map((hash) => encodedImage(store.db, hash));
}

/** Test-only v1 JSON input, never a product output path or deprecated HTTP API. */
export function legacyResourceBundleFixture(
  store: Store,
  items: { kind: 'content' | 'prompt-preset'; id: string }[]
): NativeTransferFile {
  const metadata = captureResourceBundle(store, items);
  return {
    ...metadata,
    images: metadata.images.map((image) => encodedImage(store.db, image.hash)),
  };
}

/** Internal copy state stays supported; these fixtures exercise its old JSON envelope. */
export function legacyChatBackupFixture(store: Store, chatId: string): ChatBackup {
  const copy = captureChatCopy(store, chatId);
  const items = [
    ...new Map(
      copy.transcript.packageAttachments.map(({ id }) => [id, { kind: 'content' as const, id }])
    ).values(),
  ];
  const prompt = copy.state.profile.pinned?.mainPromptPresetId;
  const resources = legacyResourceBundleFixture(store, [
    ...items,
    ...(prompt ? [{ kind: 'prompt-preset' as const, id: prompt }] : []),
  ]);
  if (copy.state.profile.pinned) delete copy.state.profile.pinned.mainModel;
  const media = transcriptImages(store, [
    {
      ...copy.transcript,
      entries: [
        ...copy.transcript.entries,
        ...copiedMessageTexts(copy.state.messages ?? []).map((text) => ({
          request: '',
          text,
          translation: null,
        })),
      ],
    },
  ]);
  resources.images = [
    ...new Map([...resources.images, ...media].map((image) => [image.hash, image])).values(),
  ];
  return {
    format: 'uimori-personal-chat',
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    title: copy.transcript.title,
    resources,
    chats: [copy],
    notices: [],
  };
}

/** Small explicit legacy file for browser import tests, independent of any backup exporter. */
export function legacyChatBackupWithBot(
  bot: Content,
  settings: Settings,
  scene?: { title: string; text: string; translation: string }
): ChatBackup {
  return {
    format: 'uimori-personal-chat',
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    title: scene?.title ?? 'Legacy empty conversation',
    resources: {
      format: 'uimori-native-transfer',
      version: 1,
      roots: [{ kind: 'content', key: 'legacy-bot' }],
      contents: [
        {
          key: 'legacy-bot',
          modules: [],
          source: {
            id: bot.id,
            revision: bot.revision,
            kind: bot.kind,
            title: bot.title,
            description: bot.description,
            text: bot.text,
            loading: bot.loading,
            relatedIds: [],
            package: bot.package,
          },
        },
      ],
      prompts: [],
      images: [],
    },
    chats: [
      {
        transcript: {
          format: 'uimori-chat-transcript',
          version: 2,
          exportedAt: '2026-01-01T00:00:00.000Z',
          title: scene?.title ?? 'Legacy empty conversation',
          packageAttachments: [{ id: bot.id, revision: bot.revision, role: 'bot' }],
          entries: scene
            ? [{ request: 'Write', text: scene.text, translation: scene.translation }]
            : [],
          notes: [],
        },
        state: {
          variables: { revision: 0, values: {} },
          checkpoints: scene ? [null] : [],
          settings,
          profile: { image: false, imageTranslation: false },
        },
        illustrations: [],
      },
    ],
    notices: [],
  };
}
