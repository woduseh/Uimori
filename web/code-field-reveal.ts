import type { CbsRange } from '../core/cbs-analysis.js';
import { markArrival, markArrivalWhenShown } from './arrival-mark.js';

export const CODE_FIELD_REVEAL = 'code-field-reveal';
const FIELD_WAIT_MS = 1000;

export type EditorJumpTarget = {
  section: string;
  item: number | null;
  field: string | null;
  range: CbsRange;
};
export type EditorReveal = EditorJumpTarget & { epoch: number };

export const codeFieldName = (section: string, item: number | null, field: string) =>
  `${section}:${item ?? ''}:${field}`;

export function codeFieldParts(name: string) {
  const match = /^([^:]+):(\d*):(.+)$/u.exec(name);
  if (!match) return null;
  return {
    section: match[1]!,
    item: match[2] ? Number(match[2]) : null,
    field: match[3]!,
  };
}

export function revealCodeField(
  container: () => Element | null,
  name: string,
  range: CbsRange,
  fallback: string,
  signal: AbortSignal
) {
  const deadline = performance.now() + FIELD_WAIT_MS;
  const step = () => {
    if (signal.aborted) return;
    const root = container();
    const field = root?.querySelector(`[data-code-field="${CSS.escape(name)}"]`);
    if (field?.getClientRects().length) {
      markArrival(field);
      field.dispatchEvent(new CustomEvent<CbsRange>(CODE_FIELD_REVEAL, { detail: range }));
      return;
    }
    if (performance.now() < deadline) {
      requestAnimationFrame(step);
      return;
    }
    const target = root?.querySelector(fallback) ?? root;
    if (target?.getClientRects().length) markArrival(target);
  };
  requestAnimationFrame(step);
}

export function revealEditorTarget(
  container: () => Element | null,
  target: EditorJumpTarget,
  fallback: string,
  signal: AbortSignal
) {
  if (target.field !== null) {
    revealCodeField(
      container,
      codeFieldName(target.section, target.item, target.field),
      target.range,
      fallback,
      signal
    );
    return;
  }
  requestAnimationFrame(() =>
    markArrivalWhenShown(() => {
      const root = container();
      return (target.item === null ? null : root?.querySelector(fallback)) ?? root;
    }, signal)
  );
}
