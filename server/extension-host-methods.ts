import { ExtensionProgramError, type ExtensionProgram } from '../core/extension-program.js';
import {
  HOST_LIST_PAGE_DEFAULT,
  HOST_LIST_PAGE_MAX,
  HOST_TEXT_PAGE_DEFAULT,
  HOST_TEXT_PAGE_MAX,
} from '../core/paging.js';
import type { RuntimeValue } from '../core/prompt-values.js';
import type { ExtensionHostHandler } from './extension-runtime.js';

export function failHost(code: string): never {
  throw new ExtensionProgramError(code);
}

/** The module that answers a method, and whose denial code an unknown sibling method receives. */
export type HostMethodOwner = 'materials' | 'variables' | 'conversation' | 'model' | 'response';
export type HostMethodPage = { readonly default: number; readonly max: number };
export type ExtensionCapability = NonNullable<ExtensionProgram['capabilities']>[number];
export type HostMethodEntry = {
  readonly owner: HostMethodOwner;
  readonly capability: ExtensionCapability;
  /** The only argument keys the method accepts. Anything else is BEHAVIOR_HOST_ARGUMENTS. */
  readonly args: readonly string[];
  /** Present for paged reads; absent for writes and for model.generate. */
  readonly page?: HostMethodPage;
};

const LIST_PAGE = { default: HOST_LIST_PAGE_DEFAULT, max: HOST_LIST_PAGE_MAX } as const;
const TEXT_PAGE = { default: HOST_TEXT_PAGE_DEFAULT, max: HOST_TEXT_PAGE_MAX } as const;
/** One conversation.page call spans several messages, so it defaults to the whole text budget. */
const SPAN_PAGE = { default: HOST_TEXT_PAGE_MAX, max: HOST_TEXT_PAGE_MAX } as const;

/**
 * Every Host method a guest may call, with the capability it needs, the argument keys it accepts
 * and its page bounds. Default-deny: a method absent here is refused before any module runs.
 * model.generate keeps its prompt contract in extension-model.ts; only the key set lives here.
 */
export const HOST_METHODS = {
  'materials.list': {
    owner: 'materials',
    capability: 'materials.read.self',
    args: ['offset', 'limit'],
    page: LIST_PAGE,
  },
  'materials.read': {
    owner: 'materials',
    capability: 'materials.read.self',
    args: ['id', 'offset', 'limit'],
    page: TEXT_PAGE,
  },
  /** The two projected names the fixed profile already gives the body and lore templates. */
  'identity.read': { owner: 'materials', capability: 'materials.read.self', args: [] },
  /** The control values the fixed profile resolved for this attachment; the same values the
   * body and lore templates substitute. No other profile field and no other attachment. */
  'options.read': { owner: 'materials', capability: 'materials.read.self', args: [] },
  'variables.list': {
    owner: 'variables',
    capability: 'variables.read',
    args: ['offset', 'limit'],
    page: LIST_PAGE,
  },
  'variables.read': {
    owner: 'variables',
    capability: 'variables.read',
    args: ['key', 'offset', 'limit'],
    page: TEXT_PAGE,
  },
  'variables.set': { owner: 'variables', capability: 'variables.write', args: ['key', 'value'] },
  'variables.delete': { owner: 'variables', capability: 'variables.write', args: ['key'] },
  'conversation.list': {
    owner: 'conversation',
    capability: 'conversation.read',
    args: ['offset', 'limit'],
    page: LIST_PAGE,
  },
  'conversation.read': {
    owner: 'conversation',
    capability: 'conversation.read',
    args: ['index', 'offset', 'limit'],
    page: TEXT_PAGE,
  },
  'conversation.page': {
    owner: 'conversation',
    capability: 'conversation.read',
    args: ['index', 'offset', 'limit'],
    page: SPAN_PAGE,
  },
  'model.generate': { owner: 'model', capability: 'model.generate', args: ['prompt'] },
  'response.read': {
    owner: 'response',
    capability: 'response.read.current',
    args: ['offset', 'limit'],
    page: TEXT_PAGE,
  },
} as const satisfies Readonly<Record<string, HostMethodEntry>>;

export type HostMethod = keyof typeof HOST_METHODS;
export type HostMethodOf<Owner extends HostMethodOwner> = {
  [Method in HostMethod]: (typeof HOST_METHODS)[Method]['owner'] extends Owner ? Method : never;
}[HostMethod];

/**
 * Namespaces whose module also answers for methods the table does not list, so that an undeclared
 * `variables.*` or `conversation.*` call keeps reporting that namespace's denial code.
 */
