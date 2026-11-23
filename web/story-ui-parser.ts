import { useEffect, useSyncExternalStore } from 'react';
import { type StoryUiSegment, untaggedStoryUiSegments } from '../core/story-ui-scan.js';

type Parse = (text: string) => StoryUiSegment[];
let parse: Parse | undefined;
let loading = false;
const listeners = new Set<() => void>();

function loadParser() {
  if (loading) return;
  loading = true;
  void import('../core/story-ui.js').then(
    (module) => {
      parse = module.parseStoryUi;
      for (const listener of listeners) listener();
    },
    () => {
      loading = false;
    }
  );
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
const currentParser = () => parse;

export const hasStoryUi = (text: string) => untaggedStoryUiSegments(text) === null;

export function useStoryUiParser(needed: boolean): Parse | undefined {
  const parser = useSyncExternalStore(subscribe, currentParser, currentParser);
  useEffect(() => {
    if (needed && !parser) loadParser();
  }, [needed, parser]);
  return parser;
}

export function useStoryUiSegments(text: string): StoryUiSegment[] | null {
  const untagged = untaggedStoryUiSegments(text);
  const parser = useStoryUiParser(!untagged);
  return untagged ?? (parser ? parser(text) : null);
}
