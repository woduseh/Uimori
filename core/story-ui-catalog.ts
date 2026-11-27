import { Catalog } from '@a2ui/web_core/catalog';
import basicSchema from '../third_party/a2ui/basic-catalog-v1.json' with { type: 'json' };
import { z } from 'zod/v3';

const basicCatalog = Catalog.fromJson(basicSchema);

export const STORY_UI_CATALOG_ID = 'urn:uimori:story-ui:1';

const borrow = (component: string, property: string) => {
  const schema: z.ZodTypeAny = (
    basicCatalog.components.get(component)!.schema as unknown as z.AnyZodObject
  ).shape[property];
  const reference = schema.description!.split('|')[0];
  return (description: string) => schema.describe(`${reference}|${description}`);
};
const text = borrow('Text', 'text');
const number = borrow('Slider', 'value');
const child = borrow('Card', 'child');
const children = borrow('Column', 'children');
const weight = z.number().optional();
const label = z.string().max(500);

export const storyUiTones = ['neutral', 'accent', 'positive', 'caution', 'danger', 'info'] as const;
export const storyUiAccents = [
  'red',
  'orange',
  'amber',
  'green',
  'teal',
  'blue',
  'indigo',
  'violet',
  'pink',
  'gray',
] as const;
const tone = z.enum(storyUiTones).describe('Semantic color. Omit for the neutral look.').optional();
export const storyUiSurfaces = ['outline', 'tint', 'gradient', 'glass', 'glow'] as const;
const surface = z
  .enum(storyUiSurfaces)
  .describe(
    'How the panel is painted. Omit for the plain look. outline: no fill and a strong accent border. tint: a soft wash of the accent. gradient: a bold accent gradient with light text, for a short panel. glass: translucent and blurred, for a panel over a backdrop or image. glow: a lit accent edge for magic, neon or alarms.'
  )
  .optional();
const accent = (description: string) => z.enum(storyUiAccents).describe(description).optional();
const size = z.enum(['small', 'medium', 'large']).optional();
const iconNames = basicSchema.components.Icon.properties.name.oneOf.find(
  (option) => 'enum' in option
)!.enum as [string, ...string[]];
const nodeId = z.string().regex(/^[\p{L}\p{N}_-]{1,40}$/u);
const square = z.number().int().min(0).max(15);
const span = z.number().int().min(1).max(16).optional();
const chartItems = z
  .array(z.object({ label, value: z.number().finite() }).strict())
  .min(1)
  .max(50);
const chart = z
  .object({
    title: label,
    items: chartItems,
    unit: z.string().max(100).describe('Unit shown after each value.').optional(),
    weight,
  })
  .strict();

