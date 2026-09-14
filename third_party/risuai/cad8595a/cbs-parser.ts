// SPDX-License-Identifier: GPL-3.0-only
// Snapshot of RisuAI (https://github.com/kwaroran/RisuAI) at commit cad8595aa39620df4246f56918f0962c2aa0263a.
// Upstream sources: src/ts/parser/parser.svelte.ts:122-150,1009-1011,1018-1099,1102-1131,1133-1157,1159-1186,1188-1460,1462-1466,1468-1571,1574-1849
// Copyright (c) Kwaroran and the RisuAI contributors. Licensed under GPL-3.0-only; see ./LICENSE.
// Modifications for Uimori:
//   - Only the CBS evaluator was copied. Everything else in parser.svelte.ts - markdown-it rendering,
//     DOMPurify, katex, highlight.js, asset/emotion resolution, style encoding, thought/tool parsing,
//     `applyMarkdownToNode` and the `hasher` helper - is not part of this file.
//   - @ts-nocheck: risuChatParser is written against RisuAI's non-strict settings (`nested.shift()` and
//     `statement.pop()` feed straight into string operations, `chara` starts as `null` typed `character`).
//     Uimori's tsconfig is `strict`. Every symbol this file exports is annotated by hand, so callers are
//     still fully checked; only the copied bodies are exempt.
//   - The module-level `matcherMap` / `matcherInitialized` singleton and the lazy `initMatcher()` are
//     replaced by `createRisuCbs(deps)`, which owns one matcher map per instance and registers eagerly.
//     Two evaluators with different dependencies therefore never share state.
//   - Every app-state and environment access is now a member of the single injected `RisuCbsDeps`:
//     `DBState.db` -> `deps.getDatabase()`, `get(selectedCharID)` -> `deps.getSelectedCharID()`,
//     `findCharacterbyId` -> `deps.findCharacterbyId()` (which may return null, so the upstream
//     'Unknown Character' guard also accepts null), and `dateTimeFormat`'s bare `new Date()` ->
//     `new Date(deps.now())`. `calcString`, `pickHashRand` and `safeStructuredClone` come from
//     ./cbs-support.js, which is also where the chat-variable default fallback lives.
//   - Unsupported-name reporting (Uimori addition). `deps.unsupportedNames` holds names the host cannot
//     serve. `registerFunction` checks each name and alias, raw and after Risu's normalisation
//     (`toLocaleLowerCase().replace(/[\s_-]/g,'')`), *before* upstream's `doc_only` early return, and
//     registers a stub that records the name and returns ''. `matcher()` additionally records any name
//     with no registration at all and still returns null, so the parser leaves the tag literal exactly as
//     upstream does. Recording goes through an instance-level collector rather than a thrown error,
//     because upstream's `matcher` swallows callback exceptions (parser.svelte.ts:1078-1099).
//   - The two `console.log` debug statements inside risuChatParser (on `{{/func}}` and `{{call::}}`) are
//     dropped.
//   - No evaluation semantics were changed otherwise: `::` before `:` argument splitting, `{{? }}` via
//     calcString, the `<user>/<char>/<bot>` rewrite, the private-use escape characters, the block matchers
//     (#if / #if_pure / #when with every operator and keep|legacy, #pure, #puredisplay, #code, #escape,
//     #each + slot, #func / call / arg, {{:else}}, legacy `{# #}`), the 20-deep call-stack limit with its
//     'ERROR: Call stack limit reached' text, and the `visualize`/`displaying` branches are as upstream.
// @ts-nocheck

import type { CBSRegisterArg, RegisterCallback, matcherArg } from './cbs.js';
import { registerCBS } from './cbs.js';
import type { Database, LLMModel } from './cbs-support.js';
import { createCalcString, pickHashRand, safeStructuredClone } from './cbs-support.js';
import type { RisuModule, character, groupChat, loreBook } from './types.js';

export type { Database, LLMModel } from './cbs-support.js';
export type { CBSRegisterArg, RegisterCallback, matcherArg } from './cbs.js';

// ---------------------------------------------------------------------------
// src/ts/parser/parser.svelte.ts:122-150
// ---------------------------------------------------------------------------

const replacements = [
    '{', //0xE9B8
    '}', //0xE9B9
    '(', //0xE9BA
    ')', //0xE9BB
    '&lt;', //0xE9BC
    '&gt;', //0xE9BD
    ':', //0xE9BE
    ';', //0xE9BF
]

