/** 简单 LRU：按条目数与总字符数双重限制。 */
export class LruCache {
  private readonly map = new Map<string, string>();
  private bytes = 0;
  hits = 0;
  misses = 0;
  private readonly maxEntries: number;
  private readonly maxChars: number;

  constructor(maxEntries = 400, maxChars = 64 * 1024 * 1024) {
    this.maxEntries = maxEntries;
    this.maxChars = maxChars;
  }

  get size(): number {
    return this.map.size;
  }

  get(key: string): string | undefined {
    const v = this.map.get(key);
    if (v === undefined) {
      this.misses++;
      return undefined;
    }
    this.hits++;
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }

  set(key: string, value: string): void {
    const old = this.map.get(key);
    if (old !== undefined) {
      this.bytes -= old.length;
      this.map.delete(key);
    }
    this.map.set(key, value);
    this.bytes += value.length;
    while (this.map.size > this.maxEntries || this.bytes > this.maxChars) {
      const first = this.map.keys().next();
      if (first.done) break;
      this.bytes -= this.map.get(first.value)!.length;
      this.map.delete(first.value);
    }
  }

  clear(): void {
    this.map.clear();
    this.bytes = 0;
  }
}