export const storyUiExtensions: { name: string; schema: z.ZodTypeAny; purpose?: string }[] = [
  {
    name: 'Text',
    schema: z
      .object({
        text: text(
          'The text. body and quote accept simple Markdown (bold, italics, lists); the other variants are plain.'
        ),
        variant: z
          .enum(['body', 'caption', 'headline', 'title', 'label', 'quote', 'mono', 'display'])
          .describe(
            'display: one oversized showpiece line, such as a logo, a score or a verdict. headline: the largest heading. title: a section heading. label: a small overline above content. caption: small secondary text. quote: an indented quotation. mono: fixed-width text for code, logs and readouts, with line breaks kept.'
          )
          .optional(),
        tone,
        align: z.enum(['start', 'center', 'end']).optional(),
        weight,
      })
      .strict(),
  },
  {
    name: 'Frame',
    purpose:
      'The outer shell of an in-world medium. Put it at the root so the block reads as a specific app, page, document or window instead of a generic panel.',
    schema: z
      .object({
        child: child('The single component shown inside. Use a Column for several.'),
        title: text('Name of the app, site, publication, document or window.').optional(),
        subtitle: text('Secondary header line: a room, section, date or address.').optional(),
        kind: z
          .enum(['panel', 'app', 'page', 'paper', 'terminal', 'system', 'note'])
          .describe(
            'The medium. panel: a neutral titled panel. app: a phone app screen such as a messenger or feed. page: a website, board or wiki page. paper: print such as a newspaper, letter, flyer or official document. terminal: a console or machine readout. system: a game-like system, status or quest window. note: a memo or handwritten note.'
          )
          .optional(),
        accent: accent('Brand color of this medium, applied to its header and highlights.'),
        weight,
        surface,
        backdrop: text(
          'Optional image URL painted behind the content, under a veil that keeps text legible.'
        ).optional(),
        ornament: z
          .enum(['corners', 'inset', 'ribbon', 'stripes'])
          .describe(
            'Decoration drawn on the frame. corners: bracket marks in the four corners. inset: a fine inner border. ribbon: a folded accent corner. stripes: hazard bands along the top and bottom.'
          )
          .optional(),
      })
      .strict(),
  },
  {
    name: 'Card',
    purpose: 'A raised panel around one child. Give it a surface or accent to set it apart.',
    schema: z
      .object({
        child: child('The single component shown inside. Use a Column for several.'),
        weight,
        surface,
        accent: accent('Color of this card and its highlights.'),
      })
      .strict(),
  },
  {
    name: 'Hero',
    purpose:
      'A banner with large text over an image or an accent gradient: a title card, location reveal, chapter opening, poster, event splash or profile cover.',
    schema: z
      .object({
        title: text('The large line.'),
        subtitle: text('A line under the title.').optional(),
        image: text(
          'Optional image URL filling the banner. An accent gradient is shown without it.'
        ).optional(),
        label: text('A small overline above the title.').optional(),
        child: child(
          'Optional content under the text, such as a Row of Badge or Button.'
        ).optional(),
        size,
        align: z.enum(['start', 'center', 'end']).optional(),
        accent: accent('Color of the gradient and highlights.'),
        weight,
      })
      .strict(),
  },
  {
    name: 'Dialogue',
    purpose:
      'A visual-novel line: a speech box with a name plate and an optional standing portrait. Use it for a game-like or staged exchange, not for ordinary prose dialogue.',
    schema: z
      .object({
        text: text('The spoken line. Simple Markdown is accepted.'),
        speaker: text('Name on the plate.').optional(),
        portrait: text('Optional portrait image URL.').optional(),
        status: text('A short stage direction or mood beside the name.').optional(),
        side: z.enum(['left', 'right']).describe('Which side the portrait stands on.').optional(),
        accent: accent('Color of the name plate.'),
        weight,
      })
      .strict(),
  },
  {
    name: 'Ring',
    purpose:
      'A circular meter with the figure in its center. Put several in a Row for a compact dashboard.',
    schema: z
      .object({
        label: text('What is measured.'),
        value: number('The current amount.'),
        min: z.number().finite(),
        max: z.number().finite(),
        unit: z.string().max(100).optional(),
        tone,
        size,
        weight,
      })
      .strict(),
  },
  {
    name: 'Carousel',
    purpose:
      'A horizontal strip the reader swipes through, one item snapping into place at a time: a gallery, a hand of cards, a shop shelf, a character roster.',
    schema: z
      .object({
        children: children('The items, usually Card or Image.'),
        itemWidth: z
          .enum(['narrow', 'medium', 'wide'])
          .describe('narrow shows several items at once; wide shows about one.')
          .optional(),
        weight,
      })
      .strict(),
  },
  {
    name: 'Stack',
    purpose:
      'Layers its children on top of each other. The first child is the base, such as an Image; the rest are laid over it at the aligned position, such as a Badge, a caption or a Card with surface="glass".',
    schema: z
      .object({
        children: children('The base first, then the overlays.'),
        align: z
          .enum([
            'center',
            'top',
            'bottom',
            'start',
            'end',
            'topStart',
            'topEnd',
            'bottomStart',
            'bottomEnd',
          ])
          .describe('Where the overlays sit on the base. Defaults to bottomStart.')
          .optional(),
        weight,
      })
      .strict(),
  },
  {
    name: 'Message',
    purpose: 'One chat bubble. Stack several in a Column for a conversation.',
    schema: z
      .object({
        text: text('The message body.'),
        sender: text('Display name above the bubble.').optional(),
        time: text('Timestamp as the app would show it.').optional(),
        side: z
          .enum(['left', 'right', 'center'])
          .describe(
            'left (default): someone else. right: the point-of-view character. center: a system line such as a date, a join notice or a time skip.'
          )
          .optional(),
        status: text('Delivery note beside the bubble, such as a read mark.').optional(),
        avatar: text(
          'Optional portrait image URL. The sender initial is shown without it.'
        ).optional(),
        weight,
      })
      .strict(),
  },
  {
    name: 'Post',
    purpose:
      'An authored entry: a forum post, comment, social post, review, email or news article.',
    schema: z
      .object({
        text: text('The body. Simple Markdown is accepted.'),
        author: text('Username, byline or sender.').optional(),
        title: text('Headline or subject.').optional(),
        time: text('Timestamp as the site would show it.').optional(),
        meta: text('One short line of counters or details, such as views and votes.').optional(),
        tag: text('Category or flair shown as a badge.').optional(),
        avatar: text('Optional portrait image URL.').optional(),
        variant: z
          .enum(['post', 'article', 'comment'])
          .describe(
            'post: a forum or social post. article: a news or magazine piece with a large headline. comment: a compact reply.'
          )
          .optional(),
        children: children('Replies shown indented under this entry.').optional(),
        weight,
      })
      .strict(),
  },
  {
    name: 'Notice',
    purpose:
      'A highlighted callout: a system alert, quest update, warning, encounter, breaking-news banner or push notification.',
    schema: z
      .object({
        text: text('The message. Simple Markdown is accepted.'),
        title: text('Short heading.').optional(),
        tone,
        icon: z.enum(iconNames).describe('An icon name from the Icon component.').optional(),
        weight,
      })
      .strict(),
  },
  {
    name: 'Badge',
    purpose: 'A small pill for a category, rank, state or tag.',
    schema: z.object({ text: text('One or two words.'), tone, weight }).strict(),
  },
  {
    name: 'Stat',
    purpose: 'A labelled figure. Put several in a Grid or Row for a status board.',
    schema: z
      .object({
        label: text('What is measured.'),
        value: z
          .union([text('A short value.'), number('A figure.')])
          .describe('The figure or short value, as a number or string.'),
        hint: text('Small note under the value, such as a change or a rank.').optional(),
        tone,
        weight,
      })
      .strict(),
  },
  {
    name: 'KeyValue',
    purpose: 'A field list such as a profile, wiki infobox, item description or receipt.',
    schema: z
      .object({
        items: z
          .array(z.object({ label, value: z.string().max(2000) }).strict())
          .min(1)
          .max(50),
        title: label.optional(),
        weight,
      })
      .strict(),
  },
  {
    name: 'Timeline',
    purpose:
      'Ordered entries on a line: a log, chronology, itinerary, call history or quest objectives with their state.',
    schema: z
      .object({
        items: z
          .array(
            z
              .object({
                title: label,
                text: z.string().max(2000).optional(),
                time: label.optional(),
                state: z.enum(['done', 'current', 'pending', 'failed']).optional(),
              })
              .strict()
          )
          .min(1)
          .max(50),
        title: label.optional(),
        weight,
      })
      .strict(),
  },
  {
    name: 'Grid',
    purpose: 'Equal-width tiles for stats, inventory slots, cards or a gallery.',
    schema: z
      .object({
        children: children('The tiles.'),
        columns: z
          .number()
          .int()
          .min(2)
          .max(4)
          .describe('Columns on a wide screen, 2 to 4. Narrow screens use fewer.')
          .optional(),
        weight,
      })
      .strict(),
  },
  {
    name: 'Details',
    purpose:
      'A collapsible section for optional depth: full article text, older messages, spoilers, fine print.',
    schema: z
      .object({
        title: text('The always-visible summary line.'),
        child: child('The content revealed when the reader opens it.'),
        open: z.boolean().describe('Start opened.').optional(),
        weight,
      })
      .strict(),
  },
  {
    name: 'Avatar',
    purpose: 'A round portrait or initial for a profile header.',
    schema: z
      .object({
        label: text('The name. Its first character is shown when there is no image.'),
        url: text('Optional portrait image URL.').optional(),
        size,
        weight,
      })
      .strict(),
  },
  {
    name: 'Gauge',
    purpose: 'A filled bar for a bounded amount such as health, progress, trust or fuel.',
    schema: z
      .object({
        label: text('What is measured.'),
        value: number('The current amount.'),
        min: z.number().finite(),
        max: z.number().finite(),
        unit: z.string().max(100).optional(),
        tone,
        weight,
      })
      .strict(),
  },
  { name: 'BarChart', purpose: 'Horizontal bars comparing labelled amounts.', schema: chart },
  { name: 'LineChart', purpose: 'A trend across ordered points.', schema: chart },
  { name: 'PieChart', purpose: 'Shares of a whole as a ring with a legend.', schema: chart },
  {
    name: 'RadarChart',
    purpose: 'A polygon profile across three or more traits, such as ability scores.',
    schema: z
      .object({
        title: label,
        items: chartItems.min(3).max(12),
        max: z.number().finite().positive().describe('The value at the outer edge.').optional(),
        weight,
      })
      .strict(),
  },
  {
    name: 'DataTable',
    purpose: 'Rows and columns of short text.',
    schema: z
      .object({
        title: label,
        columns: z.array(label).min(1).max(20),
        rows: z.array(z.array(z.string().max(2000)).max(20)).max(100),
        weight,
      })
      .strict(),
  },
  {
    name: 'Profile',
    purpose:
      'A character card: portrait, name, a line about them and a few facts. Use it for an introduction, a roster entry, an idol or student file, a wanted notice or a dating-app profile.',
    schema: z
      .object({
        title: text('The name.'),
        subtitle: text('Role, affiliation or epithet under the name.').optional(),
        image: text('Optional portrait image URL. The initial is shown without it.').optional(),
        text: text('A short description. Simple Markdown is accepted.').optional(),
        items: z
          .array(z.object({ label, value: z.string().max(2000) }).strict())
          .max(12)
          .describe('Short facts such as age, height, class or rank.')
          .optional(),
        child: child(
          'Optional content under the facts, such as a Row of Badge or Button.'
        ).optional(),
        accent: accent('Color of this card.'),
        weight,
      })
      .strict(),
  },
  {
    name: 'Schedule',
    purpose:
      'A timetable: one column per day or slot with the entries that fall in it. Use it for a weekly plan, a lesson or training calendar, a tour, a shift roster or a festival program.',
    schema: z
      .object({
        days: z.array(label).min(1).max(7).describe('Column headings in order, such as weekdays.'),
        items: z
          .array(
            z
              .object({
                day: z.number().int().min(0).max(6).describe('Index into days, from 0.'),
                title: label,
                time: label.optional(),
                text: z.string().max(2000).optional(),
                tone,
              })
              .strict()
          )
          .max(60),
        title: label.optional(),
        current: z
          .number()
          .int()
          .min(0)
          .max(6)
          .describe('Index of the day to highlight as today.')
          .optional(),
        weight,
      })
      .strict(),
  },
  {
    name: 'Compare',
    purpose:
      'Figures standing side by side at their relative size, each with its value. Use it to compare heights, sizes, power levels, prices or scores, where the difference itself is the point.',
    schema: z
      .object({
        items: z
          .array(
            z
              .object({ label, value: z.number().finite().nonnegative(), text: label.optional() })
              .strict()
          )
          .min(2)
          .max(8)
          .describe('label: who or what. value: the amount. text: a short note under the label.'),
        title: label.optional(),
        unit: z.string().max(100).describe('Unit shown after each value.').optional(),
        shape: z
          .enum(['figure', 'bar'])
          .describe('figure (default): a standing silhouette. bar: a plain column.')
          .optional(),
        weight,
      })
      .strict(),
  },
  {
    name: 'Slot',
    purpose:
      'One square item tile for a Grid: an inventory or equipment slot, a skill, a collectible card, a reward.',
    schema: z
      .object({
        label: text('Name under the tile.'),
        image: text('Optional item image URL.').optional(),
        icon: z
          .enum(iconNames)
          .describe('An icon shown when there is no image. The initial is shown without either.')
          .optional(),
        value: z
          .union([text('A short mark.'), number('A count.')])
          .describe('Count or short mark in the corner, such as 3 or "Lv.5".')
          .optional(),
        rarity: z
          .enum(['common', 'uncommon', 'rare', 'epic', 'legendary'])
          .describe('Grade shown by the color and glow of the tile.')
          .optional(),
        state: z
          .enum(['empty', 'locked', 'equipped'])
          .describe('empty: a vacant slot. locked: not yet available. equipped: in use.')
          .optional(),
        weight,
      })
      .strict(),
  },
  {
    name: 'Rank',
    purpose:
      'A large grade stamp with optional stars: a performance result, an exam grade, a threat level, a review score, a tier.',
    schema: z
      .object({
        value: text('The grade itself, one to three characters such as "S", "A+" or "92".'),
        label: text('What is graded.').optional(),
        text: text('A short verdict line.').optional(),
        stars: z.number().min(0).max(10).describe('Filled stars. Halves are allowed.').optional(),
        max: z.number().int().min(1).max(10).describe('Total stars. Defaults to 5.').optional(),
        tone,
        weight,
      })
      .strict(),
  },
  {
    name: 'Combatant',
    purpose:
      'One fighter in a battle readout: name, portrait, resource bars such as HP and MP, and status effects. Stack allies and enemies in Columns for a party screen, a duel or a boss encounter.',
    schema: z
      .object({
        title: text('The name.'),
        bars: z
          .array(
            z
              .object({
                label,
                value: z.number().finite(),
                max: z.number().finite().positive(),
                tone,
              })
              .strict()
          )
          .min(1)
          .max(4)
          .describe(
            'Resource bars in order, named as the world names them (HP, MP, stamina, qi, shield). Without a tone the first bar turns from green to amber to red as it empties.'
          ),
        subtitle: text('Level, class or rank beside the name.').optional(),
        image: text('Optional portrait image URL.').optional(),
        effects: z
          .array(z.object({ label, tone }).strict())
          .max(8)
          .describe('Status effects shown as small tags, such as poison or haste.')
          .optional(),
        side: z
          .enum(['ally', 'enemy'])
          .describe('enemy mirrors the row and uses the danger color.')
          .optional(),
        state: z
          .enum(['active', 'guard', 'down'])
          .describe('active: whose turn it is. guard: defending. down: defeated.')
          .optional(),
        weight,
      })
      .strict(),
  },
  {
    name: 'Route',
    purpose:
      'Places joined along a line, read from left to right: a journey, a subway or patrol route, stage progression, a chain of locations with the current one marked.',
    schema: z
      .object({
        items: z
          .array(
            z
              .object({
                title: label,
                text: z.string().max(2000).optional(),
                time: label.optional(),
                state: z.enum(['done', 'current', 'pending', 'failed']).optional(),
              })
              .strict()
          )
          .min(2)
          .max(20),
        title: label.optional(),
        weight,
      })
      .strict(),
  },
  {
    name: 'Graph',
    purpose:
      'People or things joined by labelled lines: a relationship chart, an evidence board, a skill or tech tree, a family tree, an org chart. The host places the nodes.',
    schema: z
      .object({
        nodes: z
          .array(
            z
              .object({
                id: nodeId,
                label,
                text: label.optional(),
                image: z.string().max(2000).optional(),
                tone,
                state: z.enum(['current', 'locked', 'unknown']).optional(),
              })
              .strict()
          )
          .min(2)
          .max(16)
          .describe(
            'id: a short name the edges refer to. label: the name shown. text: a short line under it. image: an optional portrait. state current: the focus, such as the protagonist or the chosen skill; locked: not reached yet; unknown: identity hidden, drawn as a question mark.'
          ),
        edges: z
          .array(
            z
              .object({
                from: nodeId,
                to: nodeId,
                label: label.optional(),
                tone,
                arrow: z.enum(['end', 'both', 'none']).optional(),
                line: z.enum(['solid', 'dashed']).optional(),
              })
              .strict()
          )
          .max(40)
          .describe(
            'from and to are node ids. label: the relation, such as "rival" or "owes money". arrow: end (default), both, or none for kinship and plain links. line dashed: suspected, one-sided or broken.'
          ),
        title: label.optional(),
        layout: z
          .enum(['ring', 'tree'])
          .describe(
            'ring (default): nodes around a circle, for relationships and boards. tree: rows running down along the edges from the nodes nothing points to, for skill, family and org trees.'
          )
          .optional(),
        center: nodeId.describe('ring only: id of the node placed in the middle.').optional(),
        weight,
      })
      .strict(),
  },
  {
    name: 'Map',
    purpose:
      'A top-down grid of squares with areas and markers: a tactical or battle map, a dungeon floor, a building or school floor plan, a game board, a seating chart.',
    schema: z
      .object({
        columns: z.number().int().min(2).max(16),
        rows: z.number().int().min(1).max(16),
        areas: z
          .array(
            z
              .object({
                x: square,
                y: square,
                w: span,
                h: span,
                label: label.optional(),
                tone,
                terrain: z.enum(['floor', 'wall', 'water', 'hidden']).optional(),
              })
              .strict()
          )
          .max(40)
          .describe(
            'Rectangles of squares from x,y spanning w by h (1 by default). terrain: floor (default) for a room or zone, wall for solid blocks, water, hidden for an unexplored or fogged part.'
          )
          .optional(),
        markers: z
          .array(
            z
              .object({
                x: square,
                y: square,
                label,
                mark: z.string().max(3).optional(),
                icon: z.enum(iconNames).optional(),
                text: label.optional(),
                tone,
                state: z.enum(['current', 'down']).optional(),
              })
              .strict()
          )
          .max(30)
          .describe(
            'Tokens on squares, also listed in a legend under the map. mark: up to three characters on the token instead of the initial. state current: the reader or the unit acting; down: defeated or out.'
          )
          .optional(),
        title: label.optional(),
        coords: z
          .boolean()
          .describe('Letter the columns and number the rows along the edges.')
          .optional(),
        weight,
      })
      .strict(),
  },
  {
    name: 'Calendar',
    purpose:
      'A month grid with entries on their dates: an idol or tour calendar, school events, deadlines, a countdown to a D-day. Use Schedule for a single week.',
    schema: z
      .object({
        title: label,
        items: z
          .array(
            z
              .object({
                date: z.number().int().min(1).max(40),
                title: label,
                time: label.optional(),
                text: z.string().max(2000).optional(),
                tone,
              })
              .strict()
          )
          .max(60)
          .describe('date: the day of the month, from 1.')
          .optional(),
        month: z
          .string()
          .regex(/^\d{4}-(?:0[1-9]|1[0-2])$/)
          .describe(
            'A real month as YYYY-MM; the host lays out its weeks from Sunday. Omit it for an invented calendar and set start and length.'
          )
          .optional(),
        start: z
          .number()
          .int()
          .min(0)
          .max(9)
          .describe('Without month: the column of day 1, from 0.')
          .optional(),
        length: z
          .number()
          .int()
          .min(1)
          .max(40)
          .describe('Without month: the number of days. Defaults to 30.')
          .optional(),
        days: z
          .array(label)
          .min(1)
          .max(10)
          .describe(
            "Column headings, from Sunday with a month. Without them the reader's weekday names are used."
          )
          .optional(),
        current: z
          .number()
          .int()
          .min(1)
          .max(40)
          .describe('The date to highlight as today.')
          .optional(),
        weight,
      })
      .strict(),
  },
];

