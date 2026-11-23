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

export function useStoryUiSegments(text: string): StoryUiSegment[] | null {
  const parser = useSyncExternalStore(subscribe, currentParser, currentParser);
  const untagged = untaggedStoryUiSegments(text);
  const tagged = !untagged;
  useEffect(() => {
    if (tagged && !parser) loadParser();
  }, [tagged, parser]);
  return untagged ?? (parser ? parser(text) : null);
}