export function risuUnescape(text:string):string{
    return text.replace(/[\uE9b8-\uE9bf]/g, (f) => {
        const index = f.charCodeAt(0) - 0xE9B8
        return replacements[index]
    })
}

export function risuEscape(text:string):string{
    return text.replace(/[{}()]/g, (f) => {
        switch(f){
            case '{': return '\uE9B8'
            case '}': return '\uE9B9'
            case '(': return '\uE9BA'
            case ')': return '\uE9BB'
            default: return f
        }
    })
}

// ---------------------------------------------------------------------------
// src/ts/parser/parser.svelte.ts:1009-1011
// ---------------------------------------------------------------------------

export type CbsConditions = {
    firstmsg?:boolean
    chatRole?:string
}

type blockMatch = 'ignore'|'parse'|'nothing'|'ifpure'|'pure'|'each'|'function'|'pure-display'|'normalize'|'escape'|'newif'|'newif-falsy'

// ---------------------------------------------------------------------------
// Uimori: the injected dependency surface
// ---------------------------------------------------------------------------

/**
 * Everything the snapshotted CBS evaluator would otherwise read from RisuAI's app state, stores, clock,
 * entropy source or DOM. One object, supplied by the Uimori compat layer.
 */
export type RisuCbsDeps = {
    /** RisuAI's `DBState.db`, narrowed to the members the evaluator reads. */
    getDatabase: () => Database
    /** The user's display name, for {{user}}. */
    getUserName: () => string
    /** The persona prompt text, for {{persona}}. */
    getPersonaPrompt: () => string
    /** Chat variable read, with RisuAI's default-variable fallback. See createChatVarAccessors. */
    getChatVar: (key: string) => string
    /** Chat variable write, only reached when `runVar` is set on the parse argument. */
    setChatVar: (key: string, value: string) => void
    /** Global chat variable read; also backs the `toggle`/`tis`/`tisnot` operators of {{#when}}. */
    getGlobalChatVar: (key: string) => string
    /** Enabled modules, for {{moduleenabled}} and {{moduleassetlist}}. */
    getModules: () => RisuModule[]
    /** Lorebook entries contributed by modules, for {{lorebook}}. */
    getModuleLorebooks: () => loreBook[]
    /** Index into `getDatabase().characters` of the character in context. */
    getSelectedCharID: () => number
    /** Model metadata for {{metadata::model*}}. */
    getModelInfo: (model: string) => LLMModel
    /** RisuAI's internal `{{__::...}}` escape hatch. Returning '' is a valid implementation. */
    callInternalFunction: (args: string[]) => string
    /** Replaces `get(CurrentTriggerIdStore)` in {{trigger_id}}. Return 'null' when there is none. */
    getTriggerId: () => string
    /** The only clock. Milliseconds since the epoch, like Date.now(). */
    now: () => number
    /** The only entropy source. A value in [0, 1), like Math.random(). */
    random: () => number
    /**
     * Group-chat speaker lookup used when the parse argument carries a groupChat. Returning null is fine;
     * the parser then falls back exactly as upstream does for an unknown speaker.
     */
    findCharacterbyId: (id: string) => character | null
    /**
     * Module asset table, in RisuAI's `[name, path, ...]` row shape. Declared for the facade's sake: the
     * asset and display functions are all routed to the unsupported channel, so nothing reads it yet.
     */
    getModuleAssets: () => string[][]
    /**
     * CBS names the host cannot serve. Matched against each registration's name and aliases, raw and
     * normalised. A hit makes the tag evaluate to '' and adds the name to the parse's `unsupported`.
     */
    unsupportedNames: Set<string>
    isTauri: boolean
    isNodeServer: boolean
    isMobile: boolean
    appVer: string
}

/** Mirrors upstream risuChatParser's argument (parser.svelte.ts:1574-1588). */
export type RisuCbsParseArg = {
    chatID?: number
    db?: Database
    chara?: string | character | groupChat
    rmVar?: boolean
    var?: { [key: string]: string }
    tokenizeAccurate?: boolean
    consistantChar?: boolean
    visualize?: boolean
    role?: string
    runVar?: boolean
    functions?: Map<string, { data: string; arg: string[] }>
    callStack?: number
    cbsConditions?: CbsConditions
}

