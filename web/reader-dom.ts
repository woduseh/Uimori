// https://dom.spec.whatwg.org/#dom-node-contains (2026-11-20): contains() tests for an inclusive
// descendant, which does not cross a shadow root.
export function readerContains(container: HTMLElement, node: Node | null): boolean {
  while (node) {
    if (container.contains(node)) return true;
    const root = node.getRootNode();
    node = root instanceof ShadowRoot ? root.host : null;
  }
  return false;
}

export function selectedReaderText(container: HTMLElement | null): string {
  const selection = window.getSelection();
  if (!container || !selection || selection.isCollapsed) return '';
  const shadowRoots = [...container.querySelectorAll('.risu-message-surface')]
    .map((host) => host.shadowRoot)
    .filter((root): root is ShadowRoot => root !== null);
  const [range] = selection.getComposedRanges({ shadowRoots });
  return range &&
    readerContains(container, range.startContainer) &&
    readerContains(container, range.endContainer)
    ? selection.toString().trim()
    : '';
}

export function readingPositionElements(container: HTMLElement): HTMLElement[] {
  const elements: HTMLElement[] = [];
  for (const block of container.querySelectorAll<HTMLElement>(
    '[data-block-anchor], .helper-message'
  )) {
    const paragraphs = [
      ...block.querySelectorAll<HTMLElement>('.reading-markdown-content [data-uimori-prose]'),
      ...[...block.querySelectorAll('.risu-message-surface')].flatMap((host) => [
        ...(host.shadowRoot?.querySelectorAll<HTMLElement>('[data-uimori-prose]') ?? []),
      ]),
    ];
    elements.push(...(paragraphs.length ? paragraphs : [block]));
  }
  return elements;
}
