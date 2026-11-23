export class ByteBoundedCache<Value> {
  readonly #entries = new Map<string, { value: Value; bytes: number; expiresAt: number }>();
  readonly #maxBytes: number;
  readonly #maxEntries: number;
  readonly #ttlMs: number;
  #bytes = 0;

  constructor(options: { maxBytes: number; maxEntries: number; ttlMs?: number }) {
    this.#maxBytes = options.maxBytes;
    this.#maxEntries = options.maxEntries;
    this.#ttlMs = options.ttlMs ?? Number.POSITIVE_INFINITY;
  }

  get bytes(): number {
    return this.#bytes;
  }

  get size(): number {
    return this.#entries.size;
  }

  get(key: string): Value | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    this.#entries.delete(key);
    if (entry.expiresAt <= performance.now()) {
      this.#bytes -= entry.bytes;
      return undefined;
    }
    this.#entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: Value, bytes: number): void {
    this.delete(key);
    if (bytes > this.#maxBytes) return;
    this.#entries.set(key, { value, bytes, expiresAt: performance.now() + this.#ttlMs });
    this.#bytes += bytes;
    for (const [oldest, entry] of this.#entries) {
      if (this.#bytes <= this.#maxBytes && this.#entries.size <= this.#maxEntries) break;
      this.#entries.delete(oldest);
      this.#bytes -= entry.bytes;
    }
  }

  delete(key: string): void {
    const entry = this.#entries.get(key);
    if (!entry) return;
    this.#entries.delete(key);
    this.#bytes -= entry.bytes;
  }

  clear(): void {
    this.#entries.clear();
    this.#bytes = 0;
  }
}
