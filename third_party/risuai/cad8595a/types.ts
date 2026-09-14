// SPDX-License-Identifier: GPL-3.0-only
// Snapshot of RisuAI (https://github.com/kwaroran/RisuAI) at commit cad8595aa39620df4246f56918f0962c2aa0263a.
// Upstream sources: src/ts/storage/database.svelte.ts:28,782-790,1287-1304,1308-1316,1318,1320-1341,1343-1499,1502-1507,1510-1580,1582-1685,1694-1701,1815,1817-1882,1893-1937
//   src/ts/process/triggers.ts:20-105,109-983
//   src/ts/process/prompt.ts:7-66
//   src/ts/process/modules.ts:15-35
//   src/ts/process/index.svelte.ts:37-47,80-85
//   src/ts/process/transformers.ts:106-110
//   src/ts/process/models/nai.ts:53-70
//   src/ts/process/memory/hypav2.ts:15-37
//   src/ts/process/memory/hypav3.ts:53-87
//   src/ts/model/ooba.ts:1-48
//   src/ts/model/types.ts:3-32,55-81
//   src/lib/Others/HypaV3Modal/types.ts:90-96
//   src/ts/characterCards.ts:1526-1530,1905-1952,1955-1967,1968-1976,1978-2000,2002-2004
//   src/ts/plugins/plugins.svelte.ts:17-36,432-448
// Copyright (c) Kwaroran and the RisuAI contributors. Licensed under GPL-3.0-only; see ./LICENSE.
// Modifications for Uimori: type-only extraction, Svelte store and UI-only members removed, no runtime code.
//   Dropped members: none. Every interface copied below is a plain persisted-data shape, so no member was
//   removed; the Svelte stores, `DBState` runes, component props and DOM-facing declarations that sit
//   beside them upstream were simply not copied, and neither were the functions and default-value
//   constants that share those files.
//   Not copied by design: `Database` (the whole app-settings root), `CustomSideBarItem`, `RisuPersona`,
//   `PromptDiffPrefs`, `hubType` and the Realm/hub networking shapes - none of them describe a Risu
//   file format.
//   Converted away from runtime values: `LLMFlags`, `LLMFormat` (src/ts/model/types.ts) and
//   `DISPLAY_MODE` (src/lib/Others/HypaV3Modal/types.ts) are `as const` objects upstream whose types are
//   derived with `(typeof X)[keyof typeof X]`. Only the resulting literal unions appear here; the
//   name-to-value mapping is kept as a comment so the stored numbers stay readable.
//   Type aliases resolved: upstream `database.svelte.ts` re-exports `triggerscript` as an alias of
//   `triggers.ts`'s `triggerscript`; here the interface is declared once, under that name.
//   Naming: nothing needed renaming, but note that `Lorebook` / `LorebookEntry` (CCv3 spec) and
//   `loreBook` (Risu database) are different types despite the near-identical names.
//   Exported here but not upstream, so that the types depending on them resolve: `AINsettings`,
//   `HypaV3Data`, `Summary`, `CharacterCardV2Risu`, `RisuLorebookEntry`, `OldTavernChar`,
//   `CharacterBook`, `charBookEntry`, `RccCardMetaData`, `ProviderPlugin`, `ProviderPluginCustomLink`.
//
// The character-card spec types RisuAI imports from `@risuai/ccardlib` (src/ts/characterCards.ts:13)
// are MIT licensed, not GPL, so they live in ./ccardlib-types.ts under their own header and are
// re-exported from here for convenience. `CharacterBook` below is RisuAI's own V2 shape and is a
// different type from the `CharacterBook` in that file.

import type {
    CharacterCardV2,
    CharacterCardV3,
    CharacterCardV3Asset,
    Lorebook,
    LorebookEntry,
} from './ccardlib-types.js'

export type { CharacterCardV2, CharacterCardV3, CharacterCardV3Asset, Lorebook, LorebookEntry }

/* ------------------------------------------------------------------------------------------------ *
 * Card types RisuAI declares itself (src/ts/characterCards.ts)
 * ------------------------------------------------------------------------------------------------ */

/** Extended LorebookEntry with Risuai specific fields */
export type RisuLorebookEntry = LorebookEntry & {
    mode?: string;
    folder?: string;
}

/**
 * RisuAI's own V2 card shape. It narrows `extensions` to the members Risu reads and writes, so it is
 * kept separate from the spec's `CharacterCardV2` above.
 */
export type CharacterCardV2Risu = {
    spec: 'chara_card_v2'
    spec_version: '2.0' // May 8th addition
    data: {
        name: string
        description: string
        personality: string
        scenario: string
        first_mes: string
        mes_example: string
        creator_notes: string
        system_prompt: string
        post_history_instructions: string
        alternate_greetings: string[]
        character_book?: CharacterBook
        tags: string[]
        creator: string
        character_version: string
        extensions: {
            risuai?:{
                emotions?:[string, string][]
                bias?:[string, number][],
                viewScreen?: any,
                customScripts?:customscript[]
                utilityBot?: boolean,
                sdData?:[string,string][],
                additionalAssets?:[string,string,string][],
                backgroundHTML?:string,
                license?:string,
                triggerscript?:triggerscript[]
                private?:boolean
                additionalText?:string
                virtualscript?:string
                largePortrait?:boolean
                lorePlus?:boolean
                inlayViewScreen?:boolean
                newGenData?: {
                    prompt: string,
                    negative: string,
                    instructions: string,
                    emotionInstructions: string,
                },
                vits?: {[key:string]:string}
            }
            depth_prompt?: { depth: number, prompt: string }
        }
    }
}

export interface OldTavernChar{
    avatar: "none"
    chat: string
    create_date: string
    description: string
    first_mes: string
    mes_example: string
    name: string
    personality: string
    scenario: string
    talkativeness: "0.5"
    spec_version?: '1.0'
}

export type CharacterBook = {
    name?: string
    description?: string
    scan_depth?: number // agnai: "Memory: Chat History Depth"
    token_budget?: number // agnai: "Memory: Context Limit"
    recursive_scanning?: boolean // no agnai equivalent. whether entry content can trigger other entries
    extensions: Record<string, any>
    entries: Array<charBookEntry>
  }

export interface charBookEntry{
    keys: Array<string>
    content: string
    extensions: Record<string, any>
    enabled: boolean
    insertion_order: number // if two entries inserted, lower "insertion order" = inserted higher

    // FIELDS WITH NO CURRENT EQUIVALENT IN SILLY
    name?: string // not used in prompt engineering
    priority?: number // if token budget reached, lower priority value = discarded first

    // FIELDS WITH NO CURRENT EQUIVALENT IN AGNAI
    id?: number // not used in prompt engineering
    comment?: string // not used in prompt engineering
    selective?: boolean // if `true`, require a key from both `keys` and `secondary_keys` to trigger the entry
    secondary_keys?: Array<string> // see field `selective`. ignored if selective == false
    constant?: boolean // if true, always inserted in the prompt (within budget limit)
    position?: 'before_char' | 'after_char' // whether the entry is placed before or after the character defs
    case_sensitive?:boolean
    use_regex?:boolean
    mode?: string // Risuai mode field
    folder?: string // Risuai folder field
}

/** Header of an encrypted `.rcc` card. */
export interface RccCardMetaData{
    usePassword?: boolean
}

