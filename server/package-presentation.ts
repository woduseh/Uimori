import { createHash } from 'node:crypto';
import { ContentPackageError } from '../core/content-package.js';
import { compiledPackages } from '../core/package-context.js';
import { renderPackageStateView } from '../core/package-runtime.js';
import type { RunSnapshot } from '../core/types.js';
import { applyPackageTransforms } from './package-transforms.js';
import { packageImages } from '../core/package-images.js';
import { applyPromptDisplayTransforms, currentPromptInputTransform } from './prompt-transforms.js';

export type PackagePresentationSource = {
  id: string;
  chatId: string;
  hash: string;
  text: string;
  translation?: { text: string; sourceRevision: string; sourceHash: string };
};
/** The route supplies an exact source and its originating Run snapshot. No current library reads. */
export async function buildPackagePresentation(
  snapshot: RunSnapshot,
  source: PackagePresentationSource,
  state?: { sourceRevision: string; sourceHash: string; values: Record<string, unknown> },
  options: {
    skipSourceTransforms?: boolean;
    /** Stored output/display hook result for this exact response; never recomputed here. */
    displayEdit?: { text: string; changed: boolean; applied: string[] };
  } = {}
) {
  if (
    source.chatId !== snapshot.chatId ||
    createHash('sha256').update(source.text).digest('hex') !== source.hash
  )
    throw new ContentPackageError('PACKAGE_PRESENTATION_SOURCE_MISMATCH');
  if (
    source.translation &&
    (source.translation.sourceRevision !== source.id ||
      source.translation.sourceHash !== source.hash)
  )
    throw new ContentPackageError('PACKAGE_PRESENTATION_TRANSLATION_MISMATCH');
  if (state && (state.sourceRevision !== source.id || state.sourceHash !== source.hash))
    throw new ContentPackageError('PACKAGE_PRESENTATION_STATE_MISMATCH');
  // Presentation uses all attachments even when persona reference is disabled for main writing.
  const packages = compiledPackages(snapshot, 'status');
  const rules = packages.flatMap((p) => p.transforms);
  const issues: string[] = [];
  const display = async (text: string, role: 'user' | 'assistant') => {
    try {
      return await applyPromptDisplayTransforms(snapshot, text, role);
    } catch {
      issues.push('프롬프트의 표시 변환을 적용하지 못해 원래 내용을 표시해요.');
      return { text, changed: false, applied: [] as string[] };
    }
  };
  // Risu applies the imported output/display callbacks before its display regex; keep that order.
  const edited = options.skipSourceTransforms ? undefined : options.displayEdit;
  const presetDisplay = options.skipSourceTransforms
    ? { text: source.text, changed: false, applied: [] as string[] }
    : await display(edited?.text ?? source.text, 'assistant');
  const packageDisplay = await applyPackageTransforms(presetDisplay.text, rules, 'source');
  const original = {
    text: packageDisplay.text,
    changed: packageDisplay.text !== source.text,
    applied: [...(edited?.applied ?? []), ...presetDisplay.applied, ...packageDisplay.applied],
  };
  const request = await display(snapshot.request, 'user');
  const inputTransform = currentPromptInputTransform(snapshot);
  if (snapshot.promptInputTransforms?.error)
    issues.push('전송 전 텍스트 변환에 실패해 원래 입력으로 진행했어요.');
  if (snapshot.extensionMessageEdit?.skipped)
    issues.push(
      '가져온 자료의 전송문 편집은 대화 읽기 허용이 없거나 대화가 실행 한도를 넘어 건너뛰었어요. 원문 대화를 그대로 보냈어요.'
    );
  const translation = source.translation
    ? await applyPackageTransforms(source.translation.text, rules, 'translation')
    : undefined;
  const shownText = `${original.text}\n${translation?.text ?? ''}`;
  const inlineImageUrls = snapshot.profile
    ? [
        ...new Set(
          packageImages(snapshot.profile)
            .filter((asset) => asset.allowedUse !== 'profile' && shownText.includes(asset.url))
            .map((asset) => asset.url)
        ),
      ]
    : [];
  const views = packages
    .filter((p) => p.stateView)
    .map((p) => ({
      packageId: p.package.id,
      revision: p.package.revision,
      role: p.attachment.role,
      ...renderPackageStateView(p.stateView!, state?.values ?? {}),
    }));
  return {
    sourceRevision: source.id,
    sourceHash: source.hash,
    format: 'plain-text' as const,
    ...(inlineImageUrls.length ? { inlineImageUrls } : {}),
    original,
    request,
    ...(inputTransform ? { inputTransform } : {}),
    issues,
    ...(translation ? { translation } : {}),
    stateViews: views,
  };
}
