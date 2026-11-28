import { z } from 'zod/v4';
import type { OutputPolicy, SplitOperation } from './endpoint.js';

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

function unwrapObjectShape(schema: unknown): z.ZodRawShape | undefined {
  const def = (
    schema as { _zod?: { def?: { type?: string; in?: unknown; shape?: z.ZodRawShape } } }
  )._zod?.def;
  if (def?.type === 'object') return def.shape;
  if (def?.type === 'pipe') return unwrapObjectShape(def.in);
  return undefined;
}

function assertDisjointKeys(head: z.ZodObject<z.ZodRawShape>, bodyShape: z.ZodRawShape): void {
  for (const key of Object.keys(bodyShape)) {
    if (Object.hasOwn(head.shape, key))
      throw new Error(`SplitOperation head and body share key: ${key}`);
  }
}

export function combineStrictObject<
  H extends z.ZodObject<z.ZodRawShape>,
  B extends z.ZodObject<z.ZodRawShape>,
>(head: H, body: B): z.ZodObject<H['shape'] & B['shape']> {
  assertDisjointKeys(head, body.shape);
  return z.strictObject({ ...head.shape, ...body.shape }) as z.ZodObject<H['shape'] & B['shape']>;
}

function validateBodyStructure(head: z.ZodObject<z.ZodRawShape>, body: z.ZodType): void {
  const directShape = unwrapObjectShape(body);
  if (directShape) {
    assertDisjointKeys(head, directShape);
    return;
  }
  const def = (body as unknown as { _zod?: { def?: { type?: string; options?: unknown[] } } })._zod
    ?.def;
  if (def?.type === 'union' && Array.isArray(def.options) && def.options.length >= 2) {
    for (const option of def.options) {
      const shape = unwrapObjectShape(option);
      if (!shape) throw new Error('SplitOperation union body branches must be strict objects');
      assertDisjointKeys(head, shape);
    }
    return;
  }
  throw new Error('SplitOperation body must be a strict object or a union of strict objects');
}

function combineInput<H extends z.ZodObject<z.ZodRawShape>, B extends z.ZodType>(
  head: H,
  body: B
): z.ZodType<z.output<H> & z.output<B>, z.input<H> & z.input<B>> {
  validateBodyStructure(head, body);
  return z.unknown().transform((raw, ctx) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      ctx.addIssue({ code: 'custom', message: 'Expected an object' });
      return z.NEVER;
    }
    const { headRaw, bodyRaw } = splitHeadBody(head, raw as Record<string, unknown>);
    const parsedHead = head.safeParse(headRaw);
    const parsedBody = body.safeParse(bodyRaw);
    if (!parsedHead.success) {
      for (const issue of parsedHead.error.issues) ctx.addIssue({ ...issue });
    }
    if (!parsedBody.success) {
      for (const issue of parsedBody.error.issues) ctx.addIssue({ ...issue });
    }
    if (!parsedHead.success || !parsedBody.success) return z.NEVER;
    return {
      ...(parsedHead.data as Record<string, unknown>),
      ...(parsedBody.data as Record<string, unknown>),
    };
  }) as unknown as z.ZodType<z.output<H> & z.output<B>, z.input<H> & z.input<B>>;
}

type OutputSpec<Out> =
  | { readonly outputPolicy?: 'test'; readonly output?: z.ZodType<Out> }
  | { readonly outputPolicy: 'always'; readonly output: z.ZodType<Out> };

export function defineCommandOperation<Out>() {
  return <const N extends string, H extends z.ZodObject<z.ZodRawShape>, B extends z.ZodType>(
    spec: { readonly name: N; readonly head: H; readonly body: B } & OutputSpec<Out>
  ): SplitOperation<N, H, B, Out> => ({
    kind: 'command',
    name: spec.name,
    head: spec.head,
    body: spec.body,
    input: combineInput(spec.head, spec.body),
    ...(spec.output ? { output: spec.output } : {}),
    ...(spec.outputPolicy ? { outputPolicy: spec.outputPolicy as OutputPolicy } : {}),
  });
}