/* ------------------------------------------------------------------------------------------------ *
 * Lorebook and script types stored in the Risu database (src/ts/storage/database.svelte.ts)
 * ------------------------------------------------------------------------------------------------ */

/** Regex script. `in` is the pattern, `out` the replacement, `type` the hook it runs on. */
export interface customscript{
    comment: string;
    in:string
    out:string
    type:string
    flag?:string
    ableFlag?:boolean

}

export interface loreBook{
    key:string
    secondkey:string
    insertorder: number
    comment: string
    content: string
    mode: 'multiple'|'constant'|'normal'|'child'|'folder',
    alwaysActive: boolean
    selective:boolean
    extentions?:{
        risu_case_sensitive:boolean
    }
    activationPercent?:number
    loreCache?:{
        key:string
        data:string[]
    },
    useRegex?:boolean
    bookVersion?:number
    id?:string
    folder?:string
}

export interface loreSettings{
    tokenBudget: number
    scanDepth:number
    recursiveScanning: boolean
    fullWordMatching?: boolean
}

/* ------------------------------------------------------------------------------------------------ *
 * Trigger scripts (src/ts/process/triggers.ts)
 * ------------------------------------------------------------------------------------------------ */

/**
 * Upstream `database.svelte.ts` imports this as `triggerscriptMain` and re-exports it as
 * `export type triggerscript = triggerscriptMain`; the alias is resolved here.
 */
export interface triggerscript{
    comment: string;
    type: 'start'|'manual'|'output'|'input'|'display'|'request'
    conditions: triggerCondition[]
    effect:triggerEffect[]
    lowLevelAccess?: boolean
}

export type triggerCondition = triggerConditionsVar|triggerConditionsExists|triggerConditionsChatIndex

export type triggerEffect = triggerEffectV1|triggerCode|triggerEffectV2
export type triggerEffectV1 = triggerEffectCutChat|triggerEffectModifyChat|triggerEffectImgGen|triggerEffectRegex|triggerEffectRunLLM|triggerEffectCheckSimilarity|triggerEffectSendAIprompt|triggerEffectShowAlert|triggerEffectSetvar|triggerEffectSystemPrompt|triggerEffectImpersonate|triggerEffectCommand|triggerEffectStop|triggerEffectRunTrigger|triggerEffectRunAxLLM
export type triggerEffectV2 =   triggerV2Header|triggerV2IfVar|triggerV2Else|triggerV2EndIndent|triggerV2SetVar|triggerV2Loop|triggerV2BreakLoop|
                                triggerV2RunTrigger|triggerV2ConsoleLog|triggerV2StopTrigger|triggerV2CutChat|triggerV2ModifyChat|triggerV2SystemPrompt|triggerV2Impersonate|
                                triggerV2Command|triggerV2SendAIprompt|triggerV2ImgGen|triggerV2CheckSimilarity|triggerV2RunLLM|triggerV2ShowAlert|triggerV2ExtractRegex|
                                triggerV2GetLastMessage|triggerV2GetMessageAtIndex|triggerV2GetMessageCount|
                                triggerV2ModifyLorebook|triggerV2GetLorebook|triggerV2GetLorebookCount|triggerV2GetLorebookEntry|
                                triggerV2SetLorebookActivation|triggerV2GetLorebookIndexViaName|triggerV2LoopNTimes|triggerV2Random|triggerV2GetCharAt|
                                triggerV2GetCharCount|triggerV2ToLowerCase|triggerV2ToUpperCase|triggerV2SetCharAt|triggerV2SplitString|triggerV2JoinArrayVar|triggerV2GetCharacterDesc|
                                triggerV2SetCharacterDesc|triggerV2GetPersonaDesc|triggerV2SetPersonaDesc|triggerV2MakeArrayVar|triggerV2GetArrayVarLength|triggerV2GetArrayVar|triggerV2SetArrayVar|
                                triggerV2PushArrayVar|triggerV2PopArrayVar|triggerV2ShiftArrayVar|triggerV2UnshiftArrayVar|triggerV2SpliceArrayVar|triggerV2GetFirstMessage|
                                triggerV2SliceArrayVar|triggerV2GetIndexOfValueInArrayVar|triggerV2RemoveIndexFromArrayVar|triggerV2ConcatString|triggerV2GetLastUserMessage|
                                triggerV2GetLastCharMessage|triggerV2GetAlertInput|triggerV2GetAlertSelect|triggerV2GetDisplayState|triggerV2SetDisplayState|triggerV2UpdateGUI|triggerV2UpdateChatAt|triggerV2Wait|
                                triggerV2GetRequestState|triggerV2SetRequestState|triggerV2GetRequestStateRole|triggerV2SetRequestStateRole|triggerV2GetRequestStateLength|triggerV2IfAdvanced|
                                triggerV2QuickSearchChat|triggerV2StopPromptSending|triggerV2Tokenize|triggerV2GetAllLorebooks|triggerV2GetLorebookByName|triggerV2GetLorebookByIndex|
                                triggerV2CreateLorebook|triggerV2ModifyLorebookByIndex|triggerV2DeleteLorebookByIndex|triggerV2GetLorebookCountNew|triggerV2SetLorebookAlwaysActive|
                                triggerV2RegexTest|triggerV2GetReplaceGlobalNote|triggerV2SetReplaceGlobalNote|
                                triggerV2GetAuthorNote|triggerV2SetAuthorNote|triggerV2MakeDictVar|triggerV2GetDictVar|triggerV2SetDictVar|triggerV2DeleteDictKey|
                                triggerV2HasDictKey|triggerV2ClearDict|triggerV2GetDictSize|triggerV2GetDictKeys|triggerV2GetDictValues|triggerV2Calculate|triggerV2ReplaceString|triggerV2Comment|
                                triggerV2DeclareLocalVar

export type triggerConditionsVar = {
    type:'var'|'value'
    var:string
    value:string
    operator:'='|'!='|'>'|'<'|'>='|'<='|'null'|'true'
}

export type triggerCode = {
    type: 'triggercode'|'triggerlua',
    code: string
}

export type triggerConditionsChatIndex = {
    type:'chatindex'
    value:string
    operator:'='|'!='|'>'|'<'|'>='|'<='|'null'|'true'
}

export type triggerConditionsExists ={
    type: 'exists'
    value:string
    type2: 'strict'|'loose'|'regex',
    depth: number
}

export interface triggerEffectSetvar{
    type: 'setvar',
    operator: '='|'+='|'-='|'*='|'/='
    var:string
    value:string
}

export interface triggerEffectCutChat{
    type: 'cutchat',
    start: string,
    end: string
}

export interface triggerEffectModifyChat{
    type: 'modifychat',
    index: string,
    value: string
}

export interface triggerEffectSystemPrompt{
    type: 'systemprompt',
    location: 'start'|'historyend'|'promptend',
    value:string
}

export interface triggerEffectImpersonate{
    type: 'impersonate'
    role: 'user'|'char',
    value:string
}

export interface triggerEffectCommand{
    type: 'command',
    value: string
}

export interface triggerEffectRegex{
    type: 'extractRegex',
    value: string
    regex: string
    flags: string
    result: string
    inputVar: string
}

export interface triggerEffectShowAlert{
    type: 'showAlert',
    alertType: string
    value: string
    inputVar: string
}

export interface triggerEffectRunTrigger{
    type: 'runtrigger',
    value: string
}

export interface triggerEffectStop{
    type: 'stop'
}

