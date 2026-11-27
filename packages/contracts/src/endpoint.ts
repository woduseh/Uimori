import type { z } from 'zod';

export type Operation<
  N extends string = string,
  I extends z.ZodTypeAny = z.ZodTypeAny,
  O extends z.ZodTypeAny = z.ZodTypeAny,
> = { readonly name: N; readonly input: I; readonly output: O };

export const defineOperation = <
  const N extends string,
  I extends z.ZodTypeAny,
  O extends z.ZodTypeAny,
>(
  name: N,
  input: I,
  output: O
): Operation<N, I, O> => ({ name, input, output });

export type OperationInput<Op extends Operation> = z.input<Op['input']>;
export type OperationOutput<Op extends Operation> = z.output<Op['output']>;

export type HttpMethod = 'GET' | 'PUT' | 'POST' | 'DELETE';

export type Endpoint<Op extends Operation = Operation> = {
  readonly operation: Op['name'];
  readonly method: HttpMethod;
  readonly path: `/${string}`;
  readonly status?: number;
  readonly bodyLimit?: number;
  readonly '~operation'?: Op;
};

export const defineEndpoint = <Op extends Operation>(endpoint: Endpoint<Op>): Endpoint<Op> =>
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
