import type { Branch, Library, ModelPreset } from '../core/product.js';
import type { ReaderDetail } from '../core/types.js';

/** One naming everywhere: preset title, then the connection title; model IDs stay in the editor. */
export function modelLabel(model: ModelPreset, library: Library | null) {
  const connection = library?.connections.find((item) => item.id === model.connectionId);
  return `${model.title} · ${connection?.title ?? '프로바이더 확인 필요'}`;
}

export function branchLabel(branch: Branch, detail: ReaderDetail) {
  if (branch.default) return '기본 전개';
  if (branch.title === '기본 분기') return '이전 기본 전개';
  if (branch.title !== '후보 분기') return branch.title;
  // Run order is creation order; adding a candidate never renumbers earlier ones.
  const candidates =
    detail.reader.candidateBranches ??
    detail.runs.flatMap((run) =>
      run.snapshot.candidateOf && run.snapshot.branchId ? [run.snapshot.branchId] : []
    );
  const index = candidates.indexOf(branch.id);
  return index >= 0 ? `다른 응답 ${index + 1}` : '보관된 다른 응답';
}