export const storyUiTextKeys = [
  'tag',
  'title',
  'subtitle',
  'sender',
  'speaker',
  'author',
  'time',
  'text',
  'label',
  'unit',
  'meta',
  'status',
  'hint',
  'placeholder',
  'description',
];
export const storyUiNestedTextKeys: Record<string, string[]> = {
  tabs: ['title'],
  options: ['label'],
  items: ['label', 'value', 'title', 'text', 'time'],
  bars: ['label', 'value', 'max'],
  effects: ['label'],
  nodes: ['label', 'text'],
  edges: ['label'],
  areas: ['label'],
  markers: ['label', 'text'],
};
export const storyUiNestedImageKeys: Record<string, string> = { nodes: 'image' };
export const storyUiDisplayValues = new Set(['Gauge', 'Rank', 'Ring', 'Slot', 'Stat']);
export const storyUiImageKeys: Record<string, string> = {
  Image: 'url',
  Avatar: 'url',
  Message: 'avatar',
  Post: 'avatar',
  Frame: 'backdrop',
  Hero: 'image',
  Dialogue: 'portrait',
  Profile: 'image',
  Slot: 'image',
  Combatant: 'image',
};
export const storyUiTextLists = ['columns', 'days'];

const look = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,31}(?: [a-z][a-z0-9-]{0,31}){0,3}$/)
  .describe('Style hook names for the block CSS, separated by spaces.')
  .optional();
const withLook = (schema: z.ZodTypeAny): z.ZodTypeAny =>
  (schema as z.AnyZodObject).extend({ look });

const allowed = new Set([
  'Image',
  'Icon',
  'Row',
  'Column',
  'List',
  'Tabs',
  'Modal',
  'Divider',
  'Button',
  'TextField',
  'CheckBox',
  'ChoicePicker',
  'Slider',
  'DateTimeInput',
]);
export const storyUiCatalog = new Catalog(
  STORY_UI_CATALOG_ID,
  '1.0',
  [
    ...[...basicCatalog.components.values()]
      .filter((entry) => allowed.has(entry.name))
      .map(({ name, schema }) => ({ name, schema: withLook(schema) })),
    ...storyUiExtensions.map(({ name, schema }) => ({ name, schema: withLook(schema) })),
  ],
  [...basicCatalog.functions.values()].filter((entry) => entry.name !== 'openUrl'),
  {
    defs: basicCatalog.defs,
    defModels: basicCatalog.defModels,
    themeSchema: basicCatalog.themeSchema,
    commonTypesUri: basicCatalog.commonTypesUri,
  }
);
