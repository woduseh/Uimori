import type { CbsRange } from '../core/cbs-analysis.js';
import { markArrival } from './arrival-mark.js';

export const CODE_FIELD_REVEAL = 'code-field-reveal';
const FIELD_WAIT_MS = 1000;

export const codeFieldName = (section: string, item: number | null, field: string) =>
  `${section}:${item ?? ''}:${field}`;

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
