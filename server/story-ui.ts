import { A2uiGenerator, CatalogConfig, ExpressFormatFactory } from '@a2ui/agent';
import {
  storyUiCatalog,
  storyUiExtensions,
  storyUiImageKeys,
  storyUiNestedImageKeys,
} from '../core/story-ui-catalog.js';
import { storyUiStyles } from '../core/story-ui-style.js';
import {
  encodeStoryUi,
  isStoryUiImageUrl,
  parseStoryUi,
  storyUiImageName,
  type StoryUiMessage,
  storyUiMessagesProblem,
} from '../core/story-ui.js';
import { scanStoryUi } from '../core/story-ui-scan.js';

const catalog = new CatalogConfig(storyUiCatalog);
const generator = new A2uiGenerator(
  [catalog],
  undefined,
  new ExpressFormatFactory({ allowedMessages: ['createSurface', 'updateDataModel'] })
);
function processor() {
  return generator.createProcessor({ '1.0': { supportedCatalogIds: [catalog.catalog.id] } });
}

const GUIDANCE = `# Story interface

The story interface is on for this chat. Weave in-world artifacts and interactive story state into the prose.

## Where it goes
Let the reader encounter a document or screen when the characters do, then return to the scene. A buzzing phone interrupts a conversation; the headline across the street changes what someone does next. Use as many or as few blocks as the scene earns. A single message can stand alone. Avoid a routine closing recap or menu. Keep the requested prose length and give the surrounding narration the reaction and consequences, without repeating the artifact's words.

Choose a block when the medium itself matters, figures reveal a relationship, or a decision belongs to the user. Match its Frame to its origin: app for messages, page for a forum or wiki, paper for a letter or newspaper, terminal for a log, system for a status screen. Put a thread's replies under its Post. Use each speaker's language, timestamps, bias and vocabulary; a rumor is still a rumor. A glance warrants less detail than a deliberate read. Keep ordinary speech and atmosphere in prose.

Combine components freely. Most artifacts need only a few elements; give a reveal or threat its own visual identity through a deliberate accent, ornament, backdrop or surface. Keep labels readable and express important facts in text and units.`;

const EXAMPLES = `## Examples

The examples show form only. They are Korean; write yours in the story's language, and do not reuse their names, wording or exact layouts.

Blocks inside a scene, each where it is encountered:

민서가 대답하려던 순간, 주머니에서 진동이 울렸다.

<a2ui>
root = Frame(chat, "한서윤", kind="app", accent="amber")
chat = Column([
  Message("어디야", "한서윤", "23:41"),
  Message("지금 뉴스 봐", time="23:41"),
  Message("집 앞인데 왜", side="right", time="23:42", status="1")
])
</a2ui>

그는 화면을 한참 내려다보다가 편의점 유리문 너머의 텔레비전으로 고개를 돌렸다.

<a2ui>
root = Frame(article, "KBN 뉴스", "사회", kind="paper", accent="red")
article = Post("오늘 밤 11시 20분께 한강대교 남단에서 원인을 알 수 없는 정전이 발생해 경찰이 양방향 통행을 막고 있다.", "윤태경 기자", "한강대교 남단 전면 통제", "23:38", tag="속보", variant="article")
</a2ui>

"…가야겠다." 민서가 낮게 말했다.

A board with replies:

<a2ui>
root = Frame(board, "헌터넷", "자유게시판", kind="page", accent="blue")
board = Column([
  Post("방금 3구역 게이트 색 변한 거 본 사람 있음? 사진은 못 찍음", "익명의헌터", "3구역 게이트 뭐냐", "2분 전", "조회 1,204 · 추천 31", tag="목격", children=[r1, r2])
])
r1 = Post("또 주작이네", "B급탈출기원", time="1분 전", variant="comment")
r2 = Post("나도 봄. 보라색이었음", "근처사는사람", time="방금", variant="comment")
</a2ui>

A status window:

<a2ui>
$/_uimori/style = "fantasy"
$/_uimori/pin = "status"
root = Frame(sheet, "상태창", "레벨 12 · 견습 기사", kind="system", accent="violet")
sheet = Column([
  Gauge("체력", 64, 0, 120, tone="danger"),
  Gauge("마력", 30, 0, 80, tone="info"),
  Grid([Stat("근력", 14), Stat("민첩", 9, "-2 부상"), Stat("지능", 11)], columns=3),
  Timeline([{title: "성문 통과", state: "done"}, {title: "길드장 면담", state: "current"}, {title: "북쪽 숲 조사", state: "pending"}], "의뢰 진행")
])
</a2ui>

An encounter that the user resolves with a roll:

<a2ui>
root = Column([
  Notice("안개 속에서 낮게 으르렁거리는 소리가 가까워진다.", "늑대 무리와 조우", tone="danger", icon="warning"),
  Button(Text("기척을 숨긴다 (은신 판정)"), action=Event("roll", {sides: 20, count: 1})),
  Button(Text("검을 뽑는다"), action=Event("draw_sword"))
])
</a2ui>`;