export interface triggerEffectSendAIprompt{
    type: 'sendAIprompt'
}

export interface triggerEffectImgGen{
    type: 'runImgGen',
    value: string,
    negValue: string,
    inputVar: string
}


export interface triggerEffectCheckSimilarity{
    type: 'checkSimilarity',
    source: string,
    value: string,
    inputVar: string
}

export interface triggerEffectRunLLM{
    type: 'runLLM',
    value: string,
    inputVar: string
}

export interface triggerEffectRunAxLLM{
    type: 'runAxLLM',
    value: string,
    inputVar: string
}

export type additonalSysPrompt = {
    start:string,
    historyend: string,
    promptend: string
}

export type triggerV2Header = {
    type: 'v2Header',
    code?: string,
    indent: number
}

export type triggerV2IfVar = {
    type: 'v2If',
    condition: '='|'!='|'>'|'<'|'>='|'<=',
    targetType: 'var'|'value',
    target: string,
    source: string,
    indent: number
}

export type triggerV2Else = {
    type: 'v2Else'
    indent: number
}

export type triggerV2EndIndent = {
    type: 'v2EndIndent',
    endOfLoop?: boolean,
    indent: number
}

export type triggerV2SetVar = {
    type: 'v2SetVar',
    operator: '='|'+='|'-='|'*='|'/='|'%=',
    var: string,
    valueType: 'var'|'value',
    value: string,
    indent: number
}

export type triggerV2Loop = {
    type: 'v2Loop',
    indent: number
}

export type triggerV2LoopNTimes = {
    type: 'v2LoopNTimes',
    value: string,
    valueType: 'var'|'value',
    indent: number
}

export type triggerV2BreakLoop = {
    type: 'v2BreakLoop',
    indent: number
}

export type triggerV2RunTrigger = {
    type: 'v2RunTrigger',
    target: string,
    indent: number
}

export type triggerV2ConsoleLog = {
    type: 'v2ConsoleLog',
    sourceType: 'var'|'value',
    source: string,
    indent: number
}

export type triggerV2StopTrigger = {
    type: 'v2StopTrigger',
    indent: number
}

export type triggerV2CutChat = {
    type: 'v2CutChat',
    start: string,
    startType: 'var'|'value',
    end: string,
    endType: 'var'|'value',
    indent: number
}

export type triggerV2ModifyChat = {
    type: 'v2ModifyChat',
    index: string,
    indexType: 'var'|'value',
    value: string,
    valueType: 'var'|'value',
    indent: number
}

export type triggerV2SystemPrompt = {
    type: 'v2SystemPrompt',
    location: 'start'|'historyend'|'promptend',
    value: string,
    valueType: 'var'|'value',
    indent: number
}

export type triggerV2Impersonate = {
    type: 'v2Impersonate',
    role: 'user'|'char',
    value: string,
    valueType: 'var'|'value',
    indent: number
}

export type triggerV2Command = {
    type: 'v2Command',
    value: string,
    valueType: 'var'|'value',
    indent: number
}

export type triggerV2SendAIprompt = {
    type: 'v2SendAIprompt',
    indent: number
}

export type triggerV2ImgGen = {
    type: 'v2ImgGen',
    value: string,
    valueType: 'var'|'value',
    negValue: string,
    negValueType: 'var'|'value',
    outputVar: string,
    indent: number
}

export type triggerV2CheckSimilarity = {
    type: 'v2CheckSimilarity',
    source: string,
    sourceType: 'var'|'value',
    value: string,
    valueType: 'var'|'value',
    outputVar: string,
    indent: number
}

export type triggerV2RunLLM = {
    type: 'v2RunLLM',
    value: string,
    valueType: 'var'|'value',
    model: 'model'|'submodel',
    streaming?: boolean,
    outputVar: string,
    indent: number
}

export type triggerV2ShowAlert = {
    type: 'v2ShowAlert',
    value: string,
    valueType: 'var'|'value',
    indent: number
}

export type triggerV2ExtractRegex = {
    type: 'v2ExtractRegex',
    value: string,
    valueType: 'var'|'value',
    regex: string,
    regexType: 'var'|'value',
    flags: string,
    flagsType: 'var'|'value',
    result: string,
    resultType: 'var'|'value',
    outputVar: string,
    indent: number
}

export type triggerV2GetLastMessage = {
    type: 'v2GetLastMessage',
    outputVar: string,
    indent: number
}

export type triggerV2GetMessageAtIndex = {
    type: 'v2GetMessageAtIndex',
    index: string,
    indexType: 'var'|'value',
    outputVar: string,
    indent: number
}

export type triggerV2GetMessageCount = {
    type: 'v2GetMessageCount',
    outputVar: string,
    indent: number
}

export type triggerV2ModifyLorebook = {
    type: 'v2ModifyLorebook',
    target: string,
    targetType: 'var'|'value',
    value: string,
    valueType: 'var'|'value',
    indent: number
}

export type triggerV2GetLorebook = {
    type: 'v2GetLorebook',
    target: string,
    targetType: 'var'|'value',
    outputVar: string,
    indent: number
}

export type triggerV2GetLorebookCount = {
    type: 'v2GetLorebookCount',
    outputVar: string,
    indent: number
}

export type triggerV2GetLorebookEntry = {
    type: 'v2GetLorebookEntry',
    index: string,
    indexType: 'var'|'value',
    outputVar: string,
    indent: number
}

export type triggerV2SetLorebookActivation = {
    type: 'v2SetLorebookActivation',
    index: string,
    indexType: 'var'|'value',
    value: boolean,
    indent: number
}

export type triggerV2GetLorebookIndexViaName = {
    type: 'v2GetLorebookIndexViaName',
    name: string,
    nameType: 'var'|'value',
    outputVar: string,
    indent: number
}

export type triggerV2Random = {
    type: 'v2Random',
    min: string,
    minType: 'var'|'value',
    max: string,
    maxType: 'var'|'value',
    outputVar: string,
    indent: number
}

export type triggerV2GetCharAt = {
    type: 'v2GetCharAt',
    source: string,
    sourceType: 'var'|'value',
    index: string,
    indexType: 'var'|'value',
    outputVar: string,
    indent: number
}

export type triggerV2GetCharCount = {
    type: 'v2GetCharCount',
    source: string,
    sourceType: 'var'|'value',
    outputVar: string,
    indent: number
}

export type triggerV2ToLowerCase = {
    type: 'v2ToLowerCase',
    source: string,
    sourceType: 'var'|'value',
    outputVar: string,
    indent: number
}

export type triggerV2ToUpperCase = {
    type: 'v2ToUpperCase',
    source: string,
    sourceType: 'var'|'value',
    outputVar: string,
    indent: number
}

export type triggerV2SetCharAt = {
    type: 'v2SetCharAt',
    source: string,
    sourceType: 'var'|'value',
    index: string,
    indexType: 'var'|'value',
    value: string,
    valueType: 'var'|'value',
    outputVar: string,
    indent: number
}

export type triggerV2SplitString = {
    type: 'v2SplitString',
    source: string,
    sourceType: 'var'|'value',
    delimiter: string,
    delimiterType: 'var'|'value'|'regex',
    outputVar: string,
    indent: number
}

export type triggerV2JoinArrayVar = {
    type: 'v2JoinArrayVar',
    var: string,
    varType: 'var'|'value',
    delimiter: string,
    delimiterType: 'var'|'value',
    outputVar: string,
    indent: number
}

