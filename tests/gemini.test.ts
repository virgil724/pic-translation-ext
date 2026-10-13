import { describe, expect, it, vi } from 'vitest';
import {
  GeminiBlockedError,
  GeminiHttpError,
  GeminiParseError,
  parseItems,
  readSseBody,
  translateImage,
  type GeminiDeps,
  type GeminiRequest,
} from '../src/background/gemini';
import type { TranslationItem } from '../src/shared/types';

const request: GeminiRequest = {
  provider: 'gemini-api',
  apiKey: 'test-key',
  model: 'test-model',
  prompt: 'translate',
  imageBase64: 'AAAA',
};

const item: TranslationItem = {
  box_2d: [100, 200, 300, 400],
  source: 'こんにちは',
  translation: '你好',
  kind: 'dialogue',
  vertical: true,
};

/** 把模型輸出的文字切成數個 SSE 事件，模擬串流回應。 */
function sse(text: string, finishReason = 'STOP'): Response {
  const middle = Math.floor(text.length / 2);
  const chunks = [text.slice(0, middle), text.slice(middle)];
  const events = chunks.map((chunk, index) => ({
    candidates: [
      {
        content: { role: 'model', parts: [{ text: chunk }] },
        ...(index === chunks.length - 1 ? { finishReason } : {}),
      },
    ],
  }));
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function httpError(status: number, message = 'nope'): Response {
  return new Response(JSON.stringify({ error: { code: status, message } }), { status });
}

function setup(responses: Response[]) {
  const queue = [...responses];
  const fetchFn = vi.fn<typeof fetch>(() => {
    const next = queue.shift();
    if (!next) throw new Error('測試沒有準備足夠的回應');
    return Promise.resolve(next);
  });
  const sleep = vi.fn<(ms: number) => Promise<void>>(() => Promise.resolve());
  const deps: GeminiDeps = { fetchFn, sleep, random: () => 0 };
  return { deps, fetchFn, sleep };
}

describe('parseItems', () => {
  it('接受符合格式的陣列', () => {
    expect(parseItems(JSON.stringify([item]))).toEqual({ ok: true, items: [item] });
  });

  it('接受空陣列', () => {
    expect(parseItems('[]')).toEqual({ ok: true, items: [] });
  });

  it('保留 translation 為空字串的項目（由疊加層決定不畫）', () => {
    const sfx = { ...item, kind: 'sfx', translation: '' };
    expect(parseItems(JSON.stringify([sfx]))).toEqual({ ok: true, items: [sfx] });
  });

  it.each([
    ['不是 JSON', 'not json'],
    ['被截斷的 JSON', '[{"box_2d": [1, 2, 3'],
    ['JSON 前後夾雜文字', `結果如下：${JSON.stringify([item])}`],
    ['包在 markdown 程式碼區塊裡', '```json\n[]\n```'],
    ['最外層不是陣列', JSON.stringify({ items: [item] })],
    ['box_2d 少一個值', JSON.stringify([{ ...item, box_2d: [1, 2, 3] }])],
    ['box_2d 含非數字', JSON.stringify([{ ...item, box_2d: [1, 2, 3, 'x'] }])],
    ['kind 不在列舉內', JSON.stringify([{ ...item, kind: 'title' }])],
    ['vertical 不是布林', JSON.stringify([{ ...item, vertical: 'true' }])],
    ['缺少 translation', JSON.stringify([{ box_2d: [1, 2, 3, 4], source: 'a', kind: 'sfx', vertical: false }])],
  ])('拒絕：%s', (_name, text) => {
    expect(parseItems(text).ok).toBe(false);
  });
});

describe('readSseBody', () => {
  it('依序接起各事件的文字，略過思考片段', () => {
    const body = [
      `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'thinking', thought: true }] } }] })}`,
      '',
      `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: '[1,' }] } }] })}`,
      '',
      `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: '2]' }] }, finishReason: 'STOP' }] })}`,
      '',
    ].join('\r\n');
    expect(readSseBody(body)).toEqual({ text: '[1,2]', finishReason: 'STOP' });
  });

  it('讀出 promptFeedback.blockReason', () => {
    const body = `data: ${JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } })}\n\n`;
    expect(readSseBody(body)).toEqual({ text: '', blockReason: 'SAFETY' });
  });
});

describe('translateImage', () => {
  it('成功時回傳解析後的項目，並用 header 帶 API key、要求結構化輸出', async () => {
    const { deps, fetchFn } = setup([sse(JSON.stringify([item]))]);

    await expect(translateImage(request, deps)).resolves.toEqual([item]);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/test-model:streamGenerateContent?alt=sse',
    );
    expect(new Headers(init?.headers).get('x-goog-api-key')).toBe('test-key');
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
      generationConfig?: { responseMimeType?: string; responseSchema?: { type?: string } };
    };
    expect(body.generationConfig?.responseMimeType).toBe('application/json');
    expect(body.generationConfig?.responseSchema?.type).toBe('ARRAY');
  });

  it('Agent Platform 的 key 改打 aiplatform 端點，其餘不變', async () => {
    const { deps, fetchFn } = setup([sse(JSON.stringify([item]))]);

    await expect(translateImage({ ...request, provider: 'agent-platform' }, deps)).resolves.toEqual([item]);

    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(url).toBe(
      'https://aiplatform.googleapis.com/v1/publishers/google/models/test-model:streamGenerateContent?alt=sse',
    );
    expect(new Headers(init?.headers).get('x-goog-api-key')).toBe('test-key');
  });

  it('JSON 解析失敗時重試 1 次，第二次成功就回傳結果', async () => {
    const { deps, fetchFn, sleep } = setup([sse('[{"box_2d": [1, 2'), sse(JSON.stringify([item]))]);

    await expect(translateImage(request, deps)).resolves.toEqual([item]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('JSON 解析連續失敗 2 次就回報錯誤，不再重試', async () => {
    const { deps, fetchFn } = setup([sse('not json'), sse('still not json'), sse('[]')]);

    await expect(translateImage(request, deps)).rejects.toBeInstanceOf(GeminiParseError);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('格式不符（合法 JSON 但欄位錯誤）也算解析失敗', async () => {
    const bad = JSON.stringify([{ ...item, kind: 'unknown' }]);
    const { deps, fetchFn } = setup([sse(bad), sse(bad)]);

    await expect(translateImage(request, deps)).rejects.toBeInstanceOf(GeminiParseError);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('不會從夾雜文字的輸出裡撈 JSON', async () => {
    const wrapped = `Here you go: ${JSON.stringify([item])}`;
    const { deps } = setup([sse(wrapped), sse(wrapped)]);

    await expect(translateImage(request, deps)).rejects.toBeInstanceOf(GeminiParseError);
  });

  it('串流事件本身不是合法 JSON 時走同一條重試路徑', async () => {
    const broken = new Response('data: {"candidates": [\n\n', { status: 200 });
    const { deps, fetchFn } = setup([broken, sse(JSON.stringify([item]))]);

    await expect(translateImage(request, deps)).resolves.toEqual([item]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('429 以指數退避重試', async () => {
    const { deps, fetchFn, sleep } = setup([httpError(429), httpError(429), sse('[]')]);

    await expect(translateImage(request, deps)).resolves.toEqual([]);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1000, 2000]);
  });

  it('5xx 最多重試 3 次，之後回報錯誤', async () => {
    const { deps, fetchFn, sleep } = setup([
      httpError(503),
      httpError(500),
      httpError(503),
      httpError(503, 'overloaded'),
      sse('[]'),
    ]);

    const error = await translateImage(request, deps).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GeminiHttpError);
    expect((error as GeminiHttpError).status).toBe(503);
    expect((error as GeminiHttpError).message).toContain('overloaded');
    expect(fetchFn).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1000, 2000, 4000]);
  });

  it.each([400, 403, 404])('%i 不重試', async (status) => {
    const { deps, fetchFn, sleep } = setup([httpError(status), sse('[]')]);

    await expect(translateImage(request, deps)).rejects.toBeInstanceOf(GeminiHttpError);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('prompt 被擋下時回報錯誤，不重試', async () => {
    const blocked = new Response(`data: ${JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } })}\n\n`);
    const { deps, fetchFn } = setup([blocked, sse('[]')]);

    await expect(translateImage(request, deps)).rejects.toBeInstanceOf(GeminiBlockedError);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
