import type { Resource } from '../../core/types.js';

export function syntheticResources(chatId: string): Resource[] {
  return [
    {
      id: `${chatId}:harbor`,
      chatId,
      kind: 'lore',
      revision: 1,
      title: 'Lantern Harbor at dusk',
      description: 'Harbor geography, lamps, and the old ferry bell.',
      text: 'Lantern Harbor has a blue ferry bell beside its eastern pier. At dusk the keeper lights seven amber lamps. Mira knows that the bell has been silent since the last winter storm.',
    },
    {
      id: `${chatId}:craft`,
      chatId,
      kind: 'skill',
      revision: 1,
      title: 'Ground a quiet scene',
      description: 'Writing craft: concrete sensory detail and an open decision.',
      text: 'Choose a concrete sensory detail already available in the scene. Let an observed object carry tension. End with an opening for the reader rather than deciding their response.',
    },
    {
      id: `${chatId}:observatory`,
      chatId,
      kind: 'lore',
      revision: 2,
      title: 'Hilltop observatory',
      description: 'A separate hilltop location, accessible through additional research.',
      text: 'Above the harbor, the hilltop observatory has a green copper dome. A narrow footpath joins it to the eastern pier.',
    },
  ];
}