export type triggerV2GetCharacterDesc = {
    type: 'v2GetCharacterDesc',
    outputVar: string,
    indent: number
}

export type triggerV2SetCharacterDesc = {
    type: 'v2SetCharacterDesc',
    value: string,
    valueType: 'var'|'value',
    indent: number
}

export type triggerV2GetPersonaDesc = {
    type: 'v2GetPersonaDesc',
    outputVar: string,
    indent: number
}

export type triggerV2SetPersonaDesc = {
    type: 'v2SetPersonaDesc',
    value: string,
    valueType: 'var'|'value',
    indent: number
}

export type triggerV2MakeArrayVar = {
    type: 'v2MakeArrayVar',
    var: string,
    indent: number
}

export type triggerV2GetArrayVarLength = {
    type: 'v2GetArrayVarLength',
    var: string,
    outputVar: string,
    indent: number
}

export type triggerV2GetArrayVar = {
    type: 'v2GetArrayVar',
    var: string,
    index: string,
    indexType: 'var'|'value',
    outputVar: string,
    indent: number
}

export type triggerV2SetArrayVar = {
    type: 'v2SetArrayVar',
    var: string,
    index: string,
    indexType: 'var'|'value',
    value: string,
    valueType: 'var'|'value',
    indent: number
}

export type triggerV2PushArrayVar = {
    type: 'v2PushArrayVar',
    var: string,
    value: string,
    valueType: 'var'|'value',
    indent: number
}

export type triggerV2PopArrayVar = {
    type: 'v2PopArrayVar',
    var: string,
    outputVar: string,
    indent: number
}

export type triggerV2ShiftArrayVar = {
    type: 'v2ShiftArrayVar',
    var: string,
    outputVar: string,
    indent: number
}

export type triggerV2UnshiftArrayVar = {
    type: 'v2UnshiftArrayVar',
    var: string,
    value: string,
    valueType: 'var'|'value',
    indent: number
}

export type triggerV2SpliceArrayVar = {
    type: 'v2SpliceArrayVar',
    var: string,
    start: string,
    startType: 'var'|'value',
    item: string,
    itemType: 'var'|'value',
    indent: number
}

export type triggerV2SliceArrayVar = {
    type: 'v2SliceArrayVar',
    var: string,
    start: string,
    startType: 'var'|'value',
    end: string,
    endType: 'var'|'value',
    outputVar: string,
    indent: number
}

export type triggerV2GetIndexOfValueInArrayVar = {
    type: 'v2GetIndexOfValueInArrayVar',
    var: string,
    value: string,
    valueType: 'var'|'value',
    outputVar: string,
    indent: number
}

export type triggerV2RemoveIndexFromArrayVar = {
    type: 'v2RemoveIndexFromArrayVar',
    var: string,
    index: string,
    indexType: 'var'|'value',
    indent: number
}

export type triggerV2ConcatString = {
    type: 'v2ConcatString',
    source1: string,
    source1Type: 'var'|'value',
    source2: string,
    source2Type: 'var'|'value',
    outputVar: string,
    indent: number
}

export type triggerV2GetLastUserMessage = {
    type: 'v2GetLastUserMessage',
    outputVar: string,
    indent: number
}

export type triggerV2GetLastCharMessage = {
    type: 'v2GetLastCharMessage',
    outputVar: string,
    indent: number
}

export type triggerV2GetFirstMessage = {
    type: 'v2GetFirstMessage',
    outputVar: string,
    indent: number
}

export type triggerV2GetAlertInput = {
    type: 'v2GetAlertInput',
    display: string,
    displayType: 'var'|'value',
    outputVar: string,
    indent: number
}

export type triggerV2GetDisplayState = {
    type: 'v2GetDisplayState',
    outputVar: string,
    indent: number
}

export type triggerV2SetDisplayState = {
    type: 'v2SetDisplayState',
    value: string,
    valueType: 'var'|'value',
    indent: number
}

export type triggerV2GetRequestState = {
    type: 'v2GetRequestState',
    outputVar: string,
    index: string,
    indexType: 'var'|'value',
    indent: number
}

export type triggerV2GetRequestStateRole = {
    type: 'v2GetRequestStateRole',
    outputVar: string,
    index: string,
    indexType: 'var'|'value',
    indent: number
}

export type triggerV2SetRequestState = {
    type: 'v2SetRequestState',
    value: string,
    valueType: 'var'|'value',
    index: string,
    indexType: 'var'|'value',
    indent: number
}

export type triggerV2SetRequestStateRole = {
    type: 'v2SetRequestStateRole',
    value: string,
    valueType: 'var'|'value',
    index: string,
    indexType: 'var'|'value',
    indent: number
}

export type triggerV2GetRequestStateLength = {
    type: 'v2GetRequestStateLength',
    outputVar: string,
    indent: number
}

export type triggerV2UpdateGUI = {
    type: 'v2UpdateGUI',
    indent: number
}

export type triggerV2UpdateChatAt = {
    type: 'v2UpdateChatAt',
    index: string,
    indent: number
}

export type triggerV2Wait = {
    type: 'v2Wait',
    value: string,
    valueType: 'var'|'value',
    indent: number
}

export type triggerV2IfAdvanced = {
    type: 'v2IfAdvanced',
    condition: '='|'!='|'>'|'<'|'>='|'<='|'≒'|'∋'|'∈'|'∌'|'∉'|'≡'
    targetType: 'var'|'value',
    target: string,
    sourceType: 'var'|'value',
    source: string,
    indent: number
}

export type triggerV2QuickSearchChat = {
    type: 'v2QuickSearchChat',
    value: string,
    valueType: 'var'|'value',
    condition: 'loose'|'strict'|'regex',
    depth: string,
    depthType: 'var'|'value',
    outputVar: string,
    indent: number
}

export type triggerV2StopPromptSending = {
    type: 'v2StopPromptSending',
    indent: number
}

export type triggerV2Tokenize = {
    type: 'v2Tokenize',
    indent: number,
    value: string
    valueType: "var"|"value"
    outputVar:string
}

export type triggerV2GetAllLorebooks = {
    type: 'v2GetAllLorebooks',
    outputVar: string,
    indent: number
}
export type triggerV2RegexTest = {
    type: 'v2RegexTest',
    value: string,
    valueType: 'var'|'value',
    regex: string,
    regexType: 'var'|'value',
    flags: string,
    flagsType: 'var'|'value',
    outputVar: string,
    indent: number
}

export type triggerV2GetLorebookByName = {
    type: 'v2GetLorebookByName',
    name: string,
    nameType: 'var'|'value',
    outputVar: string,
    indent: number
}

export type triggerV2GetLorebookByIndex = {
    type: 'v2GetLorebookByIndex',
    index: string,
    indexType: 'var'|'value',
    outputVar: string,
    indent: number
}

export type triggerV2CreateLorebook = {
    type: 'v2CreateLorebook',
    name: string,
    nameType: 'var'|'value',
    key: string,
    keyType: 'var'|'value',
    content: string,
    contentType: 'var'|'value',
    insertOrder: string,
    insertOrderType: 'var'|'value',
    indent: number
}

