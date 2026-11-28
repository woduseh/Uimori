import { isDeepStrictEqual } from 'node:util';
import { chatSettingsOperations } from '#contracts/operations';
import { assertRevision } from '../app-errors.js';
import { defineCommand } from '../command.js';
import type { AppPorts } from '../store-ports.js';

type Ports = Pick<AppPorts, 'tx' | 'events' | 'chatGuard' | 'storyGuide'>;

export const updateStoryGuideCommand = defineCommand<Ports>()(
  chatSettingsOperations.updateStoryGuide,
  {
    guard(tx, ports, head) {
      ports.chatGuard.writableChat(tx, head.chatId);
      const current = ports.storyGuide.get(head.chatId);
      assertRevision(current.revision, head.expectedRevision);
      return { current };
    },
    apply(tx, ports, input, guarded) {
      const nextConfig =
        'config' in input ? input.config : { ...guarded.current.config, ...input.changes };
      if (!isDeepStrictEqual(guarded.current.config, nextConfig))
        ports.storyGuide.save(tx, input.chatId, guarded.current.revision + 1, nextConfig);
      return ports.storyGuide.detail(input.chatId);
    },
    afterCommit(ports, output, input, guarded) {
      if (output.revision !== guarded.current.revision) ports.events.publish(input.chatId);
    },
  }
);
