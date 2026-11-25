export type CbsRange = { from: number; to: number };

export type CbsFunctionCatalogEntry = {
  name: string;
  aliases: string[];
  description: string;
  deprecated?: { message: string; replacement?: string };
  internal?: boolean;
  documentationOnly?: boolean;
};

export type CbsFunctionCatalog = { functions: CbsFunctionCatalogEntry[] };

export type CbsBlockKind =
  | 'if'
  | 'if_pure'
  | 'when'
  | 'pure'
  | 'puredisplay'
  | 'code'
  | 'escape'
  | 'each'
  | 'func';

export type CbsCallKind =
  | 'call'
  | 'math'
  | 'block-open'
  | 'block-close'
  | 'else'
  | 'inert'
  | 'legacy-block'
  | 'legacy-name';

export type CbsContext = 'evaluated' | 'deferred' | 'inert';

export type CbsArgument = CbsRange & { dynamic: boolean };

export type CbsCall = CbsRange & {
  id: number;
  kind: CbsCallKind;
  open: CbsRange;
  close: CbsRange | null;
  name: string;
  nameRange: CbsRange;
  normalizedName: string;
  nameDynamic: boolean;
  separators: CbsRange[];
  arguments: CbsArgument[];
  parent: number | null;
  block: number | null;
  context: CbsContext;
};

export type CbsBlock = {
  id: number;
  kind: CbsBlockKind | null;
  keyword: string;
  opener: number;
  closer: number | null;
  elses: number[];
  parent: number | null;
  condition: 'truthy' | 'falsy' | 'dynamic' | null;
};

export type CbsReference = CbsRange & {
  scope: 'chat' | 'temp' | 'global';
  access: 'read' | 'write' | 'update';
  name: string;
  dynamic: boolean;
  call: number;
};

export type CbsTokenKind = 'text' | 'comment' | 'open' | 'close' | 'name' | 'keyword' | 'separator';

export type CbsToken = CbsRange & { kind: CbsTokenKind; call: number | null };

export type CbsDiagnosticCode =
  | 'cbs.unclosed-call'
  | 'cbs.unclosed-block'
  | 'cbs.stray-closer'
  | 'cbs.else-outside-when'
  | 'cbs.unknown-function';

export type CbsDiagnostic = CbsRange & {
  code: CbsDiagnosticCode;
  severity: 'error' | 'warning';
  name?: string;
};

export type CbsAnalysis = {
  tokens: CbsToken[];
  comments: CbsRange[];
  calls: CbsCall[];
  blocks: CbsBlock[];
  references: CbsReference[];
  diagnostics: CbsDiagnostic[];
};

export function normalizeCbsFunctionName(name: string): string {
  return name.toLocaleLowerCase().replace(/[\s_-]/g, '');
}

const knownNames = new WeakMap<CbsFunctionCatalog, Set<string>>();

function catalogNames(catalog: CbsFunctionCatalog): Set<string> {
  let names = knownNames.get(catalog);
  if (!names) {
    names = new Set(['call']);
    for (const entry of catalog.functions)
      for (const name of [entry.name, ...entry.aliases]) names.add(normalizeCbsFunctionName(name));
    knownNames.set(catalog, names);
  }
  return names;
}

type Segment = { at: number; from: number; length: number };

function stripComments(text: string): {
  stripped: string;
  segments: Segment[];
  comments: CbsRange[];
} {
  const segments: Segment[] = [];
  const comments: CbsRange[] = [];
  let stripped = '';
  const keep = (from: number, to: number) => {
    if (to <= from) return;
    segments.push({ at: stripped.length, from, length: to - from });
    stripped += text.slice(from, to);
  };
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf('{{//', cursor);
    if (start < 0) {
      keep(cursor, text.length);
      break;
    }
    keep(cursor, start);
    let depth = 1;
    let end = start + 2;
    for (; end < text.length - 1 && depth; end++) {
      const pair = text.slice(end, end + 2);
      if (pair === '{{') {
        depth++;
        end++;
      } else if (pair === '}}') {
        depth--;
        end++;
      }
    }
    if (depth) {
      keep(start, text.length);
      break;
    }
    comments.push({ from: start, to: end });
    cursor = end;
  }
  return { stripped, segments, comments };
}

