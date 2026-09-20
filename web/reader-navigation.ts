export type ReaderView = Readonly<{
  chat: string;
  branch: string;
  source: string;
  destination: 'story' | 'library';
}>;
export type ReaderNavigation = ReaderView & { readonly epoch: number };
export type ReaderNavigationAction =
  | { kind: 'chat'; chat: string }
  | { kind: 'branch'; branch: string; source: string }
  | { kind: 'source'; source: string }
  | { kind: 'library' }
  | { kind: 'restore'; view: ReaderView }
  | { kind: 'chat-deleted' }
  | { kind: 'branch-deleted' }
  | { kind: 'bind-default'; branch: string }
  | { kind: 'rebase-source'; source: string };

/** User navigation changes intent even for A -> B -> A or a repeated source selection.
 * Server reconciliation changes the address, not the reader's intent.
 */
export function transitionReaderNavigation(
  current: ReaderNavigation,
  action: ReaderNavigationAction
): ReaderNavigation {
  const epoch = current.epoch + 1;
  switch (action.kind) {
    case 'chat':
      return { chat: action.chat, branch: '', source: '', destination: 'story', epoch };
    case 'branch':
      return { ...current, branch: action.branch, source: action.source, epoch };
    case 'source':
      return { ...current, source: action.source, epoch };
    case 'library':
      return { ...current, destination: 'library', epoch };
    case 'restore':
      return { ...action.view, epoch };
    case 'chat-deleted':
      return { chat: '', branch: '', source: '', destination: 'library', epoch };
    case 'branch-deleted':
      return { ...current, branch: '', source: '', epoch };
    case 'bind-default':
      // A late reconciliation cannot replace an explicitly selected branch.
      return current.branch ? current : { ...current, branch: action.branch };
    case 'rebase-source':
      return { ...current, source: action.source };
  }
}
