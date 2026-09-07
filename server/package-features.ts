import { isDeepStrictEqual } from 'node:util';
import type { FastifyInstance } from 'fastify';
import { validateContentPackage, validatePackageAttachment, type ContentPackage, type PackageAttachment } from '../core/content-package.js';
import type { ChatProfile, Content, ProfileSnapshot } from '../core/product.js';
import { validatePackageHiddenStory } from '../core/package-features.js';
import { validateHiddenStoryConfig } from '../core/hidden-story.js';
import { resolvePromptValues } from '../core/prompt-program.js';
import type { ProductStore } from './product-store.js';
import { fields, record } from './product-store.js';
import { validateHiddenStorySelection } from './hidden-story.js';
import { HttpError, type Store } from './store.js';
import { assertPackageImages } from './package-images.js';

/** Deterministic, revision-pinned module closure; shared requirements execute once. */
export function resolvePackageModules(product: ProductStore, roots: PackageAttachment[]): { attachments: PackageAttachment[]; packages: ContentPackage[] } {
  const attachments: PackageAttachment[] = [], packages: ContentPackage[] = [], seen = new Map<string,number>(), active = new Set<string>();
  const visit = (raw: PackageAttachment, depth: number) => {
    const ref = validatePackageAttachment(raw), key = `${ref.id}:${ref.role}`, identity = `${ref.id}@${ref.revision}`;
    if (active.has(identity)) throw new HttpError(400,'Package module dependency cycle');
    if (seen.has(key)) { if (seen.get(key) !== ref.revision) throw new HttpError(400,'Package module revision conflict'); return; }
    if (depth > 20 || attachments.length >= 100) throw new HttpError(400,'Package module dependency limit');
    const content = product.get<Content>('content',ref.id,ref.revision);
    if (!content.package) throw new HttpError(400,'Required module is not a package');
    const pkg = validateContentPackage(content.package);
    seen.set(key,ref.revision); active.add(identity); attachments.push(ref); packages.push(pkg);
    for (const module of pkg.modules ?? []) visit({...module,role:'module'},depth+1);
    active.delete(identity);
  };
  for (const root of roots) visit(root,0);
  return {attachments,packages};
}
export function assertPackageReferences(product: ProductStore, pkg: ContentPackage) {
  assertPackageImages(product,pkg);
  for (const module of pkg.modules ?? []) if (!product.get<Content>('content',module.id,module.revision).package) throw new HttpError(400,'Required module is not a package');
  if (pkg.hiddenStory) validateHiddenStorySelection(product,validatePackageHiddenStory(pkg.hiddenStory));
}
export function packageHiddenSelection(product: ProductStore, profile: ChatProfile, resolved = resolvePackageModules(product,profile.packageAttachments ?? [])): ChatProfile['hiddenStory'] {
  let selection: ChatProfile['hiddenStory'];
  for (const [index,pkg] of resolved.packages.entries()) {
    if (!pkg.hiddenStory) continue;
    const ref=resolved.attachments[index], selected=validatePackageHiddenStory(pkg.hiddenStory);
    const overrides=resolvePromptValues({version:1,blocks:[],controls:pkg.controls},profile.packageValues?.[`${ref.id}@${ref.revision}:${ref.role}`]);
    const values={...selected.config.values};
    for(const key of Object.keys(values))if(Object.hasOwn(overrides,key))values[key as keyof typeof values]=overrides[key] as never;
    const next={...selected,config:validateHiddenStoryConfig({...selected.config,values})};
    validateHiddenStorySelection(product,next);
    if(selection&&!isDeepStrictEqual(selection,next))throw new HttpError(400,'Multiple packages declare conflicting Hidden Story settings');
    selection=next;
  }
  if(selection&&profile.hiddenStory?.module&&!isDeepStrictEqual(profile.hiddenStory,selection))throw new HttpError(400,'Hidden Story is selected both directly and through a package');
  return selection??profile.hiddenStory;
}
export function resolvePackageProfile(product: ProductStore, profile: ChatProfile): Pick<ProfileSnapshot,'packageAttachments'|'packages'|'hiddenStory'> {
  const resolved=resolvePackageModules(product,profile.packageAttachments??[]);
  const hiddenStory=packageHiddenSelection(product,profile,resolved);
  return {...(profile.packageAttachments!==undefined?{packageAttachments:resolved.attachments,packages:resolved.packages}:{}),...(hiddenStory?{hiddenStory}:{})};
}
export function packagePersonaName(profile: ProfileSnapshot | undefined): string {
  const ref=profile?.packageAttachments?.find(item=>item.role==='persona');
  const pkg=ref?profile?.packages?.find(item=>item.id===ref.id&&item.revision===ref.revision):undefined;
  return pkg?.identity?.name||pkg?.title||profile?.contents.find(item=>item.kind==='persona')?.title||'User';
}
export function packageFeatureRoutes(app: FastifyInstance, store: Store) {
  app.post('/api/packages/resolve',async request=>{
    const b=record(request.body);fields(b,['attachments']);
    if(!Array.isArray(b.attachments)||b.attachments.length>100)throw new HttpError(400,'Invalid package attachments');
    const roots=b.attachments.map(validatePackageAttachment),resolved=resolvePackageModules(store.product,roots);
    return {...resolved,required:resolved.attachments.filter(ref=>!roots.some(root=>root.id===ref.id&&root.revision===ref.revision&&root.role===ref.role))};
  });
}
