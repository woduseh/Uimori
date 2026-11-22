export type ImageNameTree = string[] | { [part: string]: ImageNameTree };

export const IMAGE_NAME_TREE_MINIMUM = 100;
const CARD_WORD_COVERAGE = 0.95;

const nameWords = (name: string) => name.toLowerCase().match(/[^_\-. ]+/gu) ?? [];

export function cardDefinesImageNames(names: readonly string[], cardText: string): boolean {
  const words = new Set(names.flatMap(nameWords));
  if (!words.size) return false;
  const text = cardText.toLowerCase();
  let missing = 0;
  for (const word of words) if (!text.includes(word)) missing++;
  return missing <= words.size * (1 - CARD_WORD_COVERAGE);
}

type Node = { children: Map<string, Node>; end: boolean };

function serialize(node: Node): ImageNameTree {
  const endings: string[] = node.end ? [''] : [];
  const branches: { [part: string]: ImageNameTree } = {};
  for (let [part, child] of node.children) {
    while (!child.end && child.children.size === 1) {
      const [nextPart, next] = [...child.children][0];
      part += nextPart;
      child = next;
    }
    if (child.children.size) branches[part] = serialize(child);
    else endings.push(part);
  }
  if (!Object.keys(branches).length) return endings;
  return endings.length ? { ...branches, '': endings } : branches;
}

export function imageNameTree(names: readonly string[]): ImageNameTree {
  const root: Node = { children: new Map(), end: false };
  for (const name of names) {
    let node = root;
    for (const part of name.match(/[^_\-. ]+[_\-. ]*|[_\-. ]+/gu) ?? []) {
      let child = node.children.get(part);
      if (!child) {
        child = { children: new Map(), end: false };
        node.children.set(part, child);
      }
      node = child;
    }
    node.end = true;
  }
  return serialize(root);
}

export const IMAGE_NAME_TREE_GUIDANCE =
  'A name tree lists image names without repeating shared beginnings. Join the keys from the top down to one entry of a list, exactly as written and adding nothing, to get one name. The key "" holds the entries that end a name at that level, and an empty entry means the keys so far are already a whole name.';
export const CARD_NAMED_IMAGES_GUIDANCE =
  "The card's own image instructions spell out these image names, so they are not listed here. Build names only the way those instructions allow.";