function offsetMapper(segments: Segment[], strippedLength: number, textLength: number) {
  if (segments.length <= 1 && (segments[0]?.from ?? 0) === 0)
    return { start: (p: number) => p, end: (p: number) => p };
  const find = (p: number, preferEarlier: boolean) => {
    let low = 0;
    let high = segments.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      const at = segments[middle]!.at;
      if (preferEarlier ? at < p : at <= p) low = middle;
      else high = middle - 1;
    }
    return segments[low]!;
  };
  return {
    start: (p: number) => {
      if (p >= strippedLength) return textLength;
      const segment = find(p, false);
      return segment.from + (p - segment.at);
    },
    end: (p: number) => {
      if (p <= 0) return segments[0]?.from ?? 0;
      const segment = find(p, true);
      return segment.from + (p - segment.at);
    },
  };
}

type BlockStart = {
  kind: CbsBlockKind;
  keyword: string;
  pure: boolean;
  condition: CbsBlock['condition'];
};

type Frame =
  | { type: 1; call: number; contentStart: number; children: CbsRange[]; legacy: boolean }
  | { type: 5 | 6; block: number; pure: boolean };

const variableFunctions: Record<string, [CbsReference['scope'], CbsReference['access']]> = {
  getvar: ['chat', 'read'],
  setvar: ['chat', 'write'],
  addvar: ['chat', 'update'],
  setdefaultvar: ['chat', 'update'],
  tempvar: ['temp', 'read'],
  gettempvar: ['temp', 'read'],
  settempvar: ['temp', 'write'],
  getglobalvar: ['global', 'read'],
};

export function cbsVariableFunctionScope(name: string): CbsReference['scope'] | null {
  return variableFunctions[normalizeCbsFunctionName(name)]?.[0] ?? null;
}

const inertLiteralKeywords = new Set(['#pure', '#pure_display', '#puredisplay', '#escape']);

