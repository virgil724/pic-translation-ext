import { describe, expect, it, vi } from 'vitest';
import {
  buildCacheKey,
  Cache,
  PassthroughBackend,
  sha256Hex,
  type CacheBackend,
  type CacheOptions,
} from '../src/background/cache';

class MemoryBackend implements CacheBackend<string> {
  readonly store = new Map<string, string>();
  readonly setCalls: { key: string; options: CacheOptions | undefined }[] = [];

  get(key: string): Promise<string | undefined> {
    return Promise.resolve(this.store.get(key));
  }

  set(key: string, value: string, options?: CacheOptions): Promise<void> {
    this.setCalls.push({ key, options });
    this.store.set(key, value);
    return Promise.resolve();
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('Cache.getOrFetch', () => {
  it('同一個 key 的並發請求只呼叫一次 fetcher，全部拿到同一個結果', async () => {
    const cache = new Cache<string>(new PassthroughBackend());
    const gate = deferred<string>();
    const fetcher = vi.fn(() => gate.promise);

    const pending = [
      cache.getOrFetch('k', fetcher),
      cache.getOrFetch('k', fetcher),
      cache.getOrFetch('k', fetcher),
    ];
    gate.resolve('value');

    await expect(Promise.all(pending)).resolves.toEqual(['value', 'value', 'value']);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('不同的 key 各自呼叫 fetcher', async () => {
    const cache = new Cache<string>(new PassthroughBackend());
    const fetcher = vi.fn((): Promise<string> => Promise.resolve('value'));

    await Promise.all([cache.getOrFetch('a', fetcher), cache.getOrFetch('b', fetcher)]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('PassthroughBackend：請求結束後同一個 key 會再呼叫 fetcher', async () => {
    const cache = new Cache<string>(new PassthroughBackend());
    const fetcher = vi.fn((): Promise<string> => Promise.resolve('value'));

    await cache.getOrFetch('k', fetcher);
    await cache.getOrFetch('k', fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('fetcher 失敗時所有等待者都收到錯誤，而且不寫入後端', async () => {
    const backend = new MemoryBackend();
    const cache = new Cache<string>(backend);
    const gate = deferred<string>();
    const fetcher = vi.fn(() => gate.promise);

    const first = cache.getOrFetch('k', fetcher);
    const second = cache.getOrFetch('k', fetcher);
    gate.reject(new Error('boom'));

    await expect(first).rejects.toThrow('boom');
    await expect(second).rejects.toThrow('boom');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(backend.setCalls).toEqual([]);
  });

  it('fetcher 失敗後下一次請求會重新呼叫 fetcher', async () => {
    const backend = new MemoryBackend();
    const cache = new Cache<string>(backend);
    const fetcher = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce('recovered');

    await expect(cache.getOrFetch('k', fetcher)).rejects.toThrow('boom');
    await expect(cache.getOrFetch('k', fetcher)).resolves.toBe('recovered');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(backend.store.get('k')).toBe('recovered');
  });

  it('換成有儲存能力的後端後，命中時不呼叫 fetcher，options 會傳給後端', async () => {
    const backend = new MemoryBackend();
    const cache = new Cache<string>(backend);
    const fetcher = vi.fn((): Promise<string> => Promise.resolve('value'));

    await cache.getOrFetch('k', fetcher, { ttlMs: 1000 });
    await expect(cache.getOrFetch('k', fetcher)).resolves.toBe('value');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(backend.setCalls).toEqual([{ key: 'k', options: { ttlMs: 1000 } }]);
  });
});

describe('buildCacheKey', () => {
  const base = {
    imageBytes: new TextEncoder().encode('abc'),
    targetLang: 'zh-TW',
    model: 'model-a',
    promptVersion: 1,
  };

  it('SHA-256 與已知測試向量一致', async () => {
    await expect(sha256Hex(new TextEncoder().encode('abc'))).resolves.toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('相同輸入得到相同的 key', async () => {
    expect(await buildCacheKey(base)).toBe(await buildCacheKey({ ...base }));
  });

  it('截圖、目標語言、模型、prompt 版本任一不同，key 就不同', async () => {
    const keys = await Promise.all([
      buildCacheKey(base),
      buildCacheKey({ ...base, imageBytes: new TextEncoder().encode('abd') }),
      buildCacheKey({ ...base, targetLang: 'en' }),
      buildCacheKey({ ...base, model: 'model-b' }),
      buildCacheKey({ ...base, promptVersion: 2 }),
    ]);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
