import { z } from 'zod/v4';
import type { OperationEffect, OutputPolicy, SplitOperation } from './endpoint.js';

function defineOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

export function splitHeadBody(
  head: z.ZodObject<z.ZodRawShape>,
  raw: Record<string, unknown>
): { headRaw: Record<string, unknown>; bodyRaw: Record<string, unknown> } {
  const headRaw: Record<string, unknown> = {};
  const bodyRaw: Record<string, unknown> = {};
  for (const key of Object.keys(raw)) {
    if (Object.hasOwn(head.shape, key)) defineOwn(headRaw, key, raw[key]);
    else defineOwn(bodyRaw, key, raw[key]);
  }
  return { headRaw, bodyRaw };
}

export function combineStrictObject<
  H extends z.ZodObject<z.ZodRawShape>,
  B extends z.ZodObject<z.ZodRawShape>,
>(head: H, body: B): z.ZodObject<H['shape'] & B['shape']> {
  for (const key of Object.keys(body.shape)) {
    if (Object.hasOwn(head.shape, key))
      throw new Error(`SplitOperation head and body share key: ${key}`);
  }
  return z.strictObject({ ...head.shape, ...body.shape }) as z.ZodObject<H['shape'] & B['shape']>;
}

function mergeBranch(
  head: z.ZodObject<z.ZodRawShape>,
  branch: z.ZodObject<z.ZodRawShape>
): z.ZodType {
  return combineStrictObject(head, branch).superRefine((value, ctx) => {
    const { bodyRaw } = splitHeadBody(head, value as Record<string, unknown>);
    const checked = branch.safeParse(bodyRaw);
    if (checked.success) return;
    for (const issue of checked.error.issues) ctx.addIssue({ ...issue });
  });
}

function combineInput<H extends z.ZodObject<z.ZodRawShape>, B extends z.ZodType>(
  head: H,
  body: B
): z.ZodType<z.output<H> & z.output<B>, z.input<H> & z.input<B>> {
  const def = (body as unknown as { _zod?: { def?: { type?: string; options?: unknown[] } } })._zod
    ?.def;
  if (def?.type === 'object') {
    return mergeBranch(head, body as unknown as z.ZodObject<z.ZodRawShape>) as unknown as z.ZodType<
      z.output<H> & z.output<B>,
      z.input<H> & z.input<B>
    >;
  }
  if (def?.type === 'union' && Array.isArray(def.options) && def.options.length >= 2) {
    const branches = def.options.map((option) => {
      const optionDef = (option as { _zod?: { def?: { type?: string } } })._zod?.def;
      if (optionDef?.type !== 'object')
        throw new Error('SplitOperation union body branches must be strict objects');
      return mergeBranch(head, option as z.ZodObject<z.ZodRawShape>);
    });
    return z.union(branches as [z.ZodType, z.ZodType, ...z.ZodType[]]) as unknown as z.ZodType<
      z.output<H> & z.output<B>,
      z.input<H> & z.input<B>
    >;
  }
  throw new Error('SplitOperation body must be a strict object or a union of strict objects');
}

type OutputSpec<Out> =
  | { readonly outputPolicy?: 'test'; readonly output?: z.ZodType<Out> }
  | { readonly outputPolicy: 'always'; readonly output: z.ZodType<Out> };

type SplitOperationFields<
  N extends string,
  H extends z.ZodObject<z.ZodRawShape>,
  B extends z.ZodType,
  S extends boolean,
> = {
  readonly name: N;
  readonly head: H;
  readonly body: B;
  readonly sensitive?: S;
  readonly effects?: readonly OperationEffect[];
};

export type SplitOperationSpec<
  N extends string,
  H extends z.ZodObject<z.ZodRawShape>,
  B extends z.ZodType,
  Out,
  S extends boolean,
> = SplitOperationFields<N, H, B, S> & {
  readonly kind: 'command' | 'query';
} & OutputSpec<Out>;

function buildSplitOperation<
  N extends string,
  H extends z.ZodObject<z.ZodRawShape>,
  B extends z.ZodType,
  Out,
  S extends boolean,
>(
  kind: 'command' | 'query',
  spec: SplitOperationFields<N, H, B, S> & OutputSpec<Out>
): SplitOperation<N, H, B, Out, z.ZodType<z.output<H> & z.output<B>, z.input<H> & z.input<B>>, S> {
  return {
    kind,
    name: spec.name,
    head: spec.head,
    body: spec.body,
    input: combineInput(spec.head, spec.body),
    ...(spec.output ? { output: spec.output } : {}),
    ...(spec.outputPolicy ? { outputPolicy: spec.outputPolicy as OutputPolicy } : {}),
    ...(spec.sensitive ? { sensitive: true } : {}),
    ...(spec.effects ? { effects: spec.effects } : {}),
  } as SplitOperation<
    N,
    H,
    B,
    Out,
    z.ZodType<z.output<H> & z.output<B>, z.input<H> & z.input<B>>,
    S
  >;
}

export function defineSplitOperation<Out>() {
  return <
    const N extends string,
    H extends z.ZodObject<z.ZodRawShape>,
    B extends z.ZodType,
    const S extends boolean = false,
  >(
    spec: SplitOperationSpec<N, H, B, Out, S>
  ): SplitOperation<
    N,
    H,
    B,
    Out,
    z.ZodType<z.output<H> & z.output<B>, z.input<H> & z.input<B>>,
    S
  > => buildSplitOperation(spec.kind, spec);
}

export function defineCommandOperation<Out>() {
  return <
    const N extends string,
    H extends z.ZodObject<z.ZodRawShape>,
    B extends z.ZodType,
    const S extends boolean = false,
  >(
    spec: SplitOperationFields<N, H, B, S> & OutputSpec<Out>
  ): SplitOperation<
    N,
    H,
    B,
    Out,
    z.ZodType<z.output<H> & z.output<B>, z.input<H> & z.input<B>>,
    S
  > => buildSplitOperation('command', spec);
}

export function defineQueryOperation<Out>() {
  return <
    const N extends string,
    H extends z.ZodObject<z.ZodRawShape>,
    B extends z.ZodType,
    const S extends boolean = false,
  >(
    spec: SplitOperationFields<N, H, B, S> & OutputSpec<Out>
  ): SplitOperation<
    N,
    H,
    B,
    Out,
    z.ZodType<z.output<H> & z.output<B>, z.input<H> & z.input<B>>,
    S
  > => buildSplitOperation('query', spec);
}
