import fastifyCompress from '@fastify/compress';
import type { FastifyInstance } from 'fastify';
import { constants } from 'node:zlib';

export const COMPRESSION_THRESHOLD_BYTES = 1024;
export const BROTLI_QUALITY = 4;

export function registerResponseCompression(app: FastifyInstance) {
  return app.register(fastifyCompress, {
    globalDecompression: false,
    encodings: ['br', 'gzip'],
    threshold: COMPRESSION_THRESHOLD_BYTES,
    brotliOptions: { params: { [constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY } },
  });
}
