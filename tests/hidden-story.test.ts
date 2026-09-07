import { createHash } from 'node:crypto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { HIDDEN_CONTROL_MAP, defaultHiddenStoryConfig, filterHiddenStoryForRequest, hiddenRangeWasExcluded, hiddenReaderSettings, hiddenTranslationMarkers, parseHiddenStory, serializeHiddenStoryConfig, validateHiddenStoryConfig, validateHiddenTranslation, withHiddenKnowledge, type HiddenSource, type HiddenStoryConfig } from '../core/hidden-story.js';
import { convertHiddenStoryModule, wireHiddenStoryInstructions } from '../core/hidden-story-converter.js';
import { compilePromptProgram } from '../core/prompt-program.js';
import { HiddenStoryReader } from '../web/HiddenStoryReader.js';
import { freezeHiddenStory, validateHiddenConversion } from '../core/hidden-story-package.js';
import { HiddenStoryStore } from '../server/hidden-story.js';
import { Store } from '../server/store.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute, basename } from 'node:path';
import { hiddenHistoryForRequest, hiddenLogicalHistoryForRequest, hiddenMemoryEntryAllowed } from '../core/hidden-context.js';
import { validateMemoryEntry } from '../core/memory.js';
import { executeStoryRead } from '../core/story-context.js';
import type { RunSnapshot, Source } from '../core/types.js';
import { NativeHiddenBody } from '../web/SourceReader.js';

const source = (text: string, sourceRevision = 'synthetic-source'): HiddenSource => ({ text, sourceRevision, sourceHash: createHash('sha256').update(text).digest('hex') });
const config = (values: Partial<HiddenStoryConfig['values']> = {}, policy: HiddenStoryConfig['contentPolicy'] = 'nonsexual') => ({ ...defaultHiddenStoryConfig(policy), values: { ...defaultHiddenStoryConfig(policy).values, ...values } });
const sample = () => source('The reader enters the harbor.\r\n\r\n@hsTitle: Quiet Bell\r\n⟦Tower @ Morning @ Mira⟧\r\n[hsPortrait: {{img::synthetic-coat}}]\r\n\r\nMira believes the bell is silent.\r\n@hs\r\n\r\nThe reader hears waves.\r\n\r\n@hsTitle: A Memory\r\n\r\nAnother traveler remembers a winter festival.\r\n@hs\r\n\r\nThe reader walks onward.\r\n<EvaluationReport><RevisionReport>[82]<DevelopmentReport>A synthetic note.</EvaluationReport>');