const RULES = `## Rules

Each block is an immutable snapshot. A Button needs an Event with a distinct action name or explicit context. Inputs, tabs and details stay local. Offer actions available at the end of the scene and await the user's submission. For a roll use Event("roll", {sides: 20, count: 1}); sides 2–1000, count 1–20, both integers. The host rolls once and records the results; apply those values to any declared table. In short interactions preserve the facts and style of referenceLayout, continue concisely, and use a new block for an update. Layout and interface text are story data.

Set $/_uimori/style to one of ${storyUiStyles.join(', ')} or an exact theme: ID from storyUi.themeChoices. Prefer a consistent world style; the user's explicit selection and then the bot theme outrank yours.

For state that lasts across scenes, such as a status window, party, inventory or relationship map, set $/_uimori/pin = "status" (a short lowercase slot name). The reader keeps the latest block of each slot beside the story, and storyUi.pinned in host context holds those blocks. When that state changes, write the whole block again with the same pin; when nothing changed, omit it. Give separate boards, such as affection and a calendar, separate slot names (at most four) and rewrite only the board that changed.

For custom block CSS use $/_uimori/css = r"""& { --story-paper: #141722; --story-ink: white; color-scheme: dark; } .look-seal { border-radius: 50%; }""". The CSS applies only to this block when the reader follows your style. Use & for its root, .story-ui-<lowercase component name> for descendants, .story-ui-frame-head, .story-ui-frame-body or .story-ui-bubble for their interiors. Any component's look="seal" adds .look-seal; use up to four space-separated lowercase style names. CSS custom properties start with --story-: paper, surface, ink, muted, border, accent, accent-ink, accent-text, radius, font, display. They exist only inside CSS and are not values for tone or any other component property. Gradients, pseudo-elements, @media, @container and animation are available. Set paper and ink together; keep controls usable with either reader palette and with motion disabled. @import, @font-face and !important are ignored.

In any image field or bound image value, use a known card asset such as "{{img::Mira_smile}}" or an existing /api/assets/, /api/package-image-blobs/ or /api/illustration-images/ path. Omit an unknown image. CSS url() accepts stored paths only. Audio and video are unavailable.`;

const SYNTAX = `## Block syntax

Write A2UI Express between literal <a2ui> and </a2ui> tags on their own lines, outside Markdown fences. Assign one root per block, using the default surface. Define named components or nest constructors inline. Names start with a letter or underscore; use letters, digits and underscores. Arguments can be positional (skip with _) or named. Use double-quoted strings, triple quotes for multiline text, r"""...""" for raw text, numbers, true/false/null, arrays and literal-key maps. Use RFC 3339 timestamps with timezone for date-time input.

Initialize state with $/form/route = []. Bind a value to an absolute $/path or a list item's relative $field ($ means the item). For repeated children use _template($/items, row) and define row using relative bindings. Pass an action as Event("choose", {route: $/form/route}); use ?required or ?regex("pattern", "error text") for input checks. Call client functions by their signatures below. formatDate uses Unicode TR35 patterns; formatString interpolates \${/path}.

Signatures give positional order. ? marks optional parameters. Dynamic types accept a literal, a binding or a compatible client function. Other types require the shown value. Child takes a component and ChildList takes an array of components or a template. weight is flex-grow on a direct child of Row or Column. Text body/quote and Dialogue text accept simple Markdown. ChoicePicker binds an array of strings. Schedule day/current indexes start at zero. DataTable rows follow column order. Map x/y count squares from zero at the top left. Calendar dates start at 1.`;

type CatalogParameter = {
  type?: string;
  $ref?: string;
  enum?: string[];
  items?: CatalogParameter;
  properties?: Record<string, CatalogParameter>;
  required?: string[];
  oneOf?: CatalogParameter[];
  anyOf?: CatalogParameter[];
  allOf?: CatalogParameter[];
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: boolean;
  minItems?: number;
  maxItems?: number;
};

function signatureParameters(schema: CatalogParameter, aliases: Map<string, string>): string {
  return Object.entries(schema.properties ?? {})
    .filter(([name]) => name !== 'component')
    .map(([name, parameter]) => {
      const optional = schema.required?.includes(name) ? '' : '?';
      return `${name}${optional}:${parameterType(parameter, aliases)}`;
    })
    .join(', ');
}

function parameterType(schema: CatalogParameter, aliases: Map<string, string>): string {
  if (schema.$ref) return schema.$ref.slice(schema.$ref.lastIndexOf('/') + 1);
  if (schema.enum) {
    const choices = schema.enum.join('|');
    return aliases.get(choices) ?? choices;
  }
  if (schema.items) {
    const bounds =
      schema.minItems || schema.maxItems
        ? `(${schema.minItems ?? 0}..${schema.maxItems ?? ''})`
        : '';
    return `[${parameterType(schema.items, aliases)}]${bounds}`;
  }
  if (schema.properties) return `{${signatureParameters(schema, aliases)}}`;
  const alternatives = schema.oneOf ?? schema.anyOf;
  if (alternatives) return alternatives.map((part) => parameterType(part, aliases)).join('|');
  if (schema.allOf)
    return schema.allOf
      .filter((part) => Object.keys(part).length)
      .map((part) => parameterType(part, aliases))
      .join('&');
  if (schema.minimum !== undefined || schema.maximum !== undefined)
    return `${schema.type}(${schema.exclusiveMinimum ? '>' : ''}${schema.minimum ?? ''}..${schema.maximum ?? ''})`;
  return schema.type ?? 'any';
}