export type triggerV2ModifyLorebookByIndex = {
    type: 'v2ModifyLorebookByIndex',
    index: string,
    indexType: 'var'|'value',
    name: string,
    nameType: 'var'|'value',
    key: string,
    keyType: 'var'|'value',
    content: string,
    contentType: 'var'|'value',
    insertOrder: string,
    insertOrderType: 'var'|'value',
    indent: number
}

export type triggerV2DeleteLorebookByIndex = {
    type: 'v2DeleteLorebookByIndex',
    index: string,
    indexType: 'var'|'value',
    indent: number
}

export type triggerV2GetLorebookCountNew = {
    type: 'v2GetLorebookCountNew',
    outputVar: string,
    indent: number
}

export type triggerV2SetLorebookAlwaysActive = {
    type: 'v2SetLorebookAlwaysActive',
    index: string,
    indexType: 'var'|'value',
    value: boolean,
    indent: number
}

export type triggerV2GetAlertSelect = {
    type: 'v2GetAlertSelect',
    display: string,
    displayType: 'var'|'value',
    value: string,
    valueType: 'var'|'value',
    outputVar: string,
    indent: number
}

export type triggerV2GetReplaceGlobalNote = {
    type: 'v2GetReplaceGlobalNote',
    outputVar: string,
    indent: number
}

export type triggerV2SetReplaceGlobalNote = {
    type: 'v2SetReplaceGlobalNote',
    value: string,
    valueType: 'var'|'value',
    indent: number
}

export type triggerV2GetAuthorNote = {
    type: 'v2GetAuthorNote',
    outputVar: string,
    indent: number
}

export type triggerV2SetAuthorNote = {
    type: 'v2SetAuthorNote',
    value: string,
    valueType: 'var'|'value',
    indent: number
}

export type triggerV2MakeDictVar = {
    type: 'v2MakeDictVar',
    var: string,
    indent: number
}

export type triggerV2GetDictVar = {
    type: 'v2GetDictVar',
    var: string,
    varType: 'var'|'value',
    key: string,
    keyType: 'var'|'value',
    outputVar: string,
    indent: number
}

export type triggerV2SetDictVar = {
    type: 'v2SetDictVar',
    var: string,
    varType: 'var'|'value',
    key: string,
    keyType: 'var'|'value',
    value: string,
    valueType: 'var'|'value',
    indent: number
}

export type triggerV2DeleteDictKey = {
    type: 'v2DeleteDictKey',
    var: string,
    varType: 'var'|'value',
    key: string,
    keyType: 'var'|'value',
    indent: number
}

export type triggerV2HasDictKey = {
    type: 'v2HasDictKey',
    var: string,
    varType: 'var'|'value',
    key: string,
    keyType: 'var'|'value',
    outputVar: string,
    indent: number
}

export type triggerV2ClearDict = {
    type: 'v2ClearDict',
    var: string,
    indent: number
}

export type triggerV2GetDictSize = {
    type: 'v2GetDictSize',
    var: string,
    varType: 'var'|'value',
    outputVar: string,
    indent: number
}

export type triggerV2GetDictKeys = {
    type: 'v2GetDictKeys',
    var: string,
    varType: 'var'|'value',
    outputVar: string,
    indent: number
}

export type triggerV2GetDictValues = {
    type: 'v2GetDictValues',
    var: string,
    varType: 'var'|'value',
    outputVar: string,
    indent: number
}

export type triggerV2Calculate = {
    type: 'v2Calculate',
    expression: string,
    expressionType: 'var'|'value',
    outputVar: string,
    indent: number
}

export type triggerV2ReplaceString = {
    type: 'v2ReplaceString',
    source: string,
    sourceType: 'var'|'value',
    regex: string,
    regexType: 'var'|'value',
    result: string,
    resultType: 'var'|'value',
    replacement: string,
    replacementType: 'var'|'value',
    flags: string,
    flagsType: 'var'|'value',
    outputVar: string,
    indent: number
}

export type triggerV2Comment = {
    type: 'v2Comment',
    value: string,
    indent: number
}

export type triggerV2DeclareLocalVar = {
    type: 'v2DeclareLocalVar',
    var: string,
    value: string,
    valueType: 'var'|'value',
    indent: number
}

/* ------------------------------------------------------------------------------------------------ *
 * Characters and group chats (src/ts/storage/database.svelte.ts)
 * ------------------------------------------------------------------------------------------------ */

export interface character{
    type?:"character"
    name:string
    image?:string
    firstMessage:string
    desc:string
    notes:string
    chats:Chat[]
    chatFolders: ChatFolder[]
    chatPage: number
    viewScreen: 'emotion'|'none'|'imggen',
    bias: [string, number][]
    emotionImages: [string, string][]
    globalLore: loreBook[]
    chaId: string
    sdData: [string, string][]
    newGenData?: {
        prompt: string,
        negative: string,
        instructions: string,
        emotionInstructions: string,
    }
    customscript: customscript[]
    triggerscript: triggerscript[]
    utilityBot: boolean
    exampleMessage:string
    removedQuotes?:boolean
    creatorNotes:string
    systemPrompt:string
    postHistoryInstructions:string
    alternateGreetings:string[]
    tags:string[]
    creator:string
    characterVersion: string
    personality:string
    scenario:string
    firstMsgIndex:number
    loreSettings?:loreSettings
    loreExt?:any
    additionalData?: {
        tag?:string[]
        creator?:string
        character_version?:string
    }
    ttsMode?:string
    ttsSpeech?:string
    voicevoxConfig?:{
        speaker?: string
        SPEED_SCALE?: number
        PITCH_SCALE?: number
        INTONATION_SCALE?: number
        VOLUME_SCALE?: number
    }
    naittsConfig?:{
        customvoice?: boolean
        voice?: string
        version?: string
    }
    gptSoVitsConfig?:{
        url?:string
        use_auto_path?:boolean
        ref_audio_path?:string
        use_long_audio?:boolean
        ref_audio_data?: {
            fileName:string
            assetId:string
        }
        volume?:number
        text_lang?: "auto" | "auto_yue" | "en" | "zh" | "ja" | "yue" | "ko" | "all_zh" | "all_ja" | "all_yue" | "all_ko"
        text?:string
        use_prompt?:boolean
        prompt?:string | null
        prompt_lang?: "auto" | "auto_yue" | "en" | "zh" | "ja" | "yue" | "ko" | "all_zh" | "all_ja" | "all_yue" | "all_ko"
        top_p?:number
        temperature?:number
        speed?:number
        top_k?:number
        text_split_method?: "cut0" | "cut1" | "cut2" | "cut3" | "cut4" | "cut5"
    }
    fishSpeechConfig?:{
        model?: {
            _id:string
            title:string
            description:string
        },
        chunk_length:number,
        normalize:boolean,

    }
    supaMemory?:boolean
    additionalAssets?:[string, string, string][]
    ttsReadOnlyQuoted?:boolean
    replaceGlobalNote:string
    backgroundHTML?:string
    reloadKeys?:number
    backgroundCSS?:string
    license?:string
    private?:boolean
    additionalText:string
    oaiVoice?:string
    oaiTTSConfig?:{
        /** User opted into advanced OpenAI-compatible settings. When false/absent,
         *  tts.ts ignores the other fields and uses the legacy oaiVoice + db.openAIKey path. */
        enabled?: boolean
        /** Base URL, trailing slash trimmed at runtime. Falls back to 'https://api.openai.com/v1'. */
        baseURL?: string
        /** Per-character API key. Falls back to db.openAIKey; the Authorization header is omitted entirely when both are empty. */
        apiKey?: string
        /** Model ID. Falls back to 'tts-1'. */
        model?: string
        /** Freeform voice ID for custom endpoints. Falls back to character.oaiVoice, then to 'alloy'. */
        voice?: string
        /** Response format. Falls back to 'mp3'. */
        format?: 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm'
    }
    virtualscript?:string
    scriptstate?:{[key:string]:string|number|boolean}
    depth_prompt?: { depth: number, prompt: string }
    extentions?:{[key:string]:any}
    largePortrait?:boolean
    lorePlus?:boolean
    inlayViewScreen?:boolean
    hfTTS?: {
        model: string
        language: string
    },
    vits?: OnnxModelFiles
    realmId?:string
    imported?:boolean
    trashTime?:number
    nickname?:string
    source?:string[]
    group_only_greetings?:string[]
    creation_date?:number
    modification_date?:number
    ccAssets?: Array<{
        type: string
        uri: string
        name: string
        ext: string
    }>
    defaultVariables?:string
    lowLevelAccess?:boolean
    hideChatIcon?:boolean
    lastInteraction?:number
    translatorNote?:string
    doNotChangeSeperateModels?:boolean
    escapeOutput?:boolean
    prebuiltAssetCommand?:boolean
    prebuiltAssetStyle?:string
    prebuiltAssetExclude?:string[]
    modules?:string[]
    moduleNamespace?:string
    coldstorage?:string
    coldStoragedChats?:string[]
    customModuleToggle?:string
}

