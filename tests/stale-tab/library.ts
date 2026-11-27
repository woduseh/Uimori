import { randomUUID } from 'node:crypto';
import { allEndpoints } from '#contracts';
import { bot, conflict, domainCases, read, removed, singletonExemption } from './harness.js';

const organization = () =>
  read<{ revision: number; folders: { id: string; title: string }[] }>(
    allEndpoints.library.readOrganization
  );
async function removedFolders(count: number) {
  const ids: string[] = [];
  for (let index = 0; index < count; index++) {
    const title = `Stale tab folder ${randomUUID()}`;
    const created = await read<{ folders: { id: string; title: string }[] }>(
      allEndpoints.library.createFolder,
      { expectedRevision: (await organization()).revision, category: 'bot', title }
    );
    ids.push(created.folders.find((folder) => folder.title === title)!.id);
  }
  const kept = await organization();
  const gone = ids.pop()!;
  await read(allEndpoints.library.deleteFolder, { id: gone, expectedRevision: kept.revision });
  return { gone, kept: ids, revision: (await organization()).revision };
}

export const libraryCases = domainCases('library', {
  createFolder: { exempt: singletonExemption },
  updateFolder: {
    cases: [
      {
        when: 'a folder another tab deleted',
        arrange: async () => {
          const { gone, kept, revision } = await removedFolders(2);
          const rename = { expectedRevision: revision, title: 'Renamed' };
          return { input: { ...rename, id: gone }, control: { ...rename, id: kept[0] } };
        },
        answer: conflict,
      },
      {
        when: 'an order anchor another tab deleted',
        arrange: async () => {
          const { gone, kept, revision } = await removedFolders(3);
          const order = { id: kept[0], expectedRevision: revision };
          return {
            input: { ...order, beforeFolderId: gone },
            control: { ...order, beforeFolderId: kept[1] },
          };
        },
        answer: conflict,
      },
    ],
  },
  deleteFolder: {
    cases: [
      {
        when: 'a folder another tab deleted',
        arrange: async () => {
          const { gone, kept, revision } = await removedFolders(2);
          return {
            input: { id: gone, expectedRevision: revision },
            control: { id: kept[0], expectedRevision: revision },
          };
        },
        answer: conflict,
      },
    ],
  },
  moveItems: {
    cases: [
      {
        when: 'a destination folder another tab deleted',
        arrange: async () => {
          const item = bot();
          const { gone, kept, revision } = await removedFolders(2);
          const move = {
            expectedRevision: revision,
            category: 'bot',
            items: [{ kind: 'content', id: item.id }],
          };
          return { input: { ...move, folderId: gone }, control: { ...move, folderId: kept[0] } };
        },
        answer: conflict,
      },
      {
        when: 'an item another tab deleted',
        arrange: async () => {
          const live = bot();
          const gone = bot();
          removed('content', gone);
          const move = {
            expectedRevision: (await organization()).revision,
            category: 'bot',
            folderId: null,
          };
          return {
            input: { ...move, items: [{ kind: 'content', id: gone.id }] },
            control: { ...move, items: [{ kind: 'content', id: live.id }] },
          };
        },
        answer: conflict,
      },
    ],
  },
});
