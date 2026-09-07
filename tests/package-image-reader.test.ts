import { createHash } from 'node:crypto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, test, vi } from 'vitest';
import { NativeHiddenBody, SourceReader } from '../web/SourceReader.js';
import { resolveInlineImage } from '../web/image-placement.js';
import { defaultHiddenStoryConfig, parseHiddenStory } from '../core/hidden-story.js';
import { splitSource } from '../core/auxiliary.js';
import type { Asset } from '../core/product.js';
import type { Job, Source } from '../core/types.js';

test('Reader resolves only the exact approved inline revision and bytes in this chat', () => {
  const asset:Asset={id:'asset',chatId:'chat',revision:2,hash:'bytes-v2',title:'미소',description:'',actor:'',outfit:'',location:'',allowedUse:'both',mime:'image/png',url:'/api/assets/asset'};
  const annotation={assetRef:asset.id,assetRevision:2,assetHash:asset.hash,presentationIntent:'inline' as const};
  expect(resolveInlineImage([asset],'chat',annotation)).toBe(asset);
  expect(resolveInlineImage([asset],'other',annotation)).toBeUndefined();
  expect(resolveInlineImage([asset],'chat',{...annotation,assetRevision:1})).toBeUndefined();
  expect(resolveInlineImage([asset],'chat',{...annotation,assetHash:'old-bytes'})).toBeUndefined();
  expect(resolveInlineImage([asset],'chat',{...annotation,presentationIntent:'profile'})).toBeUndefined();
  expect(resolveInlineImage([asset,asset],'chat',annotation)).toBeUndefined();
});

test('an image on a block spanning main and hidden text never leaks onto the main segment', () => {
  const text='Visible introduction.\n\n@hsTitle: Secret\n⟦Library @ Morning @ Companion⟧\n\nSecret scene.\n@hs\n\nVisible ending.';
  const source:Source={id:'source',chatId:'chat',runId:'run',parentRevision:null,text,hash:createHash('sha256').update(text).digest('hex')};
  const parsed=parseHiddenStory({sourceRevision:source.id,sourceHash:source.hash,text});
  const hidden=parsed.segments.find(segment=>segment.kind==='hidden');
  expect(hidden).toBeDefined();
  const blocks=[{anchor:'cross-boundary',start:0,end:text.length}, {anchor:'hidden-only',start:hidden!.bodyRange.start,end:hidden!.bodyRange.end}];
  const markup=renderToStaticMarkup(createElement(NativeHiddenBody,{source,config:defaultHiddenStoryConfig(),blocks,inline:anchor=>[createElement('img',{key:anchor,src:`/synthetic/${anchor}`,alt:anchor,loading:'lazy'})]}));
  expect(markup).not.toContain('/synthetic/cross-boundary');
  expect(markup).toContain('/synthetic/hidden-only');
  const hiddenStart=markup.indexOf('class="native-hidden-story"');
  expect(markup.indexOf('/synthetic/hidden-only')).toBeGreaterThan(hiddenStart);
  expect(splitSource(source).length).toBeGreaterThan(1);
});


const projection=vi.hoisted(()=>({data:undefined as unknown}));
vi.mock('../web/PackagePresentation.js',async importOriginal=>({...await importOriginal<typeof import('../web/PackagePresentation.js')>(),usePackagePresentation:()=>projection.data?{data:projection.data}:undefined}));
beforeEach(()=>{projection.data=undefined;});

test('transformed prose suppresses unplaceable images and identifies an authored opening as source content', () => {
  const source:Source={id:'source',chatId:'chat',runId:'run',parentRevision:null,text:'First.\n\nSecond.',hash:createHash('sha256').update('First.\n\nSecond.').digest('hex')};
  source.blocks=splitSource(source);
  const asset:Asset={id:'asset',chatId:'chat',revision:1,hash:'bytes',title:'Scene',description:'',actor:'',outfit:'',location:'',allowedUse:'inline',mime:'image/png',url:'/api/assets/asset'};
  const job={id:'image',kind:'image',status:'completed',sourceRevision:source.id,sourceHash:source.hash,revision:1,result:{sourceRevision:source.id,sourceHash:source.hash,annotations:[{blockAnchor:source.blocks[0].anchor,assetRef:asset.id,assetRevision:1,assetHash:asset.hash,presentationIntent:'inline'}]}} as Job;
  const props={source,index:0,jobs:[job],assets:[asset],refresh:async()=>{},onError:()=>{},onFork:async()=>{},request:'INTERNAL_START_COMMAND',packageStart:{mode:'authored' as const,title:'작성된 첫 장면'}};
  const normal=renderToStaticMarkup(createElement(SourceReader,props));
  expect(normal).toContain('/api/assets/asset'); expect(normal).toContain('작성된 도입문'); expect(normal).not.toContain('INTERNAL_START_COMMAND');
  projection.data={sourceRevision:source.id,sourceHash:source.hash,original:{text:'A merged display.',changed:true,applied:['merge']},stateViews:[],issues:[]};
  const transformed=renderToStaticMarkup(createElement(SourceReader,props));
  expect(transformed).toContain('A merged display.'); expect(transformed).toContain('이미지를 생략'); expect(transformed).not.toContain('/api/assets/asset');
  expect(source.text).toBe('First.\n\nSecond.');
  projection.data=undefined;
  const newer={...job,id:'new-image',revision:2,status:'queued',result:null} as Job;
  expect(renderToStaticMarkup(createElement(SourceReader,{...props,jobs:[job,newer]}))).not.toContain('/api/assets/asset');
  const translation={...job,id:'translation',kind:'translation',result:{sourceRevision:source.id,sourceHash:source.hash,mock:true,text:'합친 번역.',segments:[{anchors:source.blocks.map(block=>block.anchor),text:'합친 번역.'}]}} as Job;
  expect(renderToStaticMarkup(createElement(SourceReader,{...props,jobs:[job,translation]}))).toContain('/api/assets/asset');
  projection.data={sourceRevision:source.id,sourceHash:source.hash,original:{text:source.text,changed:false,applied:[]},translation:{text:'표시용 번역.',changed:true,applied:['merge']},stateViews:[],issues:[]};
  const translated=renderToStaticMarkup(createElement(SourceReader,{...props,jobs:[job,translation]}));
  expect(translated).toContain('표시용 번역.');expect(translated).not.toContain('/api/assets/asset');
});
