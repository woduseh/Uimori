import { splitSource, validatePresentation } from '../core/auxiliary.js';
import { imageHandoffSource } from '../core/risu-image-handoff.js';
import { nativeRisuAssetNames } from '../core/risu-native.js';
import { randomUUID } from 'node:crypto';
import type { RunSnapshot } from '../core/types.js';
import type { Store } from './store.js';
import { imageCatalog, imageTargetSource, latestImageJob } from './package-images.js';
import { nativeRisuContext, nativeRisuPackages } from './risu-native-context.js';
import { nativeCatalogImageTags, nativeImageTag } from './risu-native-image-tags.js';
import { evaluateNativeRisuFields, type NativeRisuCbsContext } from './risu-native-cbs.js';
import { imageOwnerDisplayText } from '../core/image-placement.js';
import { successfulTranslation } from './translation-artifacts.js';
import { packageImages } from '../core/package-images.js';

async function imageGuidanceByPackage(
  snapshot: RunSnapshot,
  viewport?: NativeRisuCbsContext['viewport']
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (!snapshot.profile?.image) return result;
  const context = nativeRisuContext(snapshot);
  if (!context) return result;
  const fields: Record<string, string> = {};
  const selections: { owner: string; field: string; begin: string; end: string; start: number }[] =
    [];
  const marker = `UIMORI_IMAGE_${randomUUID()}_`;
  for (const { pkg, native } of nativeRisuPackages(snapshot)) {
    const owner = `${pkg.id}@${pkg.revision}`;
    const ranges = (pkg.imageHandoff?.ranges ?? []).filter(
      (range) =>
        range.enabled &&
        imageHandoffSource(native, range.field).slice(range.start, range.end) === range.text
    );
    for (const sourceField of new Set(ranges.map((range) => range.field))) {
      const field = `field-${Object.keys(fields).length}`;
      let source = imageHandoffSource(native, sourceField);
      for (const range of ranges
        .filter((range) => range.field === sourceField)
        .sort((a, b) => b.start - a.start)) {
        const index = selections.length;
        const begin = `${marker}${index}_BEGIN`,
          end = `${marker}${index}_END`;
        selections.push({ owner, field, begin, end, start: range.start });
        source =
          source.slice(0, range.start) +
          begin +
          source.slice(range.start, range.end) +
          end +
          source.slice(range.end);
      }
      fields[field] = source;
    }
  }
  if (!selections.length) return result;
  // Evaluate each original field before extracting its selected ranges. Otherwise an outer CBS
  // condition (e.g. the two age routes in Harper) is lost when its inner section is moved.
  const parsed = await evaluateNativeRisuFields({
    native: context.native,
    fields,
    context: {
      ...context,
      viewport,
      variables: { ...context.variables, ...snapshot.nativeRisuExecution?.output?.variables },
    },
  });
  for (const { owner, field, begin, end } of selections.sort(
    (a, b) => Number(a.field.slice(6)) - Number(b.field.slice(6)) || a.start - b.start
  )) {
    const text = parsed.fields[field];
    let cursor = 0;
    for (;;) {
      const start = text.indexOf(begin, cursor);
      if (start === -1) break;
      const finish = text.indexOf(end, start + begin.length);
      if (finish === -1) break;
      const selected = text.slice(start + begin.length, finish).trim();
      if (selected) result.set(owner, [result.get(owner), selected].filter(Boolean).join('\n\n'));
      cursor = finish + end.length;
    }
  }
  return result;
}

export async function nativeImageGuidance(snapshot: RunSnapshot): Promise<string> {
  return [...(await imageGuidanceByPackage(snapshot)).values()].join('\n\n');
}