export type RisuCbsResult = {
    /** The evaluated text. */
    text: string
    /** Names that were reported unsupported or had no registration, in first-seen order. */
    unsupported: string[]
    /** Set only when an exception escaped the evaluator; `text` is then ''. */
    error?: string
}

export type RisuCbs = {
    parse: (text: string, arg: RisuCbsParseArg) => RisuCbsResult
}

const normalizeCbsName = (name: string): string => {
    return name.toLocaleLowerCase().replace(/[\s_-]/g, '')
}

// ---------------------------------------------------------------------------
// The evaluator instance. Bodies below are parser.svelte.ts's, closed over `deps`.
// ---------------------------------------------------------------------------

export function createRisuCbs(deps: RisuCbsDeps): RisuCbs {
    const matcherMap = new Map<string, RegisterCallback>()
    let unsupportedCollector: string[] | null = null

    const recordUnsupported = (name: string): string => {
        if(unsupportedCollector && !unsupportedCollector.includes(name)){
            unsupportedCollector.push(name)
        }
        return ''
    }

    const getChatVar = (key:string) => deps.getChatVar(key)
    const getGlobalChatVar = (key:string) => deps.getGlobalChatVar(key)
    const calcString = createCalcString({ getChatVar, getGlobalChatVar })

    // parser.svelte.ts:1102-1131
    const dateTimeFormat = (main:string, time = 0) => {
        const date = time === 0 ? (new Date(deps.now())) : (new Date(time))
        if(!main){
            return ''
        }
        if(main.startsWith(':')){
            main = main.substring(1)
        }
        if(main.length > 300){
            return ''
        }
        return main
            .replace(/YYYY/g, date.getFullYear().toString())
            .replace(/YY/g, date.getFullYear().toString().substring(2))
            .replace(/MMMM/g, Intl.DateTimeFormat('en', { month: 'long' }).format(date))
            .replace(/MMM/g, Intl.DateTimeFormat('en', { month: 'short' }).format(date))
            .replace(/MM/g, (date.getMonth() + 1).toString().padStart(2, '0'))
            .replace(/DDDD/g, Math.floor((date.getTime() - new Date(date.getFullYear(), 0, 0).getTime()) / (1000 * 60 * 60 * 24)).toString())
            .replace(/DD/g, date.getDate().toString().padStart(2, '0'))
            .replace(/dddd/g, Intl.DateTimeFormat('en', { weekday: 'long' }).format(date))
            .replace(/ddd/g, Intl.DateTimeFormat('en', { weekday: 'short' }).format(date))
            .replace(/HH/g, date.getHours().toString().padStart(2, '0'))
            .replace(/hh/g, (date.getHours() % 12 || 12).toString().padStart(2, '0'))
            .replace(/mm/g, date.getMinutes().toString().padStart(2, '0'))
            .replace(/ss/g, date.getSeconds().toString().padStart(2, '0'))
            .replace(/X/g, Math.floor(date.getTime() / 1000).toString())
            .replace(/x/g, date.getTime().toString())
            .replace(/A/g, date.getHours() >= 12 ? 'PM' : 'AM')
    }

    // parser.svelte.ts:1159-1186
    function parseArray(p1:string): unknown[]{
        try {
            const arr = JSON.parse(p1)
            if(Array.isArray(arr)){
                return arr
            }
            return p1.split('§')
        } catch (error) {
            return p1.split('§')
        }
    }

    function parseDict(p1 :string): {[key:string]: unknown}{
        try {
            return JSON.parse(p1)
        } catch (error) {
            return {}
        }
    }

    function makeArray(p1: unknown[]): string{
        return JSON.stringify(p1.map((f) => {
            if(typeof(f) === 'string'){
                return f.replace(/::/g, '\\u003A\\u003A')
            }
            return f
        }))
    }

    // parser.svelte.ts:1020-1067, rewritten as a per-instance eager registration.
    const registerFunction: CBSRegisterArg['registerFunction'] = (arg) => {
        const callback = arg.callback
        const names = [arg.name, ...arg.alias]
        for (const name of names) {
            // Uimori addition: checked before upstream's `doc_only` early return, so that display-only
            // names such as {{asset}} can also be reported instead of silently staying literal.
            if(deps.unsupportedNames.has(name) || deps.unsupportedNames.has(normalizeCbsName(name))){
                const reported = normalizeCbsName(name)
                matcherMap.set(name, () => recordUnsupported(reported))
                continue
            }
            if(callback === 'doc_only') {
                continue
            }
            matcherMap.set(name, callback)
        }
    }

    registerCBS({
        registerFunction,
        getDatabase: deps.getDatabase,
        getUserName: deps.getUserName,
        getPersonaPrompt: deps.getPersonaPrompt,
        risuChatParser: (text, arg) => risuChatParser(text, arg as RisuCbsParseArg),
        makeArray,
        safeStructuredClone,
        parseArray,
        parseDict,
        getChatVar,
        setChatVar: deps.setChatVar,
        getGlobalChatVar,
        calcString,
        dateTimeFormat,
        getModules: deps.getModules,
        getModuleLorebooks: deps.getModuleLorebooks,
        pickHashRand,
        getSelectedCharID: deps.getSelectedCharID,
        getModelInfo: deps.getModelInfo,
        callInternalFunction: deps.callInternalFunction,
        isTauri: deps.isTauri,
        isNodeServer: deps.isNodeServer,
        isMobile: deps.isMobile,
        appVer: deps.appVer,
        getTriggerId: deps.getTriggerId,
        now: deps.now,
        random: deps.random,
        unsupported: recordUnsupported,
    })

    // parser.svelte.ts:1071-1099
    function matcher (p1:string,matcherArg:matcherArg,vars:{[key:string]:string}|null = null ):{
        text:string,
        var:{[key:string]:string}
    }|string|null {
        try {
            if(p1.startsWith('? ')){
                const substring = p1.substring(2)
                return calcString(substring).toString()
            }
            const colonIndex = p1.indexOf(':')
            let splited: string[]
            if(colonIndex !== -1 && p1[colonIndex + 1] === ':'){
                splited = p1.split('::')
            }
            else{
                splited = p1.split(':')
            }
            const name = splited[0].toLocaleLowerCase().replace(/[\s_-]/g, '')
            const args = splited.slice(1)
            const callback = matcherMap.get(name)
            if(callback){
                return callback(p1, matcherArg, args,vars)
            }
            // Uimori addition: a name with no registration is reported, then left literal as upstream.
            recordUnsupported(name)
        } catch (error) {}

        return null
    }

    // parser.svelte.ts:1133-1157
    const legacyBlockMatcher = (p1:string,matcherArg:matcherArg) => {
        const bn = p1.indexOf('\n')

        if(bn === -1){
            return null
        }

        const logic = p1.substring(0, bn)
        const content = p1.substring(bn + 1)
        const statement = logic.split(" ", 2)

        switch(statement[0]){
            case 'if':{
                if(["","0","-1"].includes(statement[1])){
                    return ''
                }

                return content.trim()
            }
        }

        return null
    }

    // parser.svelte.ts:1188-1460
    function blockStartMatcher(p1:string,matcherArg:matcherArg):{type:blockMatch,type2?:string,funcArg?:string[],mode?:string}{
        if(p1.startsWith('#if') || p1.startsWith('#if_pure ')){
            const statement = p1.split(' ', 2)
            const state = statement[1]
            if(state === 'true' || state === '1'){
                return {
                    type:   p1.startsWith('#if_pure') ? 'ifpure' :
                            'parse'
                }
            }
            return {type:'ignore'}
        }
        if(p1.startsWith('#when')){
            if(p1.startsWith('#when ')){
                const statement = p1.split(' ', 2)
                const state = statement[1]
                return {type: (state === 'true' || state === '1') ? 'newif' : 'newif-falsy'}
            }
            else if(p1.startsWith('#when::')){
                const statement = p1.split('::').slice(1)
                if(statement.length === 1){
                    const state = statement[0]
                    return {type: (state === 'true' || state === '1') ? 'newif' : 'newif-falsy'}
                }
                let mode: 'normal' | 'keep' | 'legacy' = 'normal'

                const isTruthy = (s:string) => {
                    return s === 'true' || s === '1'
                }
                while(statement.length > 1){
                    const condition = statement.pop()
                    const operator = statement.pop()
                    switch(operator){
                        case 'not':{
                            if(isTruthy(condition)){
                                statement.push('0')
                            }
                            else{
                                statement.push('1')
                            }
                            break
                        }
                        case 'keep':{
                            mode = 'keep'
                            statement.push(condition)
                            break
                        }
                        case 'legacy':{
                            mode = 'legacy'
                            statement.push(condition)
                            break
                        }
                        case 'and':{
                            const condition2 = statement.pop()
                            if(isTruthy(condition) && isTruthy(condition2)){
                                statement.push('1')
                            }
                            else{
                                statement.push('0')
                            }
                            break
                        }
                        case 'or':{
                            const condition2 = statement.pop()
                            if(isTruthy(condition) || isTruthy(condition2)){
                                statement.push('1')
                            }
                            else{
                                statement.push('0')
                            }
                            break
                        }
                        case 'is':{
                            const condition2 = statement.pop()
                            if(condition === condition2){
                                statement.push('1')
                            }
                            else{
                                statement.push('0')
                            }
                            break
                        }
                        case 'isnot':{
                            const condition2 = statement.pop()
                            if(condition !== condition2){
                                statement.push('1')
                            }
                            else{
                                statement.push('0')
                            }
                            break
                        }
                        case 'var':{
                            const variable = getChatVar(condition)
                            if(isTruthy(variable)){
                                statement.push('1')
                            }
                            else{
                                statement.push('0')
                            }
                            break
                        }
                        case 'toggle':{
                            const variable = getGlobalChatVar('toggle_' + condition)
                            if(isTruthy(variable)){
                                statement.push('1')
                            }
                            else{
                                statement.push('0')
                            }
                            break
                        }
                        case 'vis':{ //vis = variable is
                            const variable = getChatVar(statement.pop())
                            if(variable === condition){
                                statement.push('1')
                            }
                            else{
                                statement.push('0')
                            }
                            break
                        }
                        case 'visnot':{ //visnot = variable is not
                            const variable = getChatVar(statement.pop())
                            if(variable !== condition){
                                statement.push('1')
                            }
                            else{
                                statement.push('0')
                            }
                            break
                        }
                        case 'tis':{ //tis = toggle is
                            const variable = getGlobalChatVar('toggle_' + statement.pop())
                            if(variable === condition){
                                statement.push('1')
                            }
                            else{
                                statement.push('0')
                            }
                            break
                        }
                        case 'tisnot':{ //tisnot = toggle is not
                            const variable = getGlobalChatVar('toggle_' + statement.pop())
                            if(variable !== condition){
                                statement.push('1')
                            }
                            else{
                                statement.push('0')
                            }
                            break
                        }
                        case '>':{
                            const condition2 = statement.pop()
                            if(parseFloat(condition2) > parseFloat(condition)){
                                statement.push('1')
                            }
                            else{
                                statement.push('0')
                            }
                            break
                        }
                        case '<':{
                            const condition2 = statement.pop()
                            if(parseFloat(condition2) < parseFloat(condition)){
                                statement.push('1')
                            }
                            else{
                                statement.push('0')
                            }
                            break
                        }
                        case '>=':{
                            const condition2 = statement.pop()
                            if(parseFloat(condition2) >= parseFloat(condition)){
                                statement.push('1')
                            }
                            else{
                                statement.push('0')
                            }
                            break
                        }
                        case '<=':{
                            const condition2 = statement.pop()
                            if(parseFloat(condition2) <= parseFloat(condition)){
                                statement.push('1')
                            }
                            else{
                                statement.push('0')
                            }
                            break
                        }
                        default:{
                            if(isTruthy(condition)){
                                statement.push('1')
                            }
                            else{
                                statement.push('0')
                            }
                            break
                        }
                    }
                }

                const finalCondition = statement[0]
                if(isTruthy(finalCondition)){
                    switch(mode){
                        case 'keep':{
                            return {type: 'newif', type2: 'keep'}
                        }
                        case 'legacy':{
                            return {type: 'parse'}
                        }
                        default:{
                            return {type: 'newif'}
                        }
                    }
                }
                else{
                    switch(mode){
                        case 'keep':{
                            return {type: 'newif-falsy', type2: 'keep'}
                        }
                        case 'legacy':{
                            return {type: 'ignore'}
                        }
                        default:{
                            return {type: 'newif-falsy'}
                        }
                    }
                }
            }
            else{
                return {type: 'newif-falsy'}
            }
        }
        if(p1 === '#pure'){
            return {type:'pure'}
        }
        if(p1 === '#pure_display' || p1 === '#puredisplay'){
            return {type:'pure-display'}
        }
        if(p1 === '#code'){
            return {type:'normalize'}
        }
        if(p1.startsWith('#escape')){
            const t2 = p1.substring(7).trim()
            const mode = t2 === '::keep' ? 'keep' : undefined
            return {type:'escape', mode}
        }
        if(p1.startsWith('#each')){
            let t2 = p1.substring(5).trim()
            let mode: string | undefined
            if(t2.startsWith('::keep ')){
                mode = 'keep'
                t2 = t2.substring(7).trim()
            }
            if(t2.startsWith('as ')){
                t2 = t2.substring(3).trim()
            }
            return {type:'each', type2:t2, mode}
        }
        if(p1.startsWith('#func')){
            const statement = p1.split(' ')
            if(statement.length > 1){
                return {type:'function',funcArg:statement.slice(1)}
            }

        }

        return {type:'nothing'}
    }

    // parser.svelte.ts:1462-1466
    function trimLines(p1:string){
        return p1.split('\n').map((v) => {
            return v.trimStart()
        }).join('\n').trim()
    }

    // parser.svelte.ts:1468-1571
    function blockEndMatcher(p1:string,type:{type:blockMatch,type2?:string,mode?:string},matcherArg:matcherArg):string{
        const p1Trimmed = p1.trim()
        switch(type.type){
            case 'pure':
            case 'pure-display':
            case 'function':{
                return p1Trimmed
            }
            case 'parse':{
                return trimLines(p1Trimmed)
            }
            case 'each':{
                if(type.mode === 'keep'){
                    return p1
                }
                return trimLines(p1Trimmed)
            }
            case 'ifpure':{
                return p1
            }
            case 'newif':
            case 'newif-falsy':{
                const lines =  p1.split("\n")

                if(lines.length === 1){
                    const elseIndex = p1.indexOf('{{:else}}')
                    if(elseIndex !== -1){
                        if(type.type === 'newif'){
                            return p1.substring(0, elseIndex)
                        }
                        if(type.type === 'newif-falsy'){
                            return p1.substring(elseIndex + 9)
                        }
                    }
                    else{
                        if(type.type === 'newif'){
                            return p1
                        }
                        if(type.type === 'newif-falsy'){
                            return ''
                        }
                    }
                }

                const elseLine = lines.findIndex((v) => {
                    return v.trim() === '{{:else}}'
                })

                if(elseLine !== -1 && type.type === 'newif'){
                    lines.splice(elseLine) //else line and everything after it is removed
                }
                if(elseLine !== -1 && type.type === 'newif-falsy'){
                    lines.splice(0, elseLine + 1) //everything before else line is removed
                }
                if(elseLine === -1 && type.type === 'newif-falsy'){
                    return ''
                }

                if(type.type2 !== 'keep'){
                    while(lines.length > 0 && lines[0].trim() === ''){
                        lines.shift()
                    }
                    while(lines.length > 0 && lines[lines.length - 1].trim() === ''){
                        lines.pop()
                    }
                }
                return lines.join('\n')
            }

            case 'normalize':{
                return p1Trimmed.trim().replaceAll('\n','').replaceAll('\t','')
                .replaceAll(/\\u([0-9A-Fa-f]{4})/g, (match, p1) => {
                    return String.fromCharCode(parseInt(p1, 16))
                })
                .replaceAll(/\\(.)/g, (match, p1) => {
                    switch(p1){
                        case 'n':
                            return '\n'
                        case 'r':
                            return '\r'
                        case 't':
                            return '\t'
                        case 'b':
                            return '\b'
                        case 'f':
                            return '\f'
                        case 'v':
                            return '\v'
                        case 'a':
                            return '\a'
                        case 'x':
                            return '\x00'
                        default:
                            return p1
                    }
                })
            }
            case 'escape':{
                return risuEscape(type.mode === 'keep' ? p1 : p1Trimmed)
            }
            default:{
                return ''
            }
        }
    }

    // parser.svelte.ts:1574-1849
    function risuChatParser(da:string, arg:RisuCbsParseArg = {}):string{
        const chatID = arg.chatID ?? -1
        const db = arg.db ?? deps.getDatabase()
        const aChara = arg.chara
        let chara:character|string = null

        if(aChara){
            if(typeof(aChara) !== 'string' && aChara.type === 'group'){
                if(aChara.chats[aChara.chatPage].message.length > 0){
                    const gc = deps.findCharacterbyId(aChara.chats[aChara.chatPage].message.at(-1).saying ?? '')
                    if(gc && gc.name !== 'Unknown Character'){
                        chara = gc
                    }
                }
                else{
                    chara = 'bot'
                }
            }
            else{
                chara = aChara
            }
        }
        if(arg.tokenizeAccurate){
            const db = arg.db ?? deps.getDatabase()
            const selchar = chara ?? db.characters[deps.getSelectedCharID()]
            if(!selchar){
                chara = 'bot'
            }
        }

        let pointer = 0;
        let nested:string[] = [""]
        let stackType = new Uint8Array(512)
        let pureModeNest:Map<number,boolean> = new Map()
        let pureModeNestType:Map<number,string> = new Map()
        let blockNestType:Map<number,{
            type:blockMatch,
            type2?:string
            funcArg?:string[]
            mode?:string
        }> = new Map()
        let commentMode = false
        let commentLatest:string[] = [""]
        let commentV = new Uint8Array(512)
        let thinkingMode = false
        let tempVar:{[key:string]:string} = {}
        let functions:Map<string,{
            data:string,
            arg:string[]
        }> = arg.functions ?? (new Map())

        arg.callStack = (arg.callStack ?? 0) + 1

        if(arg.callStack > 20){
            return 'ERROR: Call stack limit reached'
        }

        const matcherObj = {
            chatID: chatID,
            chara: chara,
            rmVar: arg.rmVar ?? false,
            db: db,
            var: arg.var ?? null,
            tokenizeAccurate: arg.tokenizeAccurate ?? false,
            displaying: arg.visualize ?? false,
            role: arg.role,
            runVar: arg.runVar ?? false,
            consistantChar: arg.consistantChar ?? false,
            cbsConditions: arg.cbsConditions ?? {},
            callStack: arg.callStack,
            getNested: () => {
                return nested
            },
            setNestedRoot: (val:string) => {
                nested[0] = val
            }
        }

        da = da.replace(/\<(user|char|bot)\>/gi, '{{$1}}')

        const isPureMode = () => {
            return pureModeNest.size > 0
        }

        while(pointer < da.length){
            switch(da[pointer]){
                case '{':{
                    if(da[pointer + 1] !== '{' && da[pointer + 1] !== '#'){
                        nested[0] += da[pointer]
                        break
                    }
                    pointer++
                    nested.unshift('')
                    stackType[nested.length] = 1
                    break
                }
                case '#':{
                    //legacy if statement, deprecated
                    if(da[pointer + 1] !== '}' || nested.length === 1 || stackType[nested.length] !== 1){
                        nested[0] += da[pointer]
                        break
                    }
                    pointer++
                    const dat = nested.shift()
                    const mc = legacyBlockMatcher(dat, matcherObj)
                    nested[0] += mc ?? `{#${dat}#}`
                    break
                }
                case '}':{
                    if(da[pointer + 1] !== '}' || nested.length === 1 || stackType[nested.length] !== 1){
                        nested[0] += da[pointer]
                        break
                    }
                    pointer++
                    const dat = nested.shift()
                    if(dat.startsWith('#') || dat.startsWith(':')){
                        if(isPureMode()){
                            nested[0] += `{{${dat}}}`
                            if (dat !== ':else') {
                                nested.unshift('')
                                stackType[nested.length] = 6
                            }
                            break
                        }
                        const matchResult = blockStartMatcher(dat, matcherObj)
                        if(matchResult.type === 'nothing'){
                            nested[0] += `{{${dat}}}`
                            break
                        }
                        else{
                            nested.unshift('')
                            stackType[nested.length] = 5
                            blockNestType.set(nested.length, matchResult)
                            if( matchResult.type === 'ignore' || matchResult.type === 'pure' ||
                                matchResult.type === 'each' || matchResult.type === 'function' ||
                                matchResult.type === 'pure-display' || matchResult.type === 'escape'
                            ){
                                pureModeNest.set(nested.length, true)
                                pureModeNestType.set(nested.length, "block")
                            }
                            break
                        }
                    }
                    if(dat.startsWith('/') && !dat.startsWith('//')){
                        if(stackType[nested.length] === 5){
                            const blockType = blockNestType.get(nested.length)
                            if( blockType.type === 'ignore' || blockType.type === 'pure' ||
                                blockType.type === 'each' || blockType.type === 'function' ||
                                blockType.type === 'pure-display' || blockType.type === 'escape'
                            ){
                                pureModeNest.delete(nested.length)
                                pureModeNestType.delete(nested.length)
                            }
                            blockNestType.delete(nested.length)
                            const dat2 = nested.shift()
                            const matchResult = blockEndMatcher(dat2, blockType, matcherObj)
                            if(blockType.type === 'each'){
                                const asIndex = blockType.type2.lastIndexOf(' as ')
                                let sub = blockType.type2.substring(asIndex + 4).trim()
                                let array = parseArray(blockType.type2.substring(0, asIndex))
                                if(asIndex === -1){
                                    //compability mode
                                    const subind = blockType.type2.lastIndexOf(' ')
                                    if(subind === -1){
                                        break
                                    }
                                    sub = blockType.type2.substring(subind + 1)
                                    array = parseArray(blockType.type2.substring(0, subind))
                                }
                                let added = ''
                                for(let i = 0; i < array.length; i++) {
                                    added += matchResult.replaceAll(`{{slot::${sub}}}`, typeof(array[i]) === 'string' ? array[i] as string : JSON.stringify(array[i]))
                                }
                                da = da.substring(0, pointer + 1) + (blockType.mode === 'keep' ? added : added.trim()) + da.substring(pointer + 1)
                                break
                            }
                            if(blockType.type === 'function'){
                                functions.set(blockType.funcArg[0], {
                                    data: matchResult,
                                    arg: blockType.funcArg.slice(1)
                                })
                                break
                            }
                            if(blockType.type === 'pure-display'){
                                nested[0] += matchResult.replaceAll('{{', '\\{\\{').replaceAll('}}', '\\}\\}')
                                break
                            }
                            if(matchResult === ''){
                                break
                            }
                            nested[0] += matchResult
                            break
                        }
                        if(stackType[nested.length] === 6){
                            const sft = nested.shift()
                            nested[0] += sft + `{{${dat}}}`
                            break
                        }
                    }
                    if(dat.startsWith('call::')){
                        if(arg.callStack && arg.callStack > 20){
                            nested[0] += `ERROR: Call stack limit reached`
                            break
                        }
                        const argData = dat.split('::').slice(1)
                        const funcName = argData[0]
                        const func = functions.get(funcName)
                        if(func){
                            let data = func.data
                            for(let i = 0;i < argData.length;i++){
                                data = data.replaceAll(`{{arg::${i}}}`, argData[i])
                            }
                            arg.functions = functions
                            nested[0] += risuChatParser(data, arg)
                            break
                        }
                    }
                    const mc = isPureMode() ? null :matcher(dat, matcherObj, tempVar)
                    if(!mc && mc !== ''){
                        nested[0] += `{{${dat}}}`
                    }
                    else if(typeof(mc) === 'string'){
                        nested[0] += mc
                    }
                    else{
                        nested[0] += mc.text
                        tempVar = mc.var
                        if(tempVar['__force_return__']){
                            return tempVar['__return__'] ?? 'null'
                        }
                    }
                    break
                }
                default:{
                    nested[0] += da[pointer]
                    break
                }
            }
            pointer++
        }
        if(commentMode){
            nested = commentLatest
            stackType = commentV
            if(thinkingMode){
                nested[0] += `<div>Thinking...</div>`
            }
            commentMode = false
        }
        if(nested.length === 1){
            return nested[0]
        }
        let result = ''
        while(nested.length > 1){
            let dat = (stackType[nested.length] === 1) ? '{{' : "<"
            dat += nested.shift()
            result = dat + result
        }
        return nested[0] + result
    }

    const parse = (text: string, arg: RisuCbsParseArg = {}): RisuCbsResult => {
        const previous = unsupportedCollector
        const collected: string[] = []
        unsupportedCollector = collected
        try {
            // risuChatParser mutates arg.callStack, so parse never hands the caller's object to it.
            return { text: risuChatParser(text, { ...arg }), unsupported: collected }
        } catch (error) {
            return {
                text: '',
                unsupported: collected,
                error: error instanceof Error ? error.message : String(error),
            }
        } finally {
            unsupportedCollector = previous
        }
    }

    return { parse }
}
