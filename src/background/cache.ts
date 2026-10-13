export interface CacheOptions {
  /** 給真正的後端用；PassthroughBackend 會忽略。 */
  ttlMs?: number;
}

export interface CacheBackend<V> {
  /** miss 時回傳 undefined。 */
  get(key: string): Promise<V | undefined>;
  set(key: string, value: V, options?: CacheOptions): Promise<void>;
}

/** 這一階段的後端：get 一律 miss，set 一律 no-op。 */
export class PassthroughBackend<V> implements CacheBackend<V> {
  get(): Promise<V | undefined> {
    return Promise.resolve(undefined);
  }

  set(): Promise<void> {
    return Promise.resolve();
  }
}

export class Cache<V> {
  // 只記錄「進行中」的請求。service worker 被終止時這些請求也一起消失，
  // 所以放在記憶體裡不會留下過期狀態；要保存的結果一律交給 backend。
  private readonly inFlight = new Map<string, Promise<V>>();

  constructor(private readonly backend: CacheBackend<V>) {}

  getOrFetch(key: string, fetcher: () => Promise<V>, options?: CacheOptions): Promise<V> {
    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const promise = this.resolve(key, fetcher, options).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, promise);
    return promise;
  }

  private async resolve(key: string, fetcher: () => Promise<V>, options?: CacheOptions): Promise<V> {
    const cached = await this.backend.get(key);
    if (cached !== undefined) return cached;
    // fetcher 失敗會直接拋出，不會走到 set。
    const value = await fetcher();
    await this.backend.set(key, value, options);
    return value;
  }
}

export interface CacheKeyParts {
  imageBytes: Uint8Array<ArrayBuffer>;
  targetLang: string;
  model: string;
  promptVersion: number;
}

export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function buildCacheKey(parts: CacheKeyParts): Promise<string> {
  const hash = await sha256Hex(parts.imageBytes);
  return [hash, parts.targetLang, parts.model, `p${parts.promptVersion}`].join('|');
}
