import type { FastifyInstance, FastifyRequest } from 'fastify';
import { measureSql, type SqlUsage } from './sql-metrics.js';

type RequestTiming = SqlUsage & {
  startedAt: number;
  authenticatedAt?: number;
  sent?: { statements: number; sqlMs: number };
};
type RequestSample = {
  method: string;
  route: string;
  statusCode: number;
  durationMs: number;
  responseBytes?: number;
  statements: number;
  sqlMs: number;
};

export const REQUEST_SAMPLE_CAPACITY = 4096;

const milliseconds = (value: number) => value.toFixed(1);
const rounded = (value: number) => Math.round(value * 10) / 10;

function percentiles(values: number[]) {
  if (!values.length) return { p50: null, p95: null, max: null };
  const sorted = values.toSorted((left, right) => left - right);
  const at = (fraction: number) =>
    rounded(sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)]!);
  return { p50: at(0.5), p95: at(0.95), max: rounded(sorted.at(-1)!) };
}

function serverTiming(timing: RequestTiming, finishedAt: number) {
  const parts = [];
  if (timing.authenticatedAt !== undefined)
    parts.push(`auth;dur=${milliseconds(timing.authenticatedAt - timing.startedAt)}`);
  parts.push(`db;dur=${milliseconds(timing.elapsedMs)};desc="q=${timing.statements}"`);
  parts.push(`total;dur=${milliseconds(finishedAt - timing.startedAt)}`);
  return parts.join(', ');
}

export function requestMetricsRoutes(app: FastifyInstance) {
  const timings = new WeakMap<FastifyRequest, RequestTiming>();
  const samples: RequestSample[] = [];
  let nextSample = 0;
  app.addHook('onRequest', (request, _reply, done) => {
    if (request.routeOptions.url?.startsWith('/api/') !== true) return done();
    const timing: RequestTiming = { startedAt: performance.now(), statements: 0, elapsedMs: 0 };
    timings.set(request, timing);
    measureSql(timing, done);
  });
  app.addHook('preValidation', (request, _reply, done) => {
    const timing = timings.get(request);
    if (!timing) return done();
    measureSql(timing, done);
  });
  app.addHook('onSend', (request, reply, payload, done) => {
    const timing = timings.get(request);
    if (timing) {
      timing.sent = { statements: timing.statements, sqlMs: timing.elapsedMs };
      reply.header('Server-Timing', serverTiming(timing, performance.now()));
    }
    done(null, payload);
  });
  app.addHook('onResponse', (request, reply, done) => {
    const timing = timings.get(request);
    if (timing?.sent) {
      const length = Number(reply.getHeader('content-length'));
      samples[nextSample] = {
        method: request.method,
        route: request.routeOptions.url!,
        statusCode: reply.statusCode,
        durationMs: performance.now() - timing.startedAt,
        ...(Number.isSafeInteger(length) && length >= 0 ? { responseBytes: length } : {}),
        statements: timing.sent.statements,
        sqlMs: timing.sent.sqlMs,
      };
      nextSample = (nextSample + 1) % REQUEST_SAMPLE_CAPACITY;
    }
    timings.delete(request);
    done();
  });
  app.get('/api/diagnostics/metrics', async (_request, reply) => {
    const groups = new Map<string, RequestSample[]>();
    for (const sample of samples) {
      const key = `${sample.method} ${sample.route}`;
      const group = groups.get(key);
      if (group) group.push(sample);
      else groups.set(key, [sample]);
    }
    const routes = [...groups.values()].map((group) => {
      const bytes = group.flatMap((sample) =>
        sample.responseBytes === undefined ? [] : [sample.responseBytes]
      );
      return {
        method: group[0]!.method,
        route: group[0]!.route,
        count: group.length,
        notModified: group.filter((sample) => sample.statusCode === 304).length,
        errors: group.filter((sample) => sample.statusCode >= 400).length,
        durationMs: percentiles(group.map((sample) => sample.durationMs)),
        responseBytes: {
          total: bytes.reduce((total, value) => total + value, 0),
          ...percentiles(bytes),
        },
        sqlStatements: percentiles(group.map((sample) => sample.statements)),
        sqlMs: percentiles(group.map((sample) => sample.sqlMs)),
      };
    });
    routes.sort((left, right) => right.count - left.count);
    return reply
      .header('Cache-Control', 'no-store')
      .send({ capacity: REQUEST_SAMPLE_CAPACITY, samples: samples.length, routes });
  });
  return {
    addAuthenticationMark() {
      app.addHook('onRequest', (request, _reply, done) => {
        const timing = timings.get(request);
        if (timing) timing.authenticatedAt = performance.now();
        done();
      });
    },
  };
}
