import type { z } from 'zod/v4';

export type Operation<
  N extends string = string,
  I extends z.ZodType = z.ZodType,
  O extends z.ZodType = z.ZodType,
> = { readonly name: N; readonly input: I; readonly output: O };

export type OutputPolicy = 'always' | 'test';
export type OperationEffect = 'paid-generation';

export type SplitOperation<
  N extends string = string,
  H extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>,
  B extends z.ZodType = z.ZodType,
  Out = unknown,
  I extends z.ZodType = z.ZodType<z.output<H> & z.output<B>, z.input<H> & z.input<B>>,
  S extends boolean = boolean,
> = {
  readonly kind: 'command' | 'query';
  readonly name: N;
  readonly head: H;
  readonly body: B;
  readonly input: I;
  readonly output?: z.ZodType<Out>;
  readonly outputPolicy?: OutputPolicy;
  readonly effects?: readonly OperationEffect[];
  readonly '~output'?: Out;
} & (S extends true ? { readonly sensitive: true } : { readonly sensitive?: false });

export type AnyOperation = Operation<any, any, any> | SplitOperation<any, any, any, any, any, any>;

export const defineOperation = <const N extends string, I extends z.ZodType, O extends z.ZodType>(
  name: N,
  input: I,
  output: O
): Operation<N, I, O> => ({ name, input, output });

export type OperationInput<Op extends AnyOperation> = z.input<Op['input']>;
export type OperationParsedInput<Op extends AnyOperation> = z.output<Op['input']>;
export type OperationHead<Op extends SplitOperation<any, any, any, any, any, any>> = z.output<
  Op['head']
>;
export type OperationBody<Op extends SplitOperation<any, any, any, any, any, any>> = z.output<
  Op['body']
>;
export type OperationOutput<Op extends AnyOperation> =
  Op extends SplitOperation<any, any, any, infer Out, any, any>
    ? Out
    : Op extends Operation<any, any, infer O>
      ? z.output<O>
      : never;

export type HttpMethod = 'GET' | 'PUT' | 'POST' | 'PATCH' | 'DELETE';

export type Invalidation = 'library' | 'prompt-workspace' | 'provider-settings';

export type Endpoint<Op extends AnyOperation = AnyOperation> = {
  readonly operation: Op['name'];
  readonly method: HttpMethod;
  readonly path: `/${string}`;
  readonly status?: number | ((output: OperationOutput<Op>) => number);
  readonly bodyLimit?: number;
  readonly admission?: 'always';
  readonly cache?: 'revalidate' | 'no-store';
  readonly preferMinimal?: true;
  readonly invalidates?: readonly Invalidation[];
  readonly '~operation'?: Op;
};

export type PathParams<P extends string> = P extends `${string}:${infer Rest}`
  ? Rest extends `${infer Name}/${infer Tail}`
    ? Name | PathParams<`/${Tail}`>
    : Rest
  : never;

type PathInputKeys<I> = {
  [K in keyof I]-?: object extends Pick<I, K> ? never : I[K] extends string | number ? K : never;
}[keyof I];

type UnboundPathParams<P extends string, I> = Exclude<PathParams<P>, PathInputKeys<I>>;

type PathCheck<P extends string, I> = [UnboundPathParams<P, I>] extends [never]
  ? unknown
  : { 'path parameters need a required string or number input key': UnboundPathParams<P, I> };

type SensitiveCheck<Op extends AnyOperation> = Op extends { readonly sensitive: true }
  ? { readonly cache: 'no-store' }
  : unknown;

export const defineEndpoint =
  <Op extends AnyOperation>() =>
  <const P extends `/${string}`>(
    endpoint: Endpoint<Op> & { readonly path: P } & PathCheck<P, OperationInput<Op>> &
      SensitiveCheck<Op>
  ): Endpoint<Op> =>
    endpoint;

export type EndpointInput<E> = E extends Endpoint<infer Op> ? OperationInput<Op> : never;
export type EndpointOutput<E> = E extends Endpoint<infer Op> ? OperationOutput<Op> : never;

const pathParameter = /:([A-Za-z]\w*)/gu;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function endpointRequest(
  endpoint: Endpoint,
  input: Record<string, unknown> = {}
): { path: string; body?: Record<string, unknown> } {
  const bound = new Set<string>();
  const path = endpoint.path.replace(pathParameter, (_, name: string) => {
    bound.add(name);
    return encodeURIComponent(String(input[name]));
  });
  const rest = Object.fromEntries(
    Object.entries(input).filter(([name, value]) => !bound.has(name) && value !== undefined)
  );
  if (endpoint.method !== 'GET') return { path, body: rest };
  const query = new URLSearchParams(
    Object.entries(rest).map(([name, value]) => [name, String(value)])
  ).toString();
  return { path: query ? `${path}?${query}` : path };
}

export function endpointInput(
  endpoint: Endpoint,
  request: { params: unknown; query: unknown; body: unknown }
): unknown {
  const source = endpoint.method === 'GET' ? request.query : request.body;
  const params = isRecord(request.params) ? request.params : {};
  if (source === undefined) return { ...params };
  return isRecord(source) ? { ...source, ...params } : source;
}