describe('Native hidden story source, knowledge and translation contracts', () => {
  test('NHS01 partition preserves every UTF-16 character and keeps scene labels separate from actor knowledge', () => {
    const raw = sample(), parsed = parseHiddenStory(raw);
    expect(parsed.segments.map(segment => raw.text.slice(segment.range.start, segment.range.end)).join('')).toBe(raw.text);
    expect(parsed.segments.map(segment => segment.kind)).toEqual(['main', 'hidden', 'main', 'hidden', 'main', 'evaluation']);
    const hidden = parsed.segments[1];
    expect(hidden.title).toBe('Quiet Bell'); expect(raw.text.slice(hidden.titleRange!.start, hidden.titleRange!.end)).toBe(hidden.title);
    expect(hidden.scene).toMatchObject({ place: 'Tower', time: 'Morning', subjectLabel: 'Mira' });
    expect(hidden.portrait?.raw).toBe('{{img::synthetic-coat}}');
    expect(raw.text.slice(hidden.bodyRange.start, hidden.bodyRange.end).trim()).toBe('Mira believes the bell is silent.');
    for (const segment of parsed.segments) expect(segment.knowledge).toEqual({ status: 'unknown', mode: 'unspecified', perspectiveActorIds: null, knownByActorIds: null, evidence: [] });
    expect(parsed.diagnostics).toEqual([]); expect(parseHiddenStory(raw)).toEqual(parsed);
  });

  test('NHS02 nested, missing and malformed delimiters stay visible as unmodified original', () => {
    for (const text of ['A\n@hsTitle: Outer\n@hsTitle: Inner\nsecret\n@hs\n@hs\nB', 'A\n@hsTitle: Lost\nsecret', 'A\n@hsTitle:\nsecret\n@hs\nB', 'A\n@hs\nB']) {
      const raw = source(text), result = parseHiddenStory(raw); expect(result.diagnostics.some(item => item.severity === 'error')).toBe(true);
      expect(result.segments.map(segment => raw.text.slice(segment.range.start, segment.range.end)).join('')).toBe(text);
      expect(result.segments.every(segment => segment.kind === 'main')).toBe(true);
    }
    const fenced = source('Before\n```text\n@hsTitle: Example\nbody\n@hs\n```\nAfter');
    expect(parseHiddenStory(fenced).segments.map(segment => segment.kind)).toEqual(['main']);
    expect(parseHiddenStory(source('A\n@hsTitle: Last\nbody\n@hs')).diagnostics.map(item => item.code)).toContain('HIDDEN_AT_END');
  });

  test('NHS03 explicit actor provenance requires same-segment evidence and reader expansion cannot grant knowledge', () => {
    const raw = sample(), original = parseHiddenStory(raw), segment = original.segments[1];
    const withKnowledge = withHiddenKnowledge(original, [{ segmentId: segment.id, mode: 'belief', perspectiveActorIds: ['mira'], knownByActorIds: ['mira'], evidence: [{ start: segment.bodyRange.start, end: segment.bodyRange.end }] }]);
    expect(withKnowledge.segments[1].knowledge).toMatchObject({ status: 'explicit', mode: 'belief', perspectiveActorIds: ['mira'], knownByActorIds: ['mira'] });
    expect(original.segments[1].knowledge.status).toBe('unknown');
    expect(hiddenReaderSettings(config({ 'hidden.open': 1 })).defaultExpanded).toBe(true); expect(parseHiddenStory(raw)).toEqual(original);
    expect(() => withHiddenKnowledge(original, [{ segmentId: segment.id, mode: 'current-event', knownByActorIds: ['reader'], evidence: [{ start: 0, end: 5 }] }])).toThrow('HIDDEN_EVIDENCE_INVALID');
    expect(() => withHiddenKnowledge(original, [{ segmentId: segment.id, mode: 'current-event', knownByActorIds: ['reader'], evidence: [] }])).toThrow('HIDDEN_KNOWLEDGE_INVALID');
  });

  test('NHS04 request exclusion returns original hash and ranges so memory consumers cannot reintroduce hidden evidence', () => {
    const raw = sample(), result = filterHiddenStoryForRequest(raw, config({ 'hidden.excludeHidden': true }));
    expect(result.ok).toBe(true); expect(result.sourceHash).toBe(raw.sourceHash);
    expect(result.excluded.map(item => item.kind)).toEqual(['hidden', 'hidden', 'evaluation']);
    expect(result.text).toContain('The reader enters'); expect(result.text).not.toContain('Mira believes'); expect(result.text).not.toContain('winter festival'); expect(result.text).not.toContain('synthetic note');
    expect(result.keptRanges.map(range => raw.text.slice(range.start, range.end)).join('')).toBe(result.text);
    const hidden = parseHiddenStory(raw).segments[1]; expect(hiddenRangeWasExcluded(result, hidden.bodyRange)).toBe(true); expect(hiddenRangeWasExcluded(result, { start: 0, end: 10 })).toBe(false);
    const malformed = filterHiddenStoryForRequest(source('A\n@hsTitle: secret\nsecret body'), config({ 'hidden.excludeHidden': true }));
    expect(malformed).toMatchObject({ ok: false, text: '', keptRanges: [] });
  });

  test('NHS05 report retention is the original last-six-message boundary and requires explicit indices', () => {
    const raw = sample(), enabled = config({ 'hidden.evaluation': 0 });
    expect(filterHiddenStoryForRequest(raw, enabled).ok).toBe(false);
    expect(filterHiddenStoryForRequest(raw, enabled, { messageIndex: 9, lastMessageIndex: 14 }).text).toContain('synthetic note');
    expect(filterHiddenStoryForRequest(raw, enabled, { messageIndex: 8, lastMessageIndex: 14 }).text).not.toContain('synthetic note');
    expect(filterHiddenStoryForRequest(raw, config({ 'hidden.evaluation': 0, 'hidden.excludeReports': true })).text).not.toContain('synthetic note');
  });

  test('NHS06 translation may localize all prose, titles and scene labels while preserving markers and pinned portrait', () => {
    const raw = sample();
    const translated = raw.text.replace('Quiet Bell', '조용한 종').replace('Tower @ Morning @ Mira', '탑 @ 아침 @ 미라').replace('Mira believes the bell is silent.', '미라는 종이 잠잠하다고 믿어요.').replace('A Memory', '어느 기억').replace('Another traveler remembers a winter festival.', '다른 여행자는 겨울 축제를 기억해요.');
    expect(validateHiddenTranslation(raw, translated)).toMatchObject({ ok: true });
    const markers = hiddenTranslationMarkers(raw); expect(markers.filter(marker => marker.kind === 'open')).toHaveLength(3); expect(markers.some(marker => marker.kind === 'portrait' && marker.literal.includes('synthetic-coat'))).toBe(true);
    expect(validateHiddenTranslation(raw, translated.replace('synthetic-coat', 'made-up-image')).ok).toBe(false);
    const second = parseHiddenStory(raw).segments[3]; const removed = raw.text.slice(0, second.range.start) + raw.text.slice(second.range.end);
    expect(validateHiddenTranslation(raw, removed).ok).toBe(false);
    expect(validateHiddenTranslation(raw, raw.text.replace('Mira believes the bell is silent.', '')).ok).toBe(false);
    const hidden = parseHiddenStory(raw).segments[1]; const moved = raw.text.slice(0, hidden.range.start) + raw.text.slice(hidden.range.end) + raw.text.slice(hidden.range.start, hidden.range.end);
    expect(validateHiddenTranslation(raw, moved).ok).toBe(false);
  });

  test('NHS07 configuration keeps adult general-fiction separate from the attached nonsexual combination', () => {
    const general = config({ 'hidden.enabled': 0, 'hidden.theme': 8 }, 'general-fiction'); expect(validateHiddenStoryConfig(general)).toEqual(general);
    expect(() => validateHiddenStoryConfig({ ...general, contentPolicy: 'nonsexual' })).toThrow('HIDDEN_NONSEXUAL_COMBINATION_REQUIRED');
    expect(() => validateHiddenStoryConfig(config({ 'hidden.covertNtr': true }))).toThrow('HIDDEN_NONSEXUAL_COMBINATION_REQUIRED');
    expect(JSON.parse(serializeHiddenStoryConfig(config()))).toEqual(config());
    for (const values of [{ 'hidden.opacity': '0.4);color:red' }, { 'hidden.opacity': '1.1' }, { 'hidden.color': 15 }, { 'hidden.open': true }, { 'hidden.unknown': 1 }]) expect(() => validateHiddenStoryConfig({ ...config(), values })).toThrow();
    expect(() => validateHiddenStoryConfig(JSON.parse('{"version":1,"contentPolicy":"nonsexual","values":{"__proto__":{}}}'))).toThrow('HIDDEN_INVALID_FIELDS');
  });

  test('NHS08 native reader escapes title/body HTML and does not execute portrait/CBS strings', () => {
    const raw = source('A\n@hsTitle: <img src=x onerror=bad()>\n⟦Tower @ Dawn @ Unknown⟧\n[hsPortrait: <script>bad()</script>]\n<script>window.BAD=1</script>\n@hs\nB');
    const rendered = renderToStaticMarkup(createElement(HiddenStoryReader, { source: raw, config: config({ 'hidden.open': 1, 'hidden.assetMode': 0, 'hidden.portrait': 0 }) }));
    expect(rendered).toContain('native-hidden-story'); expect(rendered).toContain('&lt;img'); expect(rendered).toContain('&lt;script&gt;window.BAD=1'); expect(rendered).not.toContain('<script>'); expect(rendered).not.toContain('<img'); expect(rendered).toContain('등장인물에게 정보가 전달되지는');
    const stale = renderToStaticMarkup(createElement(HiddenStoryReader, { source: raw, translation: { sourceRevision: 'wrong', sourceHash: raw.sourceHash, segments: {} } })); expect(stale).toContain('다른 원문 버전'); expect(raw.text).toContain('window.BAD=1');
  });
});

