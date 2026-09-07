import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LORE_CONTEXT, type LoreContextSnapshot } from '../core/lore-context.js';
import { LoreContextDiagnostics } from '../web/LoreContextDiagnostics.js';
import { parseLorePolicyDraft } from '../web/LoreContextPolicyEditor.js';

describe('lore context UI boundaries',()=>{
  const valid={enabled:true,maxRetainedChars:'48000',maxRetainedEntries:'64',maxPinnedChars:'200000'};
  it('accepts explicit zero retention and both inclusive policy limits',()=>{
    expect(parseLorePolicyDraft(valid)).toEqual(DEFAULT_LORE_CONTEXT);
    expect(parseLorePolicyDraft({enabled:false,maxRetainedChars:'0',maxRetainedEntries:'0',maxPinnedChars:'1'})).toEqual({enabled:false,maxRetainedChars:0,maxRetainedEntries:0,maxPinnedChars:1});
    expect(parseLorePolicyDraft({enabled:true,maxRetainedChars:'200000',maxRetainedEntries:'256',maxPinnedChars:'2000000'})).toEqual({enabled:true,maxRetainedChars:200000,maxRetainedEntries:256,maxPinnedChars:2000000});
  });
  it('rejects incomplete, fractional and out-of-bound drafts without changing their text',()=>{
    for(const [key,text] of [['maxRetainedChars',''],['maxRetainedEntries',' '],['maxRetainedEntries','1.5'],['maxRetainedChars','-1'],['maxPinnedChars','0'],['maxPinnedChars','2000001'],['maxRetainedEntries','257'],['maxRetainedChars','Infinity']] as const){
      const draft={...valid,[key]:text},before=structuredClone(draft);expect(()=>parseLorePolicyDraft(draft)).toThrow('정수');expect(draft).toEqual(before);
    }
  });
  it('renders source provenance and UTF-16 facts as escaped reference text without changing the snapshot',()=>{
    const text='A😀B<script>unsafe()</script>',snapshot:LoreContextSnapshot={version:1,policy:{...DEFAULT_LORE_CONTEXT},canonHash:'canon',dependencies:[],entries:[{id:'entry',revision:3,hash:'hash',title:'<img src=x>',start:5,end:5+text.length,text,origin:{sourceRevision:'source-one',sourceHash:'source-hash',runId:'run-one',callId:'call-one'},lastUsed:'source-two'}],stats:{retainedChars:text.length,retainedEntries:1,appendedChars:4,droppedEntries:2,reasons:['retention-budget']}};
    const before=structuredClone(snapshot),html=renderToStaticMarkup(createElement(LoreContextDiagnostics,{snapshot,reset:true}));
    expect(html).toContain(`UTF-16 5–${5+text.length}`);expect(html).toContain('처음 읽은 원문 source-one · Run run-one');expect(html).toContain('4자');expect(html).toContain('조회 로어 예산에 맞춰 정리');expect(html).toContain('이 요청에서 새 장면 정리를 선택했어요.');
    expect(html).toContain('&lt;script&gt;unsafe()&lt;/script&gt;');expect(html).toContain('&lt;img src=x&gt;');expect(html).not.toContain('<script>');expect(html).not.toContain('<img');expect(snapshot).toEqual(before);
  });
});