const UNKNOWN_METHOD_OWNERS = [
  ['conversation.', 'conversation'],
  ['variables.', 'variables'],
] as const satisfies readonly (readonly [string, HostMethodOwner])[];

/** Routing for one call. Unlisted methods fall to materials, which denies them. */
export function hostMethodOwner(method: string): HostMethodOwner {
  if (Object.hasOwn(HOST_METHODS, method)) return HOST_METHODS[method as HostMethod].owner;
  return UNKNOWN_METHOD_OWNERS.find(([prefix]) => method.startsWith(prefix))?.[1] ?? 'materials';
}

export type HostMethodArguments = Record<string, RuntimeValue>;
export type HostArgumentScreen = (
  value: RuntimeValue,
  keys: readonly string[]
) => HostMethodArguments;

/** Rejects a non-object shape and any key the method does not declare. */
export const hostArguments: HostArgumentScreen = (value, keys) => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    failHost('BEHAVIOR_HOST_ARGUMENTS');
  if (Object.keys(value).some((key) => !keys.includes(key))) failHost('BEHAVIOR_HOST_ARGUMENTS');
  return value as HostMethodArguments;
};

/** The same screen, also refusing accessors, symbol keys and a non-plain prototype. */
export const exactHostArguments: HostArgumentScreen = (value, keys) => {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Object.getOwnPropertySymbols(value).length
  )
    failHost('BEHAVIOR_HOST_ARGUMENTS');
  const args = value as HostMethodArguments;
  for (const key of Object.getOwnPropertyNames(args)) {
    const descriptor = Object.getOwnPropertyDescriptor(args, key)!;
    if (!keys.includes(key) || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable)
      failHost('BEHAVIOR_HOST_ARGUMENTS');
  }
  return args;
};

/** A bounded integer argument. An undefined `fallback` makes the argument required. */
export function hostInteger(
  value: RuntimeValue | undefined,
  fallback: number | undefined,
  min: number,
  max: number
): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    failHost('BEHAVIOR_HOST_ARGUMENTS');
  return value;
}

/** The offset/limit pair every paged method shares, parsed once with the table's bounds. */
export type HostMethodCall = {
  readonly args: HostMethodArguments;
  /** 0 for a method the table gives no page. */
  readonly offset: number;
  readonly limit: number;
};
export type HostMethodHandler = (call: HostMethodCall) => Promise<RuntimeValue>;

export type HostDispatcherOptions<Method extends HostMethod> = {
  /** Code for an unknown method and for a refused capability. */
  readonly denied: string;
  /** Module-level admission, asked with the method's own table entry. */
  readonly granted: (entry: HostMethodEntry) => boolean;
  /** Argument screen; modules differ in how hostile a shape they refuse. */
  readonly screen: HostArgumentScreen;
  /** Ownership, live permission and cancellation, before any argument is read. */
  readonly gate?: (entry: HostMethodEntry, signal: AbortSignal) => void;
  /** Argument checks the module must run before the shared page parse. */
  readonly precheck?: (entry: HostMethodEntry, args: HostMethodArguments) => void;
  readonly handlers: Readonly<Record<Method, HostMethodHandler>>;
};

/**
 * The one dispatch path every Host module shares: cancellation, exact-method lookup, capability,
 * the module's gates, exact argument keys and the shared page bounds, then the module's handler.
 */
export function createHostDispatcher<Method extends HostMethod>(
  options: HostDispatcherOptions<Method>
): ExtensionHostHandler {
  const table = new Map<string, { entry: HostMethodEntry; handler: HostMethodHandler }>(
    Object.entries(options.handlers).map(([method, handler]) => [
      method,
      { entry: HOST_METHODS[method as HostMethod], handler: handler as HostMethodHandler },
    ])
  );
  return async (method, value, signal): Promise<RuntimeValue> => {
    if (signal.aborted) failHost('BEHAVIOR_HOST_ABORTED');
    const found = table.get(method);
    if (!found || !options.granted(found.entry)) failHost(options.denied);
    options.gate?.(found.entry, signal);
    const args = options.screen(value, found.entry.args);
    options.precheck?.(found.entry, args);
    const page = found.entry.page;
    return found.handler({
      args,
      offset: page ? hostInteger(args.offset, 0, 0, Number.MAX_SAFE_INTEGER) : 0,
      limit: page ? hostInteger(args.limit, page.default, 1, page.max) : 0,
    });
  };
}