export interface groupChat{
    type: 'group'
    image?:string
    firstMessage:string
    chats:Chat[]
    chatFolders: ChatFolder[]
    chatPage: number
    name:string
    viewScreen: 'single'|'multiple'|'none'|'emp',
    characters:string[]
    characterTalks:number[]
    characterActive:boolean[]
    globalLore: loreBook[]
    autoMode: boolean
    useCharacterLore :boolean
    emotionImages: [string, string][]
    customscript: customscript[],
    chaId: string
    alternateGreetings?: string[]
    creatorNotes?:string,
    removedQuotes?:boolean
    firstMsgIndex?:number,
    loreSettings?:loreSettings
    supaMemory?:boolean
    ttsMode?:string
    suggestMessages?:string[]
    orderByOrder?:boolean
    backgroundHTML?:string,
    reloadKeys?:number
    backgroundCSS?:string
    oneAtTime?:boolean
    virtualscript?:string
    lorePlus?:boolean
    trashTime?:number
    nickname?:string
    defaultVariables?:string
    lowLevelAccess?:boolean
    hideChatIcon?:boolean
    lastInteraction?:number

    //lazy hack for typechecking
    voicevoxConfig?:any
    ttsSpeech?:string
    naittsConfig?:any
    oaiVoice?:string
    oaiTTSConfig?:any
    hfTTS?: any
    vits?: OnnxModelFiles
    gptSoVitsConfig?:any
    fishSpeechConfig?:any
    ttsReadOnlyQuoted?:boolean
    exampleMessage?:string
    systemPrompt?:string
    replaceGlobalNote?:string
    additionalText?:string
    personality?:string
    scenario?:string
    translatorNote?:string
    additionalData?: any
    depth_prompt?: { depth: number, prompt: string }
    additionalAssets?:[string, string, string][]
    utilityBot?:boolean
    license?:string
    realmId:string
    prebuiltAssetCommand?:boolean
    prebuiltAssetStyle?:string
    prebuiltAssetExclude?:string[]
    modules?:string[]
    coldstorage?:string
    coldStoragedChats?:string[]
}

export interface folder{
    name:string
    data:string[]
    color:string
    id:string
    imgFile?:string
    img?:string
}

/* ------------------------------------------------------------------------------------------------ *
 * Chats and messages (src/ts/storage/database.svelte.ts)
 * ------------------------------------------------------------------------------------------------ */

export type StreamingDisplayOptimizationMode = 'off'|'balanced'|'strong'

export interface Chat{
    message: Message[]
    note:string
    name:string
    localLore: loreBook[]
    sdData?:string
    supaMemoryData?:string
    hypaV2Data?:SerializableHypaV2Data
    lastMemory?:string
    suggestMessages?:string[]
    isStreaming?:boolean
    activeStreamingDisplayOptimizationMode?:StreamingDisplayOptimizationMode
    scriptstate?:{[key:string]:string|number|boolean}
    modules?:string[]
    id?:string
    bindedPersona?:string
    fmIndex?:number
    hypaV3Data?:SerializableHypaV3Data
    folderId?:string
    lastDate?:number
    bookmarks?: string[];
    bookmarkNames?: { [chatId: string]: string };
    useLocallySetGlobalVariables?: boolean
    GLGlobalVariables?: { [key: string]: string }
}

export interface ChatFolder{
    id:string
    name?:string
    color?:string
    folded:boolean
}

export interface Message{
    role: 'user'|'char'
    data: string
    saying?: string
    chatId?:string
    time?: number
    generationInfo?: MessageGenerationInfo
    promptInfo?: MessagePresetInfo
    name?:string
    otherUser?:boolean
    disabled?:false|true|'allBefore'
    isComment?:boolean
}

export interface MessageGenerationInfo{
    model?: string
    generationId?: string
    inputTokens?: number
    outputTokens?: number
    maxContext?: number
    stageTiming?: {
        stage1?: number
        stage2?: number
        stage3?: number
        stage4?: number
    }
}

export interface MessagePresetInfo{
    promptName?: string,
    promptToggles?: {key: string, value: string}[],
    promptText?: OpenAIChat[],
}

/* ------------------------------------------------------------------------------------------------ *
 * Memory payloads stored inside a Chat (src/ts/process/memory/hypav2.ts, hypav3.ts)
 * ------------------------------------------------------------------------------------------------ */

export interface HypaV2Data {
    lastMainChunkID: number; // can be removed, but exists to more readability of the code.
    mainChunks: { // summary itself
        id: number;
        text: string;
        chatMemos: Set<string>; // UUIDs of summarized chats
        lastChatMemo: string;
    }[];
    chunks: { // split mainChunks for retrieval or something. Although quite uncomfortable logic, so maybe I will delete it soon.
        mainChunkID: number;
        text:string;
    }[];
}

// Reuse HypaV2Data and override only chatMemos in mainChunks
export interface SerializableHypaV2Data extends Omit<HypaV2Data, 'mainChunks'> {
    mainChunks: {
        id: number;
        text: string;
        chatMemos: string[]; // Override Set<string> with string[]
        lastChatMemo: string;
    }[];
}

/**
 * Upstream `DisplayMode` from src/lib/Others/HypaV3Modal/types.ts, an `as const` object with the values
 * All / Range / Recent. Only the resulting union is reproduced.
 */
export type HypaV3ModalDisplayMode = 'All' | 'Range' | 'Recent'

/** Upstream declares this without `export`; it is exported here so `SerializableHypaV3Data` resolves. */
export interface HypaV3Data {
    summaries: Summary[];
    categories?: { id: string; name: string }[];
    lastSelectedSummaries?: number[]; // legacy
    metrics?: {
        lastImportantSummaries: number[];
        lastRecentSummaries: number[];
        lastSimilarSummaries: number[];
        lastRandomSummaries: number[];
    };
    modalSettings?: {
        displayMode: HypaV3ModalDisplayMode;
        displayRangeFrom: number;
        displayRangeTo: number;
        displayRecentCount: number;
        displayImportant: boolean;
        displaySelected: boolean;
    };
}

