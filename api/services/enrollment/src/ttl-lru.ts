/** A small in-process cache: entries expire after `ttlMs`, and past `max` the least recently used one goes. */
export class TtlLru<V> {
  private readonly map = new Map<string, { value: V; expires: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly max: number,
  ) {}

  get(key: string): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    this.map.delete(key);
    if (hit.expires <= Date.now()) return undefined;
    this.map.set(key, hit); // most recently used last
    return hit.value;
  }

  set(key: string, value: V): void {
    this.map.delete(key);
    this.map.set(key, { value, expires: Date.now() + this.ttlMs });
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string);
  }

  deleteWhere(match: (key: string, value: V) => boolean): void {
    for (const [key, { value }] of this.map) if (match(key, value)) this.map.delete(key);
  }
}
