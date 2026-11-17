import { Catalog } from '@a2ui/web_core/catalog';
import basicSchema from '../third_party/a2ui/basic-catalog-v1.json' with { type: 'json' };
import { z } from 'zod';

// Public basicCatalog.toJson() snapshot from @a2ui/web_core 0.15.0. Schema only:
// provider context and source parsing must not initialize browser components.
const basicCatalog = Catalog.fromJson(basicSchema);

export const STORY_UI_CATALOG_ID = 'urn:uimori:story-ui:1';
const chartItems = z
  .array(z.object({ label: z.string().max(500), value: z.number().finite() }).strict())
  .min(1)
  .max(50);
export const storyUiExtensions = [
  {
    name: 'BarChart',
    schema: z.object({ title: z.string().max(500), items: chartItems }).strict(),
  },
  {
    name: 'LineChart',
    schema: z.object({ title: z.string().max(500), items: chartItems }).strict(),
  },
  {
    name: 'DataTable',
    schema: z
      .object({
        title: z.string().max(500),
        columns: z.array(z.string().max(500)).min(1).max(20),
        rows: z.array(z.array(z.string().max(2000)).max(20)).max(100),
      })
      .strict(),
  },
  {
    name: 'Gauge',
    schema: z
      .object({
        label: z.string().max(500),
        value: z.number().finite(),
        min: z.number().finite(),
        max: z.number().finite(),
        unit: z.string().max(100).optional(),
      })
      .strict(),
  },
];
const allowed = new Set([
  'Text',
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
    ...storyUiExtensions,
  ],
  [...basicCatalog.functions.values()].filter((entry) => entry.name !== 'openUrl'),
  {
    defs: basicCatalog.defs,
    defModels: basicCatalog.defModels,
    themeSchema: basicCatalog.themeSchema,
    commonTypesUri: basicCatalog.commonTypesUri,
  }
);
