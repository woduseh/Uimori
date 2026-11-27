import { parseOwnJson } from './json.js';
import { useEffect, useMemo, useState } from 'react';
import {
  createCbsReferenceIndexer,
  nativeRisuContentReferenceInput,
  nativeRisuPresetReferenceInput,
  type CbsReferenceIndex,
  type CbsReferenceInput,
} from '../core/cbs-references.js';
import type { RisuContentSource } from '../core/risu-native.js';
import type { CbsNames } from './CodeField.js';

const REFERENCE_INDEX_DELAY_MS = 300;

function useIndex<T>(source: T, input: (source: T) => CbsReferenceInput) {
  const [indexer] = useState(createCbsReferenceIndexer);
  const [settled, setSettled] = useState(source);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(source), REFERENCE_INDEX_DELAY_MS);
    return () => clearTimeout(timer);
  }, [source]);
  return useMemo(() => indexer(input(settled)), [indexer, input, settled]);
}

export const useContentReferences = (native: RisuContentSource) =>
  useIndex(native, nativeRisuContentReferenceInput);

export const usePresetReferences = (preset: Record<string, unknown>) =>
  useIndex(preset, nativeRisuPresetReferenceInput);

export function useCbsNames(index: CbsReferenceIndex): CbsNames {
  const names: CbsNames = { chat: [], temp: [], global: [], toggles: [] };
  for (const entry of index.variables) {
    names[entry.scope].push(entry.name);
    if (entry.toggle !== null) names.toggles.push(entry.toggle);
  }
  const key = JSON.stringify(names);
  return useMemo(() => parseOwnJson(key) as CbsNames, [key]);
}