export function analyzeCbs(
  text: string,
  options: { catalog?: CbsFunctionCatalog } = {}
): CbsAnalysis {
  const { stripped: s, segments, comments } = stripComments(text);
  const map = offsetMapper(segments, s.length, text.length);
  const calls: CbsCall[] = [];
  const blocks: CbsBlock[] = [];
  const references: CbsReference[] = [];
  const diagnostics: CbsDiagnostic[] = [];
  const stack: Frame[] = [];
  let pureDepth = 0;

  const nearestCallFrame = () => {
    for (let i = stack.length - 1; i >= 0; i--) {
      const frame = stack[i]!;
      if (frame.type === 1) return frame;
    }
    return null;
  };
  const nearestBlock = () => {
    for (let i = stack.length - 1; i >= 0; i--) {
      const frame = stack[i]!;
      if (frame.type !== 1) return frame.block;
    }
    return null;
  };
  const context = (): CbsContext => {
    let deferred = false;
    for (const frame of stack) {
      if (frame.type === 1) continue;
      const block = blocks[frame.block]!;
      if (frame.type === 5 && frame.pure)
        if (block.kind === 'each' || block.kind === 'func') deferred = true;
        else return 'inert';
      if (frame.type === 6 && deferred && inertLiteralKeywords.has(block.keyword)) return 'inert';
    }
    return deferred ? 'deferred' : 'evaluated';
  };
  const createCall = (from: number, openLength: number): CbsCall => {
    const call: CbsCall = {
      id: calls.length,
      kind: 'call',
      from,
      to: s.length,
      open: { from, to: from + openLength },
      close: null,
      name: '',
      nameRange: { from: from + openLength, to: from + openLength },
      normalizedName: '',
      nameDynamic: false,
      separators: [],
      arguments: [],
      parent: nearestCallFrame()?.call ?? null,
      block: null,
      context: context(),
    };
    calls.push(call);
    return call;
  };
  const overlapsChild = (children: CbsRange[], from: number, to: number) =>
    children.some((child) => child.from < to && child.to > from);
  const literalPositions = (children: CbsRange[], from: number, to: number) => {
    const positions: number[] = [];
    let child = 0;
    for (let i = from; i < to; i++) {
      while (child < children.length && children[child]!.to <= i) child++;
      const current = children[child];
      if (current && current.from <= i && i < current.to) {
        i = current.to - 1;
        continue;
      }
      positions.push(i);
    }
    return positions;
  };
  const splitArguments = (
    call: CbsCall,
    children: CbsRange[],
    from: number,
    to: number,
    mode: 'matcher' | 'double'
  ) => {
    const colons = literalPositions(children, from, to).filter((i) => s[i] === ':');
    if (colons.length === 0) return [{ from, to }];
    const double = mode === 'double' || s[colons[0]! + 1] === ':';
    const separators: CbsRange[] = [];
    for (let k = 0; k < colons.length; k++) {
      const i = colons[k]!;
      if (!double) separators.push({ from: i, to: i + 1 });
      else if (s[i + 1] === ':' && colons[k + 1] === i + 1) {
        separators.push({ from: i, to: i + 2 });
        k++;
      }
    }
    call.separators.push(...separators);
    const parts: CbsRange[] = [];
    let start = from;
    for (const separator of separators) {
      parts.push({ from: start, to: separator.from });
      start = separator.to;
    }
    parts.push({ from: start, to });
    return parts;
  };
  const trimmed = (from: number, to: number): CbsRange => {
    while (from < to && /\s/.test(s[from]!)) from++;
    while (to > from && /\s/.test(s[to - 1]!)) to--;
    return { from, to };
  };
  const setName = (call: CbsCall, range: CbsRange, dynamic: boolean) => {
    call.nameRange = range;
    call.name = s.slice(range.from, range.to);
    call.normalizedName = normalizeCbsFunctionName(call.name);
    call.nameDynamic = dynamic;
  };
  const setLeadingWord = (
    call: CbsCall,
    children: CbsRange[],
    from: number,
    to: number,
    word: RegExp
  ) => {
    const match = word.exec(s.slice(from, to));
    const end = from + (match?.[0].length ?? 0);
    setName(call, { from, to: end }, false);
    if (end >= to) return;
    if (s.startsWith('::', end)) {
      call.separators.push({ from: end, to: end + 2 });
      for (const part of splitArguments(call, children, end + 2, to, 'double'))
        call.arguments.push({ ...part, dynamic: overlapsChild(children, part.from, part.to) });
    } else {
      const rest = trimmed(end, to);
      if (rest.to > rest.from)
        call.arguments.push({ ...rest, dynamic: overlapsChild(children, rest.from, rest.to) });
    }
  };
  const addReference = (
    call: CbsCall,
    range: CbsArgument,
    scope: CbsReference['scope'],
    access: CbsReference['access'],
    prefix = ''
  ) => {
    references.push({
      from: range.from,
      to: range.to,
      scope,
      access,
      name: range.dynamic ? '' : prefix + s.slice(range.from, range.to),
      dynamic: range.dynamic,
      call: call.id,
    });
  };
  const addExpressionReferences = (call: CbsCall, children: CbsRange[], range: CbsRange) => {
    const expression = s.slice(range.from, range.to);
    for (const match of expression.matchAll(/([$@])([a-zA-Z0-9_]+)/g)) {
      const from = range.from + match.index + 1;
      const to = from + match[2]!.length;
      if (overlapsChild(children, from - 1, to)) continue;
      references.push({
        from,
        to,
        scope: match[1] === '$' ? 'chat' : 'global',
        access: 'read',
        name: match[2]!,
        dynamic: false,
        call: call.id,
      });
    }
  };
  const classifyBlock = (
    dat: string,
    contentStart: number,
    children: CbsRange[]
  ): BlockStart | null => {
    if (dat.startsWith('#if') || dat.startsWith('#if_pure ')) {
      const keyword = dat.startsWith('#if_pure') ? '#if_pure' : '#if';
      const state = dat.split(' ', 2)[1];
      let condition: CbsBlock['condition'] = 'falsy';
      if (state !== undefined) {
        const from = contentStart + dat.indexOf(' ') + 1;
        if (overlapsChild(children, from, from + state.length)) condition = 'dynamic';
        else if (state === 'true' || state === '1') condition = 'truthy';
      }
      return {
        kind: keyword === '#if_pure' ? 'if_pure' : 'if',
        keyword,
        pure: condition === 'falsy',
        condition,
      };
    }
    if (dat.startsWith('#when'))
      return { kind: 'when', keyword: '#when', pure: false, condition: null };
    if (dat === '#pure') return { kind: 'pure', keyword: '#pure', pure: true, condition: null };
    if (dat === '#pure_display' || dat === '#puredisplay')
      return { kind: 'puredisplay', keyword: dat, pure: true, condition: null };
    if (dat === '#code') return { kind: 'code', keyword: '#code', pure: false, condition: null };
    if (dat.startsWith('#escape'))
      return { kind: 'escape', keyword: '#escape', pure: true, condition: null };
    if (dat.startsWith('#each'))
      return { kind: 'each', keyword: '#each', pure: true, condition: null };
    if (dat.startsWith('#func') && dat.split(' ').length > 1)
      return { kind: 'func', keyword: '#func', pure: true, condition: null };
    return null;
  };
  const insideWhen = () =>
    stack.some((frame) => frame.type === 5 && blocks[frame.block]!.kind === 'when');
  const openBlock = (call: CbsCall, start: BlockStart | null, keyword: string, type: 5 | 6) => {
    const block: CbsBlock = {
      id: blocks.length,
      kind: start?.kind ?? null,
      keyword,
      opener: call.id,
      closer: null,
      elses: [],
      parent: nearestBlock(),
      condition: start?.condition ?? null,
    };
    blocks.push(block);
    call.block = block.id;
    const pure = type === 5 && !!start?.pure;
    stack.push({ type, block: block.id, pure });
    if (pure) pureDepth++;
  };

  const closeCall = (
    frame: Extract<Frame, { type: 1 }>,
    at: number,
    closeLength: number,
    legacy: boolean
  ) => {
    const call = calls[frame.call]!;
    call.close = { from: at, to: at + closeLength };
    call.to = at + closeLength;
    call.context = context();
    const from = frame.contentStart;
    const dat = s.slice(from, at);
    const children = frame.children;
    if (legacy) {
      call.kind = 'legacy-block';
      setLeadingWord(call, children, from, at, /^[^\s:]*/);
    } else if (dat.startsWith('#') || dat.startsWith(':')) {
      if (pureDepth > 0) {
        if (dat === ':else') {
          call.kind = 'else';
          setName(call, { from, to: at }, false);
        } else {
          call.kind = 'block-open';
          setLeadingWord(call, children, from, at, /^[#:][^\s:]*/);
          openBlock(call, null, call.name, 6);
        }
      } else {
        const start = classifyBlock(dat, from, children);
        if (start) {
          call.kind = 'block-open';
          setLeadingWord(call, children, from, at, new RegExp(`^${start.keyword}`));
          openBlock(call, start, start.keyword, 5);
        } else if (dat === ':else') {
          call.kind = 'else';
          setName(call, { from, to: at }, false);
          const block = nearestBlock();
          if (block !== null) {
            blocks[block]!.elses.push(call.id);
            call.block = block;
          }
        } else {
          call.kind = 'inert';
          setLeadingWord(call, children, from, at, /^[#:][^\s:]*/);
        }
      }
      if (call.kind === 'else' && !insideWhen())
        diagnostics.push({
          from: call.from,
          to: call.to,
          code: 'cbs.else-outside-when',
          severity: 'warning',
        });
    } else if (dat.startsWith('/') && !dat.startsWith('//')) {
      call.kind = 'block-close';
      setLeadingWord(call, children, from, at, /^\/[^\s:]*/);
      const top = stack.at(-1);
      if (top && top.type !== 1) {
        stack.pop();
        if (top.pure) pureDepth--;
        const block = blocks[top.block]!;
        block.closer = call.id;
        call.block = block.id;
      } else if (call.context !== 'inert') {
        diagnostics.push({
          from: call.from,
          to: call.to,
          code: 'cbs.stray-closer',
          severity: 'error',
          name: call.name,
        });
      }
    } else if (dat.startsWith('? ')) {
      call.kind = 'math';
      setName(call, { from, to: from + 1 }, false);
      const expression = { from: from + 2, to: at, dynamic: overlapsChild(children, from + 2, at) };
      call.arguments.push(expression);
      addExpressionReferences(call, children, expression);
    } else {
      const parts = splitArguments(call, children, from, at, 'matcher');
      const name = parts[0]!;
      setName(call, trimmed(name.from, name.to), overlapsChild(children, name.from, name.to));
      for (const part of parts.slice(1))
        call.arguments.push({ ...part, dynamic: overlapsChild(children, part.from, part.to) });
      if (!call.nameDynamic) {
        const variable = variableFunctions[call.normalizedName];
        const first = call.arguments[0];
        if (variable && first) addReference(call, first, variable[0], variable[1]);
        if (call.normalizedName === 'calc' && first) addExpressionReferences(call, children, first);
      }
    }
    if (call.kind === 'block-open' && calls[call.id]!.block !== null) {
      const block = blocks[call.block!]!;
      if (block.kind === 'when') addWhenReferences(call);
    }
    nearestCallFrame()?.children.push({ from: call.from, to: call.to });
  };
  const addWhenReferences = (call: CbsCall) => {
    const stack: (CbsArgument | null)[] = [...call.arguments];
    const reads: { item: CbsArgument; toggle: boolean }[] = [];
    const read = (item: CbsArgument | null | undefined, toggle: boolean) => {
      if (item) reads.push({ item, toggle });
    };
    while (stack.length > 1) {
      const condition = stack.pop()!;
      const operator = stack.pop()!;
      if (operator?.dynamic) break;
      const word = operator ? s.slice(operator.from, operator.to) : null;
      const toggle = word?.startsWith('t') ?? false;
      switch (word) {
        case 'keep':
        case 'legacy':
          stack.push(condition);
          break;
        case 'var':
        case 'toggle':
          read(condition, toggle);
          stack.push(null);
          break;
        case 'vis':
        case 'visnot':
        case 'tis':
        case 'tisnot':
          read(stack.pop(), toggle);
          stack.push(null);
          break;
        case 'and':
        case 'or':
        case 'is':
        case 'isnot':
        case '>':
        case '<':
        case '>=':
        case '<=':
          stack.pop();
          stack.push(null);
          break;
        default:
          stack.push(null);
      }
    }
    reads.sort((a, b) => a.item.from - b.item.from);
    for (const { item, toggle } of reads)
      addReference(call, item, toggle ? 'global' : 'chat', 'read', toggle ? 'toggle_' : '');
  };

  const legacyName = /<(user|char|bot)>/iy;
  let i = 0;
  while (i < s.length) {
    const char = s[i];
    const next = s[i + 1];
    const top = stack.at(-1);
    if (char === '{' && (next === '{' || next === '#')) {
      const call = createCall(i, 2);
      stack.push({
        type: 1,
        call: call.id,
        contentStart: i + 2,
        children: [],
        legacy: next === '#',
      });
      i += 2;
      continue;
    }
    if ((char === '}' || char === '#') && next === '}' && top?.type === 1) {
      stack.pop();
      closeCall(top, i, 2, char === '#');
      i += 2;
      continue;
    }
    if (char === '<') {
      legacyName.lastIndex = i;
      const match = legacyName.exec(s);
      if (match) {
        const call = createCall(i, 1);
        call.kind = 'legacy-name';
        call.close = { from: i + match[0].length - 1, to: i + match[0].length };
        call.to = i + match[0].length;
        setName(call, { from: i + 1, to: i + match[0].length - 1 }, false);
        nearestCallFrame()?.children.push({ from: call.from, to: call.to });
        i += match[0].length;
        continue;
      }
    }
    i++;
  }

  for (const frame of stack) {
    if (frame.type === 1) {
      const call = calls[frame.call]!;
      if (!frame.legacy)
        diagnostics.push({
          from: call.open.from,
          to: call.open.to,
          code: 'cbs.unclosed-call',
          severity: 'error',
        });
    } else {
      const block = blocks[frame.block]!;
      const opener = calls[block.opener]!;
      diagnostics.push({
        from: opener.from,
        to: opener.to,
        code: 'cbs.unclosed-block',
        severity: 'error',
        name: block.keyword,
      });
    }
  }

  if (options.catalog) {
    const known = catalogNames(options.catalog);
    for (const call of calls) {
      if (call.kind !== 'call' || call.nameDynamic || call.context === 'inert') continue;
      const name = call.normalizedName;
      if (!name || name.startsWith('//') || known.has(name)) continue;
      if (name === 'arg' && call.context === 'deferred') continue;
      diagnostics.push({
        from: call.nameRange.from,
        to: call.nameRange.to,
        code: 'cbs.unknown-function',
        severity: 'warning',
        name: call.name,
      });
    }
  }

  const range = <T extends CbsRange>(value: T): T => ({
    ...value,
    from: map.start(value.from),
    to: value.to === value.from ? map.start(value.from) : map.end(value.to),
  });
  const tokens: CbsToken[] = comments.map((comment) => ({
    ...comment,
    kind: 'comment',
    call: null,
  }));
  for (const call of calls) {
    tokens.push({ ...range(call.open), kind: 'open', call: call.id });
    if (!call.nameDynamic && call.nameRange.to > call.nameRange.from)
      tokens.push({
        ...range(call.nameRange),
        kind:
          call.kind === 'call' || call.kind === 'math' || call.kind === 'legacy-name'
            ? 'name'
            : 'keyword',
        call: call.id,
      });
    for (const separator of call.separators)
      tokens.push({ ...range(separator), kind: 'separator', call: call.id });
    if (call.close) tokens.push({ ...range(call.close), kind: 'close', call: call.id });
  }
  tokens.sort((a, b) => a.from - b.from || a.to - b.to);
  const filled: CbsToken[] = [];
  let cursor = 0;
  for (const token of tokens) {
    if (token.from < cursor) continue;
    if (token.from > cursor)
      filled.push({ from: cursor, to: token.from, kind: 'text', call: null });
    filled.push(token);
    cursor = token.to;
  }
  if (cursor < text.length)
    filled.push({ from: cursor, to: text.length, kind: 'text', call: null });

  return {
    tokens: filled,
    comments,
    calls: calls.map((call) => ({
      ...range(call),
      open: range(call.open),
      close: call.close && range(call.close),
      nameRange: range(call.nameRange),
      separators: call.separators.map(range),
      arguments: call.arguments.map(range),
    })),
    blocks,
    references: references.map(range),
    diagnostics: diagnostics.map(range).sort((a, b) => a.from - b.from),
  };
}

export function cbsMatchingRanges(
  analysis: CbsAnalysis,
  position: number
): { ranges: CbsRange[]; matched: boolean } | null {
  let innermost: CbsCall | null = null;
  for (const call of analysis.calls)
    if (call.from <= position && position <= call.to && (!innermost || call.from >= innermost.from))
      innermost = call;
  if (!innermost) return null;
  const whole = (call: CbsCall): CbsRange => ({ from: call.from, to: call.to });
  if (innermost.kind === 'block-open' || innermost.kind === 'block-close') {
    const block = innermost.block === null ? null : analysis.blocks[innermost.block]!;
    if (!block) return { ranges: [whole(innermost)], matched: false };
    const opener = analysis.calls[block.opener]!;
    const closer = block.closer === null ? null : analysis.calls[block.closer]!;
    return closer
      ? { ranges: [whole(opener), whole(closer)], matched: true }
      : { ranges: [whole(opener)], matched: false };
  }
  const onBrace =
    (position >= innermost.open.from && position <= innermost.open.to) ||
    (!!innermost.close && position >= innermost.close.from && position <= innermost.close.to);
  if (!onBrace) return null;
  return innermost.close
    ? { ranges: [innermost.open, innermost.close], matched: true }
    : { ranges: [innermost.open], matched: false };
}
