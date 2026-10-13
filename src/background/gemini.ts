import { UserFacingError } from '../shared/errors';
import { TEXT_KINDS, type ApiProvider, type TextKind, type TranslationItem } from '../shared/types';
import { RESPONSE_SCHEMA } from './prompt';

/** 各服務的模型路徑前綴，後面接 `<模型名稱>:streamGenerateContent`。 */
const MODEL_BASE: Record<ApiProvider, string> = {
  'gemini-api': 'https://generativelanguage.googleapis.com/v1beta/models',
  'agent-platform': 'https://aiplatform.googleapis.com/v1/publishers/google/models',
};
/** 429／5xx 的重試次數上限（不含第一次請求）。 */
export const MAX_HTTP_RETRIES = 3;
/** 回應無法解析成預期格式時的重試次數。 */
export const MAX_PARSE_RETRIES = 1;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_JITTER_MS = 250;

export class GeminiHttpError extends UserFacingError {
  override name = 'GeminiHttpError';
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class GeminiBlockedError extends UserFacingError {
  override name = 'GeminiBlockedError';
}

export class GeminiParseError extends UserFacingError {
  override name = 'GeminiParseError';
}

export interface GeminiRequest {
  provider: ApiProvider;
  apiKey: string;
  model: string;
  prompt: string;
  /** 不含 data: 前綴的 PNG base64。 */
  imageBase64: string;
}

export interface GeminiDeps {
  fetchFn: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
}

const defaultDeps: GeminiDeps = {
  fetchFn: (input, init) => fetch(input, init),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: Math.random,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTextKind(value: unknown): value is TextKind {
  return typeof value === 'string' && (TEXT_KINDS as readonly string[]).includes(value);
}

function toItem(value: unknown): TranslationItem | undefined {
  if (!isRecord(value)) return undefined;
  const { box_2d: box, source, translation, kind, vertical } = value;
  if (!Array.isArray(box) || box.length !== 4) return undefined;
  const [ymin, xmin, ymax, xmax] = box as unknown[];
  if (
    typeof ymin !== 'number' ||
    typeof xmin !== 'number' ||
    typeof ymax !== 'number' ||
    typeof xmax !== 'number' ||
    ![ymin, xmin, ymax, xmax].every(Number.isFinite)
  ) {
    return undefined;
  }
  if (typeof source !== 'string' || typeof translation !== 'string') return undefined;
  if (!isTextKind(kind) || typeof vertical !== 'boolean') return undefined;
  return { box_2d: [ymin, xmin, ymax, xmax], source, translation, kind, vertical };
}

export type ParseResult = { ok: true; items: TranslationItem[] } | { ok: false; reason: string };

/** 把模型輸出的文字解析成 TranslationItem[]。只接受整段就是合法 JSON 的輸出。 */
export function parseItems(text: string): ParseResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, reason: '不是合法的 JSON' };
  }
  if (!Array.isArray(data)) return { ok: false, reason: '最外層不是陣列' };
  const items: TranslationItem[] = [];
  for (const [index, entry] of (data as unknown[]).entries()) {
    const item = toItem(entry);
    if (!item) return { ok: false, reason: `第 ${index + 1} 筆的欄位不符合格式` };
    items.push(item);
  }
  return { ok: true, items };
}

interface StreamResult {
  text: string;
  blockReason?: string;
  finishReason?: string;
}

/**
 * 解析 streamGenerateContent?alt=sse 的回應本體：每個事件是一行
 * `data: <GenerateContentResponse JSON>`，把各事件的文字片段依序接起來。
 */
export function readSseBody(body: string): StreamResult {
  const result: StreamResult = { text: '' };
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice('data:'.length).trim();
    if (payload === '') continue;
    const event: unknown = JSON.parse(payload);
    if (!isRecord(event)) continue;

    const feedback = event.promptFeedback;
    if (isRecord(feedback) && typeof feedback.blockReason === 'string') {
      result.blockReason = feedback.blockReason;
    }

    const candidates = event.candidates;
    const candidate: unknown = Array.isArray(candidates) ? candidates[0] : undefined;
    if (!isRecord(candidate)) continue;
    if (typeof candidate.finishReason === 'string') result.finishReason = candidate.finishReason;
    const content = candidate.content;
    const parts: unknown = isRecord(content) ? content.parts : undefined;
    if (!Array.isArray(parts)) continue;
    for (const part of parts as unknown[]) {
      // thought: true 的片段是思考摘要，不是答案。
      if (isRecord(part) && typeof part.text === 'string' && part.thought !== true) {
        result.text += part.text;
      }
    }
  }
  return result;
}