function syntheticModule() {
  const customModuleToggle = HIDDEN_CONTROL_MAP.map(([key, , kind, count]) => `${key}=Synthetic ${key}${kind === 'boolean' ? '' : `=${kind}${kind === 'select' ? `=${Array.from({ length: count }, (_, index) => `choice${index}`).join(',')}` : ''}`}`).join('\n');
  return { source: { sha256: 'a'.repeat(64) }, module: { id: 'synthetic-module', name: 'Synthetic Hidden Pack', customModuleToggle, lua: '', regex: [], triggers: [{ effect: [{ type: 'v2Header', code: '' }] }], lorebook: [
    { sourceIndex: 0, comment: 'Synthetic creative', alwaysActive: true, mode: 'normal', insertorder: 2000, content: '@@depth 0\n{{#if_pure {{? {{getglobalvar::toggle_히든}}=0}}}}SYNTHETIC_DUAL {{user}}: {{pick::two::two::three}} blocks. {{#if {{and::{{not_equal::{{getglobalvar::toggle_커스텀테마}}::null}}::{{? {{length::{{getglobalvar::toggle_커스텀테마}}}}>0}}}}}}Theme={{getglobalvar::toggle_커스텀테마}}{{/if}}{{/if}}' },
    { sourceIndex: 2, comment: 'Synthetic independent addon', alwaysActive: true, mode: 'normal', insertorder: 4000, content: '{{#if {{? {{getglobalvar::toggle_배드전개}}=1}}}}SYNTHETIC_ALLOW_LOSS{{/if}}' },
    { sourceIndex: 8, comment: 'Synthetic external activation', alwaysActive: false, mode: 'normal', insertorder: 100, content: 'SYNTHETIC_EXTERNAL_ONLY' },
  ] } };
}