export interface SerializableHypaV3Data extends Omit<HypaV3Data, "summaries"> {
    summaries: SerializableSummary[];
}

/** Upstream declares this without `export`; it is exported here so `SerializableSummary` resolves. */
export interface Summary {
    text: string;
    chatMemos: Set<string>;
    isImportant: boolean;
    categoryId?: string;
    tags?: string[];
}

export interface SerializableSummary extends Omit<Summary, "chatMemos"> {
    chatMemos: string[];
}

/* ------------------------------------------------------------------------------------------------ *
 * Presets and prompt templates (src/ts/storage/database.svelte.ts, src/ts/process/prompt.ts)
 * ------------------------------------------------------------------------------------------------ */

export type FormatingOrderItem = 'main'|'jailbreak'|'chats'|'lorebook'|'globalNote'|'authorNote'|'lastChat'|'description'|'postEverything'|'personaPrompt'

export interface botPreset{
    name?:string
    apiType?: string
    openAIKey?: string
    localNetworkMode?: boolean
    localNetworkTimeoutSec?: number
    mainPrompt: string
    jailbreak: string
    globalNote:string
    temperature: number
    maxContext: number
    maxResponse: number
    frequencyPenalty: number
    PresensePenalty: number
    formatingOrder: FormatingOrderItem[]
    aiModel?: string
    subModel?:string
    currentPluginProvider?:string
    textgenWebUIStreamURL?:string
    textgenWebUIBlockingURL?:string
    forceReplaceUrl?:string
    forceReplaceUrl2?:string
    promptPreprocess: boolean,
    bias: [string, number][]
    proxyRequestModel?:string
    openrouterRequestModel?:string
    proxyKey?:string
    ooba: OobaSettings
    ainconfig: AINsettings
    koboldURL?: string
    NAISettings?: NAISettings
    autoSuggestPrompt?: string
    autoSuggestPrefix?: string
    autoSuggestClean?: boolean
    promptTemplate?:PromptItem[]
    NAIadventure?: boolean
    NAIappendName?: boolean
    localStopStrings?: string[]
    customProxyRequestModel?: string
    reverseProxyOobaArgs?: OobaChatCompletionRequestParams
    top_p?: number
    promptSettings?: PromptSettings
    repetition_penalty?:number
    min_p?:number
    top_a?:number
    openrouterProvider?: {
        order: string[]
        only: string[]
        ignore: string[]
    }
    useInstructPrompt?:boolean
    customPromptTemplateToggle?:string
    templateDefaultVariables?:string
    moduleIntergration?:string
    top_k?:number
    instructChatTemplate?:string
    JinjaTemplate?:string
    jsonSchemaEnabled?:boolean
    jsonSchema?:string
    strictJsonSchema?:boolean
    extractJson?:string
    groupTemplate?:string
    groupOtherBotRole?:string
    seperateParametersEnabled?:boolean
    seperateParameters?:{
        memory: SeparateParameters,
        emotion: SeparateParameters,
        translate: SeparateParameters,
        otherAx: SeparateParameters
        overrides: Record<string, SeparateParameters>
    }
    customAPIFormat?:LLMFormat
    systemContentReplacement?: string
    systemRoleReplacement?: 'user'|'assistant'
    enableCustomFlags?: boolean
    customFlags?: LLMFlags[]
    image?:string
    regex?:customscript[]
    reasonEffort?:number
    thinkingTokens?:number
    thinkingType?: 'off' | 'budget' | 'adaptive'
    deepseekThinkingType?: 'off' | 'enabled'
    adaptiveThinkingEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
    deepseekReasoningEffort?: 'high' | 'max'
    outputImageModal?:boolean
    seperateModelsForAxModels?:boolean
    seperateModels?:{
        memory: string
        emotion: string
        translate: string
        otherAx: string
    }
    modelTools?:string[]
    fallbackModels?: {
        memory: string[],
        emotion: string[],
        translate: string[],
        otherAx: string[]
        model: string[]
    }
    fallbackWhenBlankResponse?: boolean
    verbosity?:number
    dynamicOutput?:DynamicOutput
}

export interface SeparateParameters{
    temperature?:number
    top_k?:number
    repetition_penalty?:number
    min_p?:number
    top_a?:number
    top_p?:number
    frequency_penalty?:number
    presence_penalty?:number
    reasoning_effort?:number
    thinking_tokens?:number
    thinking_type?: 'off' | 'budget' | 'adaptive'
    deepseek_thinking_type?: 'off' | 'enabled'
    adaptive_thinking_effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
    deepseek_reasoning_effort?: 'high' | 'max'
    outputImageModal?:boolean
    verbosity?:number
}

export interface DynamicOutput {
    autoAdjustSchema: boolean
    dynamicMessages: boolean
    dynamicMemory: boolean
    dynamicResponseTiming: boolean
    dynamicOutputPrompt: boolean
    showTypingEffect: boolean
    dynamicRequest: boolean
}

/** Upstream declares this without `export`; it is exported here so `botPreset.ainconfig` resolves. */
export interface AINsettings{
    top_p: number,
    rep_pen: number,
    top_a: number,
    rep_pen_slope:number,
    rep_pen_range: number,
    typical_p:number
    badwords:string
    stoptokens:string
    top_k:number
}

export interface OobaSettings{
    max_new_tokens: number,
    do_sample: boolean,
    temperature: number,
    top_p: number,
    typical_p: number,
    repetition_penalty: number,
    encoder_repetition_penalty: number,
    top_k: number,
    min_length: number,
    no_repeat_ngram_size: number,
    num_beams: number,
    penalty_alpha: number,
    length_penalty: number,
    early_stopping: boolean,
    seed: number,
    add_bos_token: boolean,
    truncation_length: number,
    ban_eos_token: boolean,
    skip_special_tokens: boolean,
    top_a: number,
    tfs: number,
    epsilon_cutoff: number,
    eta_cutoff: number,
    formating:{
        header:string,
        systemPrefix:string,
        userPrefix:string,
        assistantPrefix:string
        seperator:string
        useName:boolean
    }
}

/** src/ts/process/models/nai.ts */
export interface NAISettings{
    topK: number
    topP: number
    topA: number
    tailFreeSampling: number
    repetitionPenalty: number
    repetitionPenaltyRange: number
    repetitionPenaltySlope: number
    repostitionPenaltyPresence: number
    seperator: string
    frequencyPenalty: number
    presencePenalty: number
    typicalp:number
    starter:string
    mirostat_lr?:number
    mirostat_tau?:number
    cfg_scale?:number
}