function buildRequestInit(request: GeminiRequest): RequestInit {
  return {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': request.apiKey,
    },
    body: JSON.stringify({
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType: 'image/png', data: request.imageBase64 } },
            { text: request.prompt },
          ],
        },
      ],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: RESPONSE_SCHEMA,
        temperature: 0.2,
      },
    }),
  };
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

async function readApiErrorMessage(response: Response): Promise<string> {
  const body = await response.text().catch(() => '');
  try {
    const parsed: unknown = JSON.parse(body);
    const root: unknown = Array.isArray(parsed) ? parsed[0] : parsed;
    if (isRecord(root) && isRecord(root.error) && typeof root.error.message === 'string') {
      return root.error.message;
    }
  } catch {
    // 錯誤本體不是 JSON 時，只回報狀態碼。
  }
  return '';
}

function describeHttpError(status: number, model: string, apiMessage: string): string {
  const detail = apiMessage ? `（${apiMessage}）` : '';
  if (status === 429) return `Gemini 請求過於頻繁或配額已用完，重試後仍失敗${detail}`;
  if (status >= 500) return `Gemini 服務暫時異常（HTTP ${status}），重試後仍失敗${detail}`;
  if (status === 402) return `Gemini 專案的額度已用完，請到 AI Studio 檢查帳單設定${detail}`;
  if (status === 401 || status === 403) {
    return `Gemini API key 無效或沒有權限。請到設定頁檢查 key，以及「API 服務」是否選對（AI Studio 和 Agent Platform 的 key 不能互用）${detail}`;
  }
  if (status === 404) return `找不到模型「${model}」，請到設定頁檢查模型名稱${detail}`;
  return `Gemini 拒絕了請求（HTTP ${status}）${detail}`;
}

/** 送出一次請求；遇到 429／5xx 以指數退避重試。 */
async function requestOnce(request: GeminiRequest, deps: GeminiDeps): Promise<StreamResult> {
  const url = `${MODEL_BASE[request.provider]}/${encodeURIComponent(request.model)}:streamGenerateContent?alt=sse`;
  const init = buildRequestInit(request);

  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await deps.fetchFn(url, init);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new UserFacingError(`無法連線到 Gemini：${detail}`);
    }

    if (response.ok) {
      return readSseBody(await response.text());
    }
    if (isRetryableStatus(response.status) && attempt < MAX_HTTP_RETRIES) {
      await deps.sleep(BACKOFF_BASE_MS * 2 ** attempt + deps.random() * BACKOFF_JITTER_MS);
      continue;
    }
    const apiMessage = await readApiErrorMessage(response);
    throw new GeminiHttpError(response.status, describeHttpError(response.status, request.model, apiMessage));
  }
}

export async function translateImage(
  request: GeminiRequest,
  deps: GeminiDeps = defaultDeps,
): Promise<TranslationItem[]> {
  let lastReason = '';
  for (let attempt = 0; attempt <= MAX_PARSE_RETRIES; attempt++) {
    let stream: StreamResult;
    try {
      stream = await requestOnce(request, deps);
    } catch (error) {
      // 串流事件本身壞掉也算解析失敗，走同一條重試路徑。
      if (!(error instanceof SyntaxError)) throw error;
      lastReason = '回應串流格式錯誤';
      continue;
    }

    if (stream.blockReason !== undefined) {
      throw new GeminiBlockedError(`Gemini 拒絕處理這張畫面（${stream.blockReason}）`);
    }
    if (stream.text === '' && stream.finishReason !== undefined && stream.finishReason !== 'STOP') {
      throw new GeminiBlockedError(`Gemini 沒有回傳內容（${stream.finishReason}）`);
    }

    const parsed = parseItems(stream.text);
    if (parsed.ok) return parsed.items;
    lastReason =
      stream.finishReason === 'MAX_TOKENS' ? `${parsed.reason}，輸出因長度上限被截斷` : parsed.reason;
  }
  throw new GeminiParseError(`Gemini 回傳的結果無法解析（${lastReason}），已重試 ${MAX_PARSE_RETRIES} 次`);
}
