import { Catalog } from '@a2ui/web_core/catalog';
import basicSchema from '../third_party/a2ui/basic-catalog-v1.json' with { type: 'json' };
import { z } from 'zod';

// Public basicCatalog.toJson() snapshot from @a2ui/web_core 0.15.0. Schema only:
// provider context and source parsing must not initialize browser components.
const basicCatalog = Catalog.fromJson(basicSchema);

export const STORY_UI_CATALOG_ID = 'urn:uimori:story-ui:1';

// Stored blocks are validated against this catalog on every read, so every change here
// must accept what an earlier version accepted: add components and optional properties only.
//
// Bindable and child-reference property types are borrowed from the basic catalog's own
// components. They carry the reference markers the SDK's compiler and binder read, and
// importing the SDK's schema module instead would pull browser-oriented code into core.
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
const iconNames = basicSchema.components.Icon.properties.name.oneOf.find(
  (option) => 'enum' in option
)!.enum as [string, ...string[]];
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

/**
 * Uimori's own components. `purpose` is the one-line description the model reads; the SDK
 * serializer keeps property descriptions but drops a component-level one.
 */
export const storyUiExtensions: { name: string; schema: z.ZodTypeAny; purpose?: string }[] = [
  {
    name: 'Text',
    schema: z
      .object({
        text: text(
          'The text. body and quote accept simple Markdown (bold, italics, lists); the other variants are plain.'
        ),
        variant: z
          .enum(['body', 'caption', 'headline', 'title', 'label', 'quote', 'mono'])
          .describe(
            'headline: the largest heading. title: a section heading. label: a small overline above content. caption: small secondary text. quote: an indented quotation. mono: fixed-width text for code, logs and readouts, with line breaks kept.'
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
        accent: z
          .enum(storyUiAccents)
          .describe('Brand color of this medium, applied to its header and highlights.')
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
        size: z.enum(['small', 'medium', 'large']).optional(),
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
];

/**
 * Properties that hold in-world wording. Context projection and translation read these;
 * every other property (identifiers, enums, URLs, numbers) stays host-owned.
 */
export const storyUiTextKeys = [
  // Ordered as a reader meets them, so a projected block reads "who, when, what".
  'tag',
  'title',
  'subtitle',
  'sender',
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
/** Wording inside list-valued properties. `options[].value` is a stable identifier, not wording. */
export const storyUiNestedTextKeys: Record<string, string[]> = {
  tabs: ['title'],
  options: ['label'],
  items: ['label', 'value', 'title', 'text', 'time'],
};
/** Components whose `value` is displayed rather than edited. */
export const storyUiDisplayValues = new Set(['Gauge', 'Stat']);
/** Properties that must name an image stored by this app. */
export const storyUiImageKeys: Record<string, string> = {
  Image: 'url',
  Avatar: 'url',
  Message: 'avatar',
  Post: 'avatar',
};

const allowed = new Set([
  'Image',
  'Icon',
  'Row',
  'Column',
  'List',
  'Card',
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
    ...[...basicCatalog.components.values()].filter((entry) => allowed.has(entry.name)),
    ...storyUiExtensions.map(({ name, schema }) => ({ name, schema })),
  ],
  [...basicCatalog.functions.values()].filter((entry) => entry.name !== 'openUrl'),
  {
    defs: basicCatalog.defs,
    defModels: basicCatalog.defModels,
    themeSchema: basicCatalog.themeSchema,
    commonTypesUri: basicCatalog.commonTypesUri,
  }
);
