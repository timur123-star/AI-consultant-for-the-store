// In-memory mock для Redis-клиента из 'redis' пакета.
// Покрывает только методы, которые используют наши модули
// (cart, session, carousel): sAdd, sRem, sMembers, sCard, sIsMember,
// rPush, lRange, lTrim, get, set, del, expire, incr, ping, multi.exec.
//
// Используется в тестах через vi.mock('redis', ...) — модуль возвращает
// фабрику createClient(), которая создаёт новый изолированный mock.

export interface MockRedisClient {
  readonly isOpen: boolean;
  connect(): Promise<void>;
  quit(): Promise<void>;
  on(): void;
  ping(): Promise<string>;
  sAdd(key: string, member: string | string[]): Promise<number>;
  sRem(key: string, member: string | string[]): Promise<number>;
  sMembers(key: string): Promise<string[]>;
  sCard(key: string): Promise<number>;
  sIsMember(key: string, member: string): Promise<number>;
  rPush(key: string, value: string): Promise<number>;
  lRange(key: string, start: number, stop: number): Promise<string[]>;
  lTrim(key: string, start: number, stop: number): Promise<string>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string | number, opts?: { EX?: number }): Promise<string>;
  del(key: string | string[]): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  incr(key: string): Promise<number>;
  keys(pattern: string): Promise<string[]>;
  multi(): MockRedisTx;
  __dump(): { data: Map<string, unknown>; ttls: Map<string, NodeJS.Timeout> };
}

export interface MockRedisTx {
  rPush(key: string, value: string): MockRedisTx;
  lTrim(key: string, start: number, stop: number): MockRedisTx;
  expire(key: string, seconds: number): MockRedisTx;
  incr(key: string): MockRedisTx;
  exec(): Promise<unknown[]>;
}

export interface MockRedisModule {
  createClient(): MockRedisClient;
  __stores: MockRedisClient[];
}

export function createMockRedisModule(): MockRedisModule {
  const stores: MockRedisClient[] = []; // массив всех созданных клиентов.

  function createClient(): MockRedisClient {
    const data = new Map<string, unknown>();
    const ttls = new Map<string, NodeJS.Timeout>();
    let isOpen = false;

    function asSet(key: string): Set<string> {
      const v = data.get(key);
      if (v instanceof Set) return v as Set<string>;
      const s = new Set<string>();
      data.set(key, s);
      return s;
    }
    function asList(key: string): string[] {
      const v = data.get(key);
      if (Array.isArray(v)) return v as string[];
      const l: string[] = [];
      data.set(key, l);
      return l;
    }
    function applyTtl(key: string, seconds: number): void {
      const ms = seconds * 1000;
      const t = setTimeout(() => {
        data.delete(key);
        ttls.delete(key);
      }, ms);
      if (typeof t.unref === 'function') t.unref();
      const prev = ttls.get(key);
      if (prev) clearTimeout(prev);
      ttls.set(key, t);
    }

    const client: MockRedisClient = {
      get isOpen() {
        return isOpen;
      },
      async connect() {
        isOpen = true;
      },
      async quit() {
        isOpen = false;
        for (const t of ttls.values()) clearTimeout(t);
        ttls.clear();
        data.clear();
      },
      on() {},
      async ping() {
        return 'PONG';
      },
      async sAdd(key: string, member: string | string[]) {
        const s = asSet(key);
        const before = s.size;
        const members = Array.isArray(member) ? member : [member];
        for (const m of members) s.add(String(m));
        return s.size - before;
      },
      async sRem(key: string, member: string | string[]) {
        const s = asSet(key);
        const members = Array.isArray(member) ? member : [member];
        let removed = 0;
        for (const m of members) {
          if (s.delete(String(m))) removed += 1;
        }
        return removed;
      },
      async sMembers(key: string) {
        const s = data.get(key);
        if (!(s instanceof Set)) return [];
        return Array.from(s as Set<string>);
      },
      async sCard(key: string) {
        const s = data.get(key);
        return s instanceof Set ? (s as Set<string>).size : 0;
      },
      async sIsMember(key: string, member: string) {
        const s = data.get(key);
        return s instanceof Set && (s as Set<string>).has(String(member)) ? 1 : 0;
      },
      async rPush(key: string, value: string) {
        const l = asList(key);
        l.push(value);
        return l.length;
      },
      async lRange(key: string, start: number, stop: number) {
        const l = data.get(key);
        if (!Array.isArray(l)) return [];
        const arr = l as string[];
        const len = arr.length;
        const s = start < 0 ? Math.max(0, len + start) : Math.min(start, len);
        const e = stop < 0 ? len + stop : Math.min(stop, len - 1);
        return arr.slice(s, e + 1);
      },
      async lTrim(key: string, start: number, stop: number) {
        const l = data.get(key);
        if (!Array.isArray(l)) return 'OK';
        const arr = l as string[];
        const len = arr.length;
        const s = start < 0 ? Math.max(0, len + start) : Math.min(start, len);
        const e = stop < 0 ? len + stop : Math.min(stop, len - 1);
        const sliced = arr.slice(s, e + 1);
        data.set(key, sliced);
        return 'OK';
      },
      async get(key: string) {
        const v = data.get(key);
        return typeof v === 'string' ? v : null;
      },
      async set(key: string, value: string | number, opts?: { EX?: number }) {
        data.set(key, String(value));
        if (opts?.EX) applyTtl(key, opts.EX);
        return 'OK';
      },
      async del(key: string | string[]) {
        const keys = Array.isArray(key) ? key : [key];
        let removed = 0;
        for (const k of keys) {
          if (data.delete(k)) removed += 1;
          const t = ttls.get(k);
          if (t) {
            clearTimeout(t);
            ttls.delete(k);
          }
        }
        return removed;
      },
      async expire(key: string, seconds: number) {
        if (!data.has(key)) return 0;
        applyTtl(key, seconds);
        return 1;
      },
      async incr(key: string) {
        const cur = Number(data.get(key) || 0);
        const next = cur + 1;
        data.set(key, String(next));
        return next;
      },
      async keys(pattern: string) {
        // Простой glob: только `prefix*` достаточно для нашего use case (flushCache).
        const star = pattern.indexOf('*');
        if (star === -1) {
          return data.has(pattern) ? [pattern] : [];
        }
        const prefix = pattern.slice(0, star);
        return Array.from(data.keys()).filter((k) => k.startsWith(prefix));
      },
      multi() {
        const ops: Array<() => Promise<unknown>> = [];
        const tx: MockRedisTx = {
          rPush: (k: string, v: string) => (ops.push(() => client.rPush(k, v)), tx),
          lTrim: (k: string, s: number, e: number) => (ops.push(() => client.lTrim(k, s, e)), tx),
          expire: (k: string, s: number) => (ops.push(() => client.expire(k, s)), tx),
          incr: (k: string) => (ops.push(() => client.incr(k)), tx),
          async exec() {
            const results: unknown[] = [];
            for (const fn of ops) results.push(await fn());
            return results;
          },
        };
        return tx;
      },
      // Прозрачный доступ к внутренностям — полезно в тестах.
      __dump() {
        return { data, ttls };
      },
    };
    stores.push(client);
    return client;
  }

  return { createClient, __stores: stores };
}
