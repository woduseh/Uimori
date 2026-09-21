import type MarkdownIt from 'markdown-it';

type MarkdownItInstance = InstanceType<typeof MarkdownIt>;

/** Marks Markdown prose, not arbitrary author <p> elements or inline HTML widgets. */
export function markRisuReadingProse(md: MarkdownItInstance): void {
  for (const type of ['paragraph_open', 'heading_open', 'list_item_open']) {
    const original = md.renderer.rules[type];
    md.renderer.rules[type] = (tokens, index, options, env, renderer) => {
      const token = tokens[index]!;
      const tightItem =
        type === 'list_item_open' &&
        tokens[index + 1]?.type === 'paragraph_open' &&
        tokens[index + 1]?.hidden &&
        tokens[index + 3]?.type === 'paragraph_close' &&
        tokens[index + 4]?.type === 'list_item_close';
      const inline = tokens[index + (tightItem ? 2 : 1)];
      if (
        (type !== 'list_item_open' || tightItem) &&
        inline?.type === 'inline' &&
        !inline.children?.some((child) => child.type === 'html_inline')
      )
        token.attrSet('data-uimori-prose', '');
      return original
        ? original(tokens, index, options, env, renderer)
        : renderer.renderToken(tokens, index, options);
    };
  }
}