describe('Source-driven hidden module conversion', () => {
  test('NHS09 converts all 35 control identities and source conditional creative fragments without evaluating user text', () => {
    const converted = convertHiddenStoryModule(syntheticModule()); expect(converted.program.controls).toHaveLength(35); expect(converted.controlMap).toHaveLength(35); expect(converted.status).toBe('partial');
    const wired = wireHiddenStoryInstructions(converted, config({ 'hidden.enabled': 0, 'hidden.customTheme': '{{setvar::private::oops}}', 'hidden.badOutcomes': true }), { seed: 'run-one', userLabel: 'Reader' });
    const compilation = compilePromptProgram({ ...wired.program, blocks: [...wired.program.blocks, { kind: 'current', id: 'current-input', title: 'Current' }] }, { values: wired.values, slots: wired.slots, history: [{ id: 'u', role: 'user', text: 'Synthetic request', current: true }] });
    const output = compilation.messages.map(message => message.content[0].text).join('\n');
    expect(output).toContain('SYNTHETIC_DUAL Reader:'); expect(output).toContain('Theme={{setvar::private::oops}}'); expect(output).toContain('SYNTHETIC_ALLOW_LOSS'); expect(output).not.toContain('SYNTHETIC_EXTERNAL_ONLY'); expect(output).toContain('This attached character combination is nonsexual');
    expect(converted.loreMapping[0]).toMatchObject({ sourceIndex: 0, depth: 0, insertOrder: 2000 });
    expect(converted.issues.map(issue => issue.code)).toContain('HIDDEN_EXTERNAL_LORE_ACTIVATION');
  });

  test('NHS10 seeded count weights survive reader changes and unsupported external actions are explicit', () => {
    const converted = convertHiddenStoryModule(syntheticModule()); expect(converted.picks[0].choices).toEqual(['two', 'two', 'three']);
    const first = wireHiddenStoryInstructions(converted, config(), { seed: 'stable-run', userLabel: 'Reader' });
    const second = wireHiddenStoryInstructions(converted, config({ 'hidden.open': 1, 'hidden.color': 7 }), { seed: 'stable-run', userLabel: 'Reader' });
    expect(second.choices).toEqual(first.choices);
    expect(() => wireHiddenStoryInstructions(converted, config({ 'hidden.polish': true }), { seed: 's', userLabel: 'Reader' })).toThrow('HIDDEN_EXTERNAL_POLISH_UNSUPPORTED');
    expect(() => wireHiddenStoryInstructions(converted, config({ 'hidden.illustrationCount': 1 }), { seed: 's', userLabel: 'Reader' })).toThrow('HIDDEN_EXTERNAL_ILLUSTRATION_UNSUPPORTED');
    expect(wireHiddenStoryInstructions(converted, config({ 'hidden.style': 1 }), { seed: 's', userLabel: 'Reader' }).issues).toContain('HIDDEN_INVASIVE_CSS_SCOPED');
  });

  test('NHS11 incomplete source control coverage and unknown CBS never become successful active imports', () => {
    const missing = syntheticModule(); missing.module.customModuleToggle = missing.module.customModuleToggle.split('\n').slice(1).join('\n'); expect(() => convertHiddenStoryModule(missing)).toThrow('HIDDEN_IMPORT_CONTROL_COVERAGE');
    const unknown = syntheticModule(); unknown.module.lorebook[0].content = '{{exec::unknown}}';
    const converted = convertHiddenStoryModule(unknown); expect(converted.program.blocks[0].enabled).toBe(false); expect(converted.issues.map(issue => issue.code)).toContain('HIDDEN_CBS_FUNCTION_UNSUPPORTED');
    const copied = syntheticModule(); const before = structuredClone(copied); convertHiddenStoryModule(copied); expect(copied).toEqual(before);
  });

  test('NHS12 native package validation and freezing retain separate message provenance and deterministic choices', () => {
    const conversion=validateHiddenConversion(convertHiddenStoryModule(syntheticModule()));
    const module={...conversion,id:'synthetic-native',revision:1,title:'Synthetic native',packageHash:'b'.repeat(64)};
    const selection={module:{id:module.id,revision:1},config:config({'hidden.enabled':0,'hidden.badOutcomes':true}),insertion:'before-history' as const};
    const frozen=freezeHiddenStory(module,selection,{seed:'fixed-run',userLabel:'Reader'});
    expect(frozen.messages).toHaveLength(3);expect(frozen.messages.every(m=>m.role==='system'&&m.provenance.sourceHash===module.packageHash&&m.provenance.sourceRevision==='synthetic-native@1')).toBe(true);
    expect(frozen.messages.map(m=>m.id)).toEqual(['hidden.lore.0','hidden.lore.2','hidden.host-contract']);expect(frozen.insertion).toBe('before-history');
    module.program.blocks.length=0;selection.config.values['hidden.badOutcomes']=false;expect(frozen.module.program.blocks.length).toBeGreaterThan(0);expect(frozen.config.values['hidden.badOutcomes']).toBe(true);
    expect(()=>validateHiddenConversion({...conversion,picks:[{slot:'hidden.pick.0.0',choices:['{{exec::bad}}']}]})).toThrow();
    const unknown=syntheticModule();unknown.module.lorebook[0].content='{{unknown}}';expect(convertHiddenStoryModule(unknown).program.blocks[0].enabled).toBe(false);
  });

  test('NHS13 immutable module versions survive SQLite reopen and stale edits conflict',async()=>{
    const directory=await mkdtemp(join(tmpdir(),'uimori-hidden-native-'));let store:Store|undefined;
    try{
      const path=join(directory,'synthetic.sqlite');store=new Store(path);let hidden=new HiddenStoryStore(store.product);
      const first=hidden.import({title:'Synthetic module',conversion:convertHiddenStoryModule(syntheticModule())});
      const selected={module:{id:first.id,revision:first.revision},config:config({'hidden.enabled':0})};
      const frozen=hidden.freeze(selected,{seed:'fixed-run',userLabel:'Reader'})!;
      const second=hidden.import({title:'Synthetic revision two',conversion:convertHiddenStoryModule(syntheticModule()),expectedRevision:1},first.id);
      expect(second.revision).toBe(2);expect(hidden.get(first.id,1).title).toBe('Synthetic module');
      expect(()=>hidden.import({title:'Stale edit',conversion:convertHiddenStoryModule(syntheticModule()),expectedRevision:1},first.id)).toThrow('Revision conflict');
      store.close();store=new Store(path);hidden=new HiddenStoryStore(store.product);
      expect(hidden.freeze(selected,{seed:'fixed-run',userLabel:'Reader'})).toEqual(frozen);expect(hidden.list()).toHaveLength(1);expect(hidden.list()[0].revision).toBe(2);
    }finally{
      store?.close();const target=resolve(directory),within=relative(resolve(tmpdir()),target);if(isAbsolute(within)||within.startsWith('..')||!basename(target).startsWith('uimori-hidden-native-'))throw new Error('Refusing unsafe test cleanup');await rm(target,{recursive:true,force:true});
    }
  });

  test('NHS14 hidden context exclusions apply to history and scoped read/search with original coordinates',()=>{
    const raw=sample();const snapshot={chatId:'synthetic-chat',history:[{revision:raw.sourceRevision,text:raw.text,contentHash:raw.sourceHash}],hiddenStory:{config:config({'hidden.excludeHidden':true,'hidden.excludeReports':true})}} as RunSnapshot;
    const before=structuredClone(snapshot),history=hiddenHistoryForRequest(snapshot);expect(history[0].text).not.toContain('Mira believes');expect(history[0].text).toContain('hears waves');expect(history[0].contentHash).toBe(raw.sourceHash);expect(snapshot).toEqual(before);
    const logical=hiddenLogicalHistoryForRequest(snapshot,[{id:'assistant',role:'assistant',sourceRevision:raw.sourceRevision,sourceHash:raw.sourceHash,text:raw.text},{id:'current',role:'user',current:true,text:'@hsTitle: my literal request'}]);expect(logical[0].text).toBe(history[0].text);expect(logical[1].text).toBe('@hsTitle: my literal request');
    const search=executeStoryRead(snapshot,{callId:'search',name:'story.search',args:{query:'Mira believes'}},true);expect(search.denied).toBe(false);expect(search.result).toMatchObject({total:0});
    const read=executeStoryRead(snapshot,{callId:'read',name:'story.read',args:{id:raw.sourceRevision,limit:16000}},true);expect(read.denied).toBe(false);const result=read.result as {text:string;source:{hash:string};keptRanges:{start:number;end:number}[]};expect(result.text).toBe(history[0].text);expect(result.source.hash).toBe(raw.sourceHash);expect(result.keptRanges.map(r=>raw.text.slice(r.start,r.end)).join('')).toBe(result.text);
  });

  test('NHS15 host recomputes hidden knowledge without changing extracted kind or granting actor knowledge',()=>{
    const raw=sample(),start=raw.text.indexOf('Mira believes'),end=raw.text.indexOf('\r\n@hs',start),history=[{revision:raw.sourceRevision,text:raw.text,contentHash:raw.sourceHash}],scope={chatId:'synthetic-chat',history};
    const input={id:'memory',chatId:scope.chatId,atRevision:raw.sourceRevision,atHash:raw.sourceHash,kind:'observed-story',text:'Synthetic observation',sources:[{revision:raw.sourceRevision,hash:raw.sourceHash,start,end,quote:raw.text.slice(start,end)}]};
    const entry=validateMemoryEntry(input,scope);expect(entry.kind).toBe('observed-story');expect(entry.knowledge).toMatchObject({readerVisible:true,worldStatus:'unspecified',knownByActorIds:null});expect(entry.knowledge?.segments[0].kind).toBe('hidden');expect(input).not.toHaveProperty('knowledge');
    expect(()=>validateMemoryEntry({...entry,knowledge:{...entry.knowledge,knownByActorIds:['everyone']}},scope)).toThrow('HIDDEN_KNOWLEDGE_MISMATCH');
    expect(hiddenMemoryEntryAllowed({history,hiddenStory:{config:config({'hidden.excludeHidden':true})}} as RunSnapshot,entry)).toBe(false);
    expect(hiddenMemoryEntryAllowed({history,hiddenStory:{config:config({'hidden.excludeHidden':false})}} as RunSnapshot,entry)).toBe(true);
  });

  test('NHS16 native source reader preserves hidden interleaving in complete translation and falls back on broken markers',()=>{
    const raw=sample(),source={id:raw.sourceRevision,hash:raw.sourceHash,text:raw.text} as Source;
    const translated=raw.text.replace('The reader enters the harbor.','독자가 항구에 들어와요.').replace('Quiet Bell','고요한 종').replace('Mira believes the bell is silent.','미라는 종이 조용하다고 믿어요.');
    const html=renderToStaticMarkup(createElement(NativeHiddenBody,{source,config:config(),translationText:translated,blocks:[{anchor:'full',start:0,end:raw.text.length}],inline:()=>[]}));
    expect(html).toContain('translation-text');expect(html.indexOf('독자가 항구')).toBeLessThan(html.indexOf('고요한 종'));expect(html.indexOf('고요한 종')).toBeLessThan(html.indexOf('The reader hears waves'));expect(html).not.toContain('@hsTitle:');
    const broken=renderToStaticMarkup(createElement(NativeHiddenBody,{source,config:config(),translationText:translated.replace('@hsTitle:',''),blocks:[{anchor:'full',start:0,end:raw.text.length}],inline:()=>[]}));expect(broken).toContain('구간 경계를 확인할 수 없어');expect(broken).toContain('The reader enters the harbor.');expect(broken).not.toContain('독자가 항구에');
  });
});