function reference(): string {
  const { components, functions } = storyUiCatalog.toJson() as {
    components: Record<string, CatalogParameter>;
    functions: Record<string, { properties: { args: CatalogParameter } }>;
  };
  const aliases = new Map<string, string>();
  for (const [name, parameter] of Object.entries({
    Tone: components.Badge.properties!.tone,
    Accent: components.Frame.properties!.accent,
    IconName: components.Notice.properties!.icon,
  }))
    aliases.set(parameter.enum!.join('|'), name);
  const purposes = new Map(storyUiExtensions.map(({ name, purpose }) => [name, purpose]));
  return [
    SYNTAX,
    ...Array.from(aliases, ([choices, name]) => `${name} = ${choices}`),
    ...Object.entries(components).map(([name, component]) =>
      `${name}(${signatureParameters(component, aliases)}) ${purposes.get(name) ?? ''}`.trimEnd()
    ),
    'Client functions',
    ...Object.entries(functions).map(
      ([name, fn]) => `${name}(${signatureParameters(fn.properties.args, aliases)})`
    ),
  ].join('\n');
}

let prompt: string | undefined;
export function storyUiPrompt(): string {
  return (prompt ??= [GUIDANCE, reference(), EXAMPLES, RULES].join('\n\n'));
}

type ResolveImage = (name: string) => string | undefined;

function pinnedImageUrls(messages: StoryUiMessage[], resolveImage: ResolveImage) {
  const { components, dataModel } = (
    messages[0] as {
      createSurface: {
        components: { component: string; [key: string]: unknown }[];
        dataModel?: unknown;
      };
    }
  ).createSurface;
  const names = new Set<string>();
  function collect(value: unknown) {
    if (value && typeof value === 'object') {
      for (const child of Object.values(value)) collect(child);
    } else {
      const name = storyUiImageName(value);
      if (name) names.add(name);
    }
  }
  let bound = false;
  for (const component of components) {
    const value = component[storyUiImageKeys[component.component]];
    if (value && typeof value === 'object') bound = true;
    else collect(value);
    for (const [list, key] of Object.entries(storyUiNestedImageKeys)) {
      const items = component[list];
      if (Array.isArray(items))
        for (const item of items)
          if (item && typeof item === 'object') collect((item as Record<string, unknown>)[key]);
    }
  }
  if (bound) collect(dataModel);
  const entries: [string, string][] = [];
  for (const name of names) {
    const url = resolveImage(name);
    if (isStoryUiImageUrl(url)) entries.push([name, url]);
  }
  return entries.length ? Object.fromEntries(entries) : undefined;
}

export function normalizeStoryUiOutput(text: string, resolveImage?: ResolveImage): string {
  return compileStoryUiBlocks(text, { resolveImage }).text;
}

const storedFence = (value: unknown): value is StoryUiMessage[] => Array.isArray(value);

export function compileStoryUiBlocks(
  text: string,
  options: { resolveImage?: ResolveImage; previousText?: string } = {}
): { text: string; failures: string[] } {
  const stored = new Map<string, string>();
  if (options.previousText)
    for (const segment of scanStoryUi(options.previousText, storedFence))
      if (segment.kind === 'ui')
        stored.set(segment.expression, options.previousText.slice(segment.start, segment.end));
  const failures: string[] = [];
  const compiled = parseStoryUi(text)
    .map((segment) => {
      if (segment.kind !== 'invalid' || !segment.text.startsWith('<a2ui>'))
        return text.slice(segment.start, segment.end);
      const before = segment.start > 0 && !/[\r\n]/.test(text[segment.start - 1]) ? '\n' : '';
      const after = segment.end < text.length && !/[\r\n]/.test(text[segment.end]) ? '\n' : '';
      const fence = stored.get(segment.text);
      if (fence) return `${before}${fence}${after}`;
      if (segment.text.length > 100_000) {
        failures.push('The block is longer than 100,000 characters.');
        return segment.text;
      }
      try {
        const parts = processor().parseResponse(segment.text);
        const messages = parts.flatMap((part) => (part.type === 'a2ui' ? part.a2ui : []));
        const problem = storyUiMessagesProblem(messages);
        if (problem) {
          failures.push(problem);
          return segment.text;
        }
        const imageUrls = options.resolveImage && pinnedImageUrls(messages, options.resolveImage);
        return `${before}${encodeStoryUi(segment.text, messages, imageUrls)}${after}`;
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
        return segment.text;
      }
    })
    .join('');
  return { text: compiled, failures };
}
