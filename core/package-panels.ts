import {
  renderPromptTemplate,
  resolvePromptValues,
  validatePromptTemplate,
  type PromptControl,
  type PromptTemplate,
  type PromptValue,
  type RuntimeValue,
} from './prompt-program.js';
import { behaviorActionTriggers, type PackageBehavior } from './package-behavior.js';
import { PromptBudget } from './prompt-values.js';
import type { PackageIdentityContext } from './package-identity.js';
import { templateReadsVariables } from './template-variables.js';

/** Authored markup is presentation data, not a permission to execute JavaScript or access the app DOM. */
export type PackagePanel = {
  id: string;
  title: string;
  template: PromptTemplate;
  css?: string;
  /** Only these declared user actions may be requested from this panel. */
  actions?: string[];
};
export type RenderedPackagePanel = {
  id: string;
  title: string;
  html: string;
  css: string;
  actions: string[];
  issue?: string;
};
export const PACKAGE_PANEL_HTML_LIMIT = 100_000;
export const PACKAGE_PANEL_CSS_LIMIT = 32_000;
export const PACKAGE_PANEL_COUNT_LIMIT = 8;

function fail(code: string): never {
  throw new Error(code);
}
export function validatePackagePanels(
  value: unknown,
  context: { controls: PromptControl[]; behavior?: PackageBehavior }
): PackagePanel[] {
  if (!Array.isArray(value) || value.length > PACKAGE_PANEL_COUNT_LIMIT)
    fail('PACKAGE_PANEL_LIMIT');
  const ids = new Set<string>();
  for (const panel of value) {
    if (
      !panel ||
      typeof panel !== 'object' ||
      Array.isArray(panel) ||
      Object.keys(panel).some((key) => !['id', 'title', 'template', 'css', 'actions'].includes(key))
    )
      fail('PACKAGE_PANEL_FIELDS');
    if (typeof panel.id !== 'string' || !/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,63}$/u.test(panel.id))
      fail('PACKAGE_PANEL_ID');
    if (ids.has(panel.id)) fail('PACKAGE_PANEL_DUPLICATE');
    ids.add(panel.id);
    if (typeof panel.title !== 'string' || !panel.title.trim() || panel.title.length > 200)
      fail('PACKAGE_PANEL_TITLE');
    if (
      panel.css !== undefined &&
      (typeof panel.css !== 'string' || panel.css.length > PACKAGE_PANEL_CSS_LIMIT)
    )
      fail('PACKAGE_PANEL_CSS_LIMIT');
    validatePromptTemplate(
      panel.template,
      context.controls.map((control) => control.id)
    );
    if (JSON.stringify(panel.template).length > PACKAGE_PANEL_HTML_LIMIT)
      fail('PACKAGE_PANEL_TEMPLATE_LIMIT');
    const pending: unknown[] = [panel.template];
    while (pending.length) {
      const node = pending.pop();
      if (!node || typeof node !== 'object') continue;
      if (!Array.isArray(node)) {
        const record = node as Record<string, unknown>;
        if (Object.hasOwn(record, 'literal')) continue;
        if (record.kind === 'slot') fail('PACKAGE_PANEL_SLOT');
        if (Object.hasOwn(record, 'context')) {
          const path = record.context as string[];
          if (!path.length || !['state', 'options', 'bot', 'user', 'variables'].includes(path[0]))
            fail('PACKAGE_PANEL_CONTEXT');
          if (['bot', 'user'].includes(path[0]) && (path.length !== 2 || path[1] !== 'name'))
            fail('PACKAGE_PANEL_CONTEXT');
        }
      }
      pending.push(...Object.values(node));
    }
    if (panel.actions !== undefined) {
      if (
        !Array.isArray(panel.actions) ||
        panel.actions.length > 100 ||
        new Set(panel.actions).size !== panel.actions.length
      )
        fail('PACKAGE_PANEL_ACTIONS');
      for (const id of panel.actions) {
        const action = context.behavior?.actions.find((item) => item.id === id);
        if (!action || !behaviorActionTriggers(action).includes('user'))
          fail('PACKAGE_PANEL_ACTION_NOT_ALLOWED');
      }
    }
  }
  return structuredClone(value) as PackagePanel[];
}

/** Read-only current-state projection. No action, random draw, provider request or row initialization. */
export function renderPackagePanels(
  definition: { panels?: PackagePanel[]; controls: PromptControl[] },
  context: {
    state: RuntimeValue;
    values?: Record<string, PromptValue>;
    identity: PackageIdentityContext;
  }
): RenderedPackagePanel[] {
  return (definition.panels ?? []).map((panel) => {
    try {
      if (context.identity.variableDefaultsError && templateReadsVariables(panel.template))
        fail(context.identity.variableDefaultsError);
      const values = resolvePromptValues(
        { version: 1, controls: definition.controls, blocks: [] },
        context.values
      );
      return {
        id: panel.id,
        title: panel.title,
        html: renderPromptTemplate(
          panel.template,
          values,
          {},
          {
            runtime: { ...context.identity, state: context.state, options: values },
            budget: new PromptBudget({
              maxOutputChars: PACKAGE_PANEL_HTML_LIMIT,
              maxSteps: 20_000,
            }),
            escapeTemplateValues: true,
          }
        ),
        css: panel.css ?? '',
        actions: panel.actions ?? [],
      };
    } catch {
      // Optional views must not hide chat or the standard state/action controls. Do not expose arbitrary errors.
      return {
        id: panel.id,
        title: panel.title,
        html: '',
        css: '',
        actions: [],
        issue: 'PACKAGE_PANEL_RENDER_FAILED',
      };
    }
  });
}
