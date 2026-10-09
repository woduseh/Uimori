import { createReadStream, closeSync, openSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { parser } from 'stream-json/parser.js';
import {
  RISU_IMPORT_MAX_ASSETS,
  RISU_IMPORT_MAX_ENTRY_BYTES,
  RISU_IMPORT_MAX_JSON_BYTES,
} from '../core/risu-import.js';
import { invalidCard } from './risu-card-zip.js';

/** Incremental base64 decoder. Only one small encoded fragment remains between writes. */
export function base64File(path: string) {
  const fd = openSync(path, 'wx');
  let pending = '',
    size = 0,
    padded = false,
    closed = false;
  return {
    write(chunk: string) {
      if (padded && chunk.length) return invalidCard();
      if (!/^[A-Za-z0-9+/=]*$/u.test(chunk)) return invalidCard();
      pending += chunk;
      const end = pending.includes('=')
        ? pending.indexOf('=') - (pending.indexOf('=') % 4)
        : pending.length - (pending.length % 4);
      if (end) {
        const bytes = Buffer.from(pending.slice(0, end), 'base64');
        size += bytes.length;
        if (size > RISU_IMPORT_MAX_ENTRY_BYTES) return invalidCard();
        writeSync(fd, bytes);
        pending = pending.slice(end);
      }
      if (pending.includes('=') && pending.length >= 4) padded = true;
      if (pending.length > 4) return invalidCard();
    },
    finish() {
      if (pending) {
        const bytes = Buffer.from(pending, 'base64');
        if (bytes.toString('base64') !== pending) return invalidCard();
        size += bytes.length;
        if (size > RISU_IMPORT_MAX_ENTRY_BYTES) return invalidCard();
        writeSync(fd, bytes);
      }
      closeSync(fd);
      closed = true;
      return size;
    },
    close() {
      if (!closed) {
        closeSync(fd);
        closed = true;
      }
    },
  };
}

/** Tokenize strings in chunks: large data URIs never become a JSON string in memory. */
export async function readCardJson(
  path: string,
  directory: string,
  members: Map<string, () => Buffer>
) {
  type Frame = {
    value: Record<string, unknown> | unknown[];
    path: (string | number)[];
    key?: string;
  };
  const stack: Frame[] = [];
  let document: unknown,
    text = '',
    isKey = false,
    stringPath: (string | number)[] = [],
    metadata = 0,
    nodes = 0;
  let sink: ReturnType<typeof base64File> | undefined,
    target = '',
    assetCount = 0;
  const count = (n: number) => {
    metadata += n;
    if (metadata > RISU_IMPORT_MAX_JSON_BYTES) return invalidCard();
  };
  const nextPath = () => {
    const f = stack.at(-1);
    return f ? [...f.path, Array.isArray(f.value) ? f.value.length : (f.key ?? '')] : [];
  };
  const put = (value: unknown) => {
    if (++nodes > 250_000) return invalidCard();
    const f = stack.at(-1);
    if (!f) {
      document = value;
      return;
    }
    if (Array.isArray(f.value)) f.value.push(value);
    else {
      if (f.key === undefined) return invalidCard();
      Object.defineProperty(f.value, f.key, {
        value,
        writable: true,
        enumerable: true,
        configurable: true,
      });
      f.key = undefined;
    }
  };
  const input = createReadStream(path),
    tokens = input.pipe(parser.asStream({ packValues: false, streamValues: true }));
  input.on('error', (error) => tokens.destroy(error));
  try {
    for await (const token of tokens) {
      const value = typeof token.value === 'string' ? token.value : '';
      switch (token.name) {
        case 'startObject':
        case 'startArray': {
          count(2);
          if (stack.length >= 128) return invalidCard();
          const frame: Frame = { value: token.name === 'startArray' ? [] : {}, path: nextPath() };
          put(frame.value);
          stack.push(frame);
          break;
        }
        case 'endObject':
        case 'endArray':
          stack.pop();
          break;
        case 'startKey':
          isKey = true;
          text = '';
          break;
        case 'endKey': {
          const f = stack.at(-1);
          if (!f) return invalidCard();
          f.key = text;
          break;
        }
        case 'startString':
          isKey = false;
          text = '';
          stringPath = nextPath();
          break;
        case 'stringChunk': {
          if (sink) {
            sink.write(value);
            break;
          }
          text += value;
          const uri =
            stringPath.length === 4 &&
            stringPath[0] === 'data' &&
            stringPath[1] === 'assets' &&
            typeof stringPath[2] === 'number' &&
            stringPath[3] === 'uri';
          if (!isKey && uri && text.startsWith('data:')) {
            const comma = text.indexOf(',');
            if (comma < 0) {
              if (text.length > 256) return invalidCard();
              break;
            }
            if (!/^data:[^,;]{1,100};base64$/u.test(text.slice(0, comma))) return invalidCard();
            if (++assetCount > RISU_IMPORT_MAX_ASSETS) return invalidCard();
            target = `__card_inline__/${assetCount}.bin`;
            sink = base64File(join(directory, `inline-${assetCount}.bin`));
            sink.write(text.slice(comma + 1));
            text = '';
          } else count(Buffer.byteLength(value));
          break;
        }
        case 'endString': {
          if (sink) {
            sink.finish();
            sink = undefined;
            const diskPath = join(directory, `inline-${assetCount}.bin`);
            members.set(target, () => readFileSync(diskPath));
            text = `embeded://${target}`;
            count(text.length);
          }
          put(text);
          break;
        }
        case 'startNumber':
          text = '';
          break;
        case 'numberChunk':
          text += value;
          count(value.length);
          break;
        case 'endNumber':
          put(Number(text));
          break;
        case 'nullValue':
          put(null);
          count(4);
          break;
        case 'trueValue':
          put(true);
          count(4);
          break;
        case 'falseValue':
          put(false);
          count(5);
          break;
      }
    }
  } catch {
    return invalidCard();
  } finally {
    sink?.close();
    input.destroy();
    tokens.destroy();
  }
  if (Buffer.byteLength(JSON.stringify(document)) > RISU_IMPORT_MAX_JSON_BYTES)
    return invalidCard();
  return document;
}