/** src/ts/model/ooba.ts */
export interface OobaChatCompletionRequestParams {
    mode: 'instruct'|'chat'|'chat-instruct'
    turn_template?: string
    name1_instruct?: string
    name2_instruct?: string
    context_instruct?: string
    system_message?: string
    name1?: string
    name2?: string
    context?: string
    greeting?: string
    chat_instruct_command?: string
    preset?: string; // The '?' denotes that the property is optional
    tokenizer?: string;
    min_p?: number;
    top_k?: number;
    repetition_penalty?: number;
    repetition_penalty_range?: number;
    typical_p?: number;
    tfs?: number;
    top_a?: number;
    epsilon_cutoff?: number;
    eta_cutoff?: number;
    guidance_scale?: number;
    negative_prompt?: string;
    penalty_alpha?: number;
    mirostat_mode?: number;
    mirostat_tau?: number;
    mirostat_eta?: number;
    temperature_last?: boolean;
    do_sample?: boolean;
    seed?: number;
    encoder_repetition_penalty?: number;
    no_repeat_ngram_size?: number;
    min_length?: number;
    num_beams?: number;
    length_penalty?: number;
    early_stopping?: boolean;
    truncation_length?: number;
    max_tokens_second?: number;
    custom_token_bans?: string;
    auto_max_new_tokens?: boolean;
    ban_eos_token?: boolean;
    add_bos_token?: boolean;
    skip_special_tokens?: boolean;
    grammar_string?: string;

}

/**
 * `botPreset.promptTemplate` entries. src/ts/process/prompt.ts:7-66.
 */
export type PromptItem = PromptItemPlain|PromptItemTyped|PromptItemChat|PromptItemAuthorNote|PromptItemChatML|PromptItemCache
export type PromptType = PromptItem['type'];
export type PromptSettings = {
    assistantPrefill: string
    postEndInnerFormat: string
    sendChatAsSystem: boolean
    sendName: boolean
    utilOverride: boolean
    customChainOfThought?: boolean
    maxThoughtTagDepth?: number
    trimStartNewChat?: boolean
}

export type PromptRole = 'user'|'bot'|'system'

export interface PromptItemPlain {
    type: 'plain'|'jailbreak'|'cot';
    type2: 'normal'|'globalNote'|'main'
    text: string;
    role: PromptRole;
    name?: string
}

export interface PromptItemChatML {
    type: 'chatML'
    text: string
    name?: string
}

export interface PromptItemTyped {
    type: 'persona'|'description'|'lorebook'|'postEverything'|'memory'
    innerFormat?: string,
    role2?: PromptRole
    name?: string
}

export interface PromptItemAuthorNote {
    type : 'authornote'
    innerFormat?: string
    defaultText?: string
    role2?: PromptRole
    name?: string
}


export interface PromptItemChat {
    type: 'chat';
    rangeStart: number;
    rangeEnd: number|'end';
    chatAsOriginalOnSystem?: boolean;
    name?: string
}

export interface PromptItemCache {
    type: 'cache';
    name: string
    depth: number
    role: 'user'|'assistant'|'system'|'all'

}

/**
 * src/ts/model/types.ts:3-32. Upstream is an `as const` object; the stored value is the number, so only
 * the numeric-literal union is reproduced. Mapping:
 * 0 hasImageInput, 1 hasImageOutput, 2 hasAudioInput, 3 hasAudioOutput, 4 hasPrefill, 5 hasCache,
 * 6 hasFullSystemPrompt, 7 hasFirstSystemPrompt, 8 hasStreaming, 9 requiresAlternateRole,
 * 10 mustStartWithUserInput, 11 poolSupported, 12 hasVideoInput, 13 OAICompletionTokens,
 * 14 DeveloperRole, 15 geminiThinking, 16 geminiBlockOff, 17 deepSeekPrefix, 18 deepSeekThinkingInput,
 * 19 deepSeekThinkingOutput, 20 noCivilIntegrity, 21 claudeThinking, 22 claudeAdaptiveThinking,
 * 23 claudeXHighEffort, 24 deepSeekThinkingToggle, 25 noStructuredOutput, 26 geminiThinkingNoMinimal
 */
export type LLMFlags = 0|1|2|3|4|5|6|7|8|9|10|11|12|13|14|15|16|17|18|19|20|21|22|23|24|25|26

/**
 * src/ts/model/types.ts:55-81. Same treatment as `LLMFlags`. Mapping:
 * 0 OpenAICompatible, 1 OpenAILegacyInstruct, 2 Anthropic, 3 AnthropicLegacy, 4 Mistral, 5 GoogleCloud,
 * 6 VertexAIGemini, 7 NovelList, 8 Cohere, 9 NovelAI, 10 WebLLM, 11 OobaLegacy, 12 Plugin, 13 Ooba,
 * 14 Kobold, 15 Ollama, 16 Horde, 17 AWSBedrockClaude, 18 OpenAIResponseAPI, 19 Echo, 20 NanoGPT,
 * 21 NanoGPTResponses, 22 NanoGPTMessages, 23 NanoGPTLegacy
 */
export type LLMFormat = 0|1|2|3|4|5|6|7|8|9|10|11|12|13|14|15|16|17|18|19|20|21|22|23

/* ------------------------------------------------------------------------------------------------ *
 * Modules (src/ts/process/modules.ts)
 * ------------------------------------------------------------------------------------------------ */

export interface MCPModule{
    url: string
}

export interface RisuModule{
    name: string
    description: string
    lorebook?: loreBook[]
    regex?: customscript[]
    cjs?: string
    trigger?: triggerscript[]
    id: string
    lowLevelAccess?: boolean
    hideIcon?: boolean
    backgroundEmbedding?:string
    assets?:[string,string,string][]
    namespace?:string
    customModuleToggle?:string
    mcp?:MCPModule
    icon?:string
}

/* ------------------------------------------------------------------------------------------------ *
 * Plugins (src/ts/plugins/plugins.svelte.ts)
 * ------------------------------------------------------------------------------------------------ */

/**
 * Parsed plugin header and arguments. `arguments` holds the declared `//@arg` types, `realArg` the
 * values the user filled in. Upstream names the interface `ProviderPlugin` and exports it only through
 * the alias `RisuPlugin`; both names are kept here.
 */
export interface ProviderPlugin {
    name: string
    displayName?: string
    script: string
    arguments: { [key: string]: 'int' | 'string' | string[] }
    realArg: { [key: string]: number | string }
    version?: 1 | 2 | '2.1' | '3.0'
    customLink: ProviderPluginCustomLink[]
    argMeta: { [key: string]: {[key:string]:string} }
    versionOfPlugin?: string
    updateURL?: string
    enabled?: boolean
    allowedIPC?: string[]
}

export interface ProviderPluginCustomLink {
    link: string
    hoverText?: string
}

export type RisuPlugin = ProviderPlugin

export type PluginV2ProviderArgument = {
    prompt_chat: OpenAIChat[]
    frequency_penalty: number
    min_p: number
    presence_penalty: number
    repetition_penalty: number
    top_k: number
    top_p: number
    temperature: number
    mode: string
    max_tokens: number
}

export type PluginV2ProviderOptions = {
    tokenizer?: string
    tokenizerFunc?: (content: string) => number[] | Promise<number[]>
}

/* ------------------------------------------------------------------------------------------------ *
 * Shared shapes referenced above (src/ts/process/index.svelte.ts, src/ts/process/transformers.ts)
 * ------------------------------------------------------------------------------------------------ */

export interface OpenAIChat{
    role: 'system'|'user'|'assistant'|'function'
    content: string
    memo?:string
    name?:string
    removable?:boolean
    attr?:string[]
    multimodals?: MultiModal[]
    thoughts?: string[]
    cachePoint?: boolean
}

export interface MultiModal{
    type:'image'|'video'|'audio'|'signature'
    base64:string,
    height?:number,
    width?:number
}

export interface OnnxModelFiles {
    files: { [key: string]: string },
    id: string,
    name?: string
}