/** Inserts only validated annotations into a display copy. Source text/hash never change. */
export async function nativeImageDisplayText(
  store: Store,
  snapshot: RunSnapshot,
  sourceId: string,
  mode: 'original' | 'translation' = 'original',
  viewport?: NativeRisuCbsContext['viewport']
): Promise<{ text: string; issues: string[] }> {
  const source = store.source(sourceId);
  if (source.chatId !== snapshot.chatId) throw new Error('NATIVE_IMAGE_SOURCE_SCOPE');
  const job = latestImageJob(store, sourceId, mode);
  const fallback =
    mode === 'original' ? source.text : (successfulTranslation(store, source)?.result?.text ?? '');
  if (!snapshot.profile?.image) return { text: fallback, issues: [] };
  const context = nativeRisuContext(snapshot);
  const assets = [
    ...store.product.assets(source.chatId).filter((asset) => asset.allowedUse !== 'profile'),
    ...packageImages(snapshot.profile).filter(
      (asset) =>
        asset.allowedUse !== 'profile' &&
        snapshot.profile!.packages?.find((pkg) => pkg.id === asset.packageOwner?.id)
          ?.portraitImageId !== asset.packageOwner?.imageId
    ),
    ...(job?.status === 'completed' && job.sourceHash === source.hash
      ? imageCatalog(job.input)
      : []),
  ];
  const taggedText =
    job?.status === 'completed' && job.sourceHash === source.hash && job.result?.annotations
      ? imageTargetSource(store, job, true).text
      : fallback;
  const authoredTags = context
    ? await nativeCatalogImageTags({
        native: context.native,
        context: { ...context, viewport },
        text: taggedText,
        urls: assets.map((asset) => asset.url),
      })
    : [];
  const display = (text: string) =>
    authoredTags.reduce(
      (value, tag) => value.split(tag).join(''),
      imageOwnerDisplayText(text, snapshot.profile!, assets)
    );
  if (
    !job ||
    job.status !== 'completed' ||
    job.sourceHash !== source.hash ||
    !job.result?.annotations
  )
    return { text: display(fallback), issues: [] };
  const target = imageTargetSource(store, job, true);
  const displayText = display(target.text);
  if (!context) return { text: displayText, issues: [] };
  const catalog = imageCatalog(job.input);
  const validated = validatePresentation(
    target,
    {
      sourceRevision: target.id,
      sourceHash: target.hash,
      entries: job.result.annotations.map(({ caption: _caption, ...entry }) => entry),
    },
    catalog
  );
  const blocks = splitSource(target),
    issues: string[] = [];
  let guidance: Map<string, string>;
  try {
    guidance = await imageGuidanceByPackage(snapshot, viewport);
  } catch {
    return { text: displayText, issues: ['native-image-guidance-evaluation'] };
  }
  const inserts: { offset: number; text: string; order: number }[] = [];
  for (const [order, annotation] of validated.entries.entries()) {
    const asset = catalog.find((entry) => entry.ref === annotation.assetRef)!;
    const owner = /^package:([^:]+):(bot|persona|module):([^:]+)$/u.exec(asset.ref);
    const pkg =
      owner &&
      snapshot.profile?.packages?.find(
        (entry) => entry.id === owner[1] && entry.revision === asset.revision
      );
    const original =
      pkg?.nativeRisu && owner
        ? pkg.nativeRisu.assets.find((entry) => entry.imageId === owner[3])
        : undefined;
    const instructions = pkg?.imageHandoff ? (guidance.get(`${pkg.id}@${pkg.revision}`) ?? '') : '';
    let tag: string | null = null;
    if (pkg?.imageHandoff) {
      if (!original) {
        issues.push(`native-image-tag-unavailable:${asset.ref}`);
        continue;
      }
      try {
        tag = await nativeImageTag({
          native: context.native,
          context: {
            ...context,
            viewport,
            displaying: true,
            messageIndex: context.messages.length - 1,
          },
          name: original.name,
          url: asset.url,
          templates: pkg.imageHandoff.tagTemplates,
          guidance: instructions,
        });
      } catch {
        issues.push(`native-image-tag-evaluation:${asset.ref}`);
      }
      if (!tag) {
        issues.push(`native-image-tag-unavailable:${asset.ref}`);
        continue;
      }
    } else if (pkg?.nativeRisu && original) {
      const alias = nativeRisuAssetNames(pkg.nativeRisu, original).find(
        (name) => context.assetUrls[name] === asset.url && !/[{}\r\n]/u.test(name)
      );
      if (alias) tag = `{{img::${alias}}}`;
    }
    // Chat-level images and package images without a usable native alias still have an exact,
    // host-validated URL. Markdown keeps them in the normal Risu message without inventing syntax.
    if (!tag && annotation.presentationIntent === 'inline') tag = `![](${asset.url})`;
    if (!tag) continue;
    if (displayText.includes(tag)) continue;
    const block = blocks.find((entry) => entry.anchor === annotation.blockAnchor)!;
    const before = /before (?:the )?paragraph|문단.*앞/iu.test(instructions);
    inserts.push({ offset: before ? block.start : block.end, text: `\n\n${tag}\n\n`, order });
  }
  // Anchors still belong to the exact stored target. Remove authored catalog tags after insertion
  // by projecting each original text segment, so deleting a tag never shifts a saved anchor.
  let text = '';
  let cursor = 0;
  for (const entry of inserts.sort((a, b) => a.offset - b.offset || a.order - b.order)) {
    text += display(target.text.slice(cursor, entry.offset)) + entry.text;
    cursor = entry.offset;
  }
  text += display(target.text.slice(cursor));
  return { text, issues: [...new Set(issues)] };
}
