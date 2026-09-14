// SPDX-License-Identifier: MIT
// Type declarations of @risuai/ccardlib 0.4.2 (npm), the character-card spec package RisuAI depends on at commit cad8595aa39620df4246f56918f0962c2aa0263a.
// Source: https://cdn.jsdelivr.net/npm/@risuai/ccardlib@0.4.2/dist/index.d.ts  (SHA-256 of that file: e91c0791c3d9b2956c93d14f3cfb6c0957c25742fe59c3452ccb6a34e23f72d4)
// Copyright (c) the ccardlib authors; the package names "kwaroran" as its author. MIT licensed.
//   The package ships no LICENSE file, so no license text could be copied below this header. Its whole
//   published file list is dist/, compile.js, package.json, README.md, test.js, testResult.json and
//   tsconfig.json (https://data.jsdelivr.com/v1/packages/npm/@risuai/ccardlib@0.4.2), and
//   https://cdn.jsdelivr.net/npm/@risuai/ccardlib@0.4.2/LICENSE answers 404. The package's only
//   licensing statement is the package.json field `"license": "MIT"`, quoted here verbatim; the SPDX
//   line above records it. Both URLs were checked on 2026-09-14.
// Modifications for Uimori: type-only extraction, no runtime code.
//   Dropped: the runtime surface of the package - `CCardLib` and the `checkCharacterCardVersion`,
//   `convertCharacterCardVersion`, `convertLorebookVersion`, `parseDecorators` declarations, along with
//   their options and result types. `CharacterCardV1` is not copied either; Uimori reads V1 Tavern
//   cards through RisuAI's own `OldTavernChar` in ./types.ts.
//   Newly named: `CharacterCardV3Asset`, for the anonymous object literal type the upstream declaration
//   writes inline as the element type of `CharacterCardV3['data']['assets']`. The shape is unchanged.
//   Kept because `CharacterCardV2` needs them: `CharacterBook` and `CharacterBookEntry`. These are the
//   V2 spec shapes. RisuAI's ./types.ts declares its own, differently named members under the same
//   `CharacterBook` name - the two are not interchangeable.
//   Member names, optionality and order are otherwise exactly as published.

export interface CharacterCardV3 {
    spec: 'chara_card_v3';
    spec_version: '3.0';
    data: {
        name: string;
        description: string;
        tags: Array<string>;
        creator: string;
        character_version: string;
        mes_example: string;
        extensions: Record<string, any>;
        system_prompt: string;
        post_history_instructions: string;
        first_mes: string;
        alternate_greetings: Array<string>;
        personality: string;
        scenario: string;
        creator_notes: string;
        character_book?: Lorebook;
        assets?: Array<CharacterCardV3Asset>;
        nickname?: string;
        creator_notes_multilingual?: Record<string, string>;
        source?: string[];
        group_only_greetings: Array<string>;
        creation_date?: number;
        modification_date?: number;
    };
}

/** Element type of `CharacterCardV3['data']['assets']`, which upstream writes as an inline literal. */
export type CharacterCardV3Asset = {
    type: string;
    uri: string;
    name: string;
    ext: string;
};

export type Lorebook = {
    name?: string;
    description?: string;
    scan_depth?: number;
    token_budget?: number;
    recursive_scanning?: boolean;
    extensions: Record<string, any>;
    entries: Array<LorebookEntry>;
};

export type LorebookEntry = {
    keys: Array<string>;
    content: string;
    extensions: Record<string, any>;
    enabled: boolean;
    insertion_order: number;
    case_sensitive?: boolean;
    use_regex: boolean;
    constant?: boolean;
    name?: string;
    priority?: number;
    id?: number;
    comment?: string;
    selective?: boolean;
    secondary_keys?: Array<string>;
    position?: 'before_char' | 'after_char';
};

export type CharacterCardV2 = {
    spec: 'chara_card_v2';
    spec_version: '2.0';
    data: {
        name: string;
        description: string;
        personality: string;
        scenario: string;
        first_mes: string;
        mes_example: string;
        creator_notes: string;
        system_prompt: string;
        post_history_instructions: string;
        alternate_greetings: string[];
        character_book?: CharacterBook;
        tags: string[];
        creator: string;
        character_version: string;
        extensions: Record<string, any>;
    };
};

export type CharacterBook = {
    name?: string;
    description?: string;
    scan_depth?: number;
    token_budget?: number;
    recursive_scanning?: boolean;
    extensions: Record<string, any>;
    entries: Array<CharacterBookEntry>;
};

export interface CharacterBookEntry {
    keys: Array<string>;
    content: string;
    extensions: Record<string, any>;
    enabled: boolean;
    insertion_order: number;
    name?: string;
    priority?: number;
    id?: number;
    comment?: string;
    selective?: boolean;
    secondary_keys?: Array<string>;
    constant?: boolean;
    position?: 'before_char' | 'after_char';
    case_sensitive?: boolean;
}
