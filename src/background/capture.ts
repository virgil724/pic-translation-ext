import { RestrictedPageError, UserFacingError } from '../shared/errors';
import type { ImageSize } from '../shared/types';

// Chrome 的上限是每秒 2 次（MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND），留一點餘裕。
export const CAPTURE_MIN_INTERVAL_MS = 600;
const LAST_CAPTURE_KEY = 'lastCaptureAt';

export function computeWaitMs(lastCaptureAt: number | undefined, now: number, minInterval: number): number {
  if (lastCaptureAt === undefined) return 0;
  const elapsed = now - lastCaptureAt;
  // 時鐘被往回調時 elapsed 會是負的，視為不用等。
  if (elapsed < 0) return 0;
  return Math.max(0, minInterval - elapsed);
}

// 同一個 service worker 生命週期內用 promise 鏈排隊；上次擷取的時間戳記存在
// storage.session，service worker 被終止重啟後仍然遵守間隔。
let queue: Promise<unknown> = Promise.resolve();

async function captureNow<T>(windowId: number, prepare: () => Promise<T>): Promise<{ dataUrl: string; prepared: T }> {
  const stored = await chrome.storage.session.get(LAST_CAPTURE_KEY);
  const last: unknown = stored[LAST_CAPTURE_KEY];
  const waitMs = computeWaitMs(typeof last === 'number' ? last : undefined, Date.now(), CAPTURE_MIN_INTERVAL_MS);
  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));

  // 等完節流才請頁面就位，回報的狀態和實際擷取之間就不會隔著等待時間。
  const prepared = await prepare();
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    return { dataUrl, prepared };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new UserFacingError(`無法擷取畫面：${detail}`);
  } finally {
    await chrome.storage.session.set({ [LAST_CAPTURE_KEY]: Date.now() });
  }
}

/**
 * 節流後的 captureVisibleTab，回傳 PNG data URL。
 * prepare 在輪到這次擷取、即將截圖前才執行，它的回傳值就是擷取當下的頁面狀態。
 */
export function captureVisibleTabThrottled<T>(
  windowId: number,
  prepare: () => Promise<T>,
): Promise<{ dataUrl: string; prepared: T }> {
  const result = queue.then(() => captureNow(windowId, prepare));
  queue = result.catch(() => undefined);
  return result;
}

const RESTRICTED_SCHEMES = [
  'chrome:',
  'chrome-extension:',
  'chrome-search:',
  'chrome-untrusted:',
  'devtools:',
  'edge:',
  'about:',
  'view-source:',
];

/** 回傳無法翻譯這個網址的原因；可以翻譯時回傳 undefined。 */
export function restrictedReason(url: string | undefined): string | undefined {
  if (url === undefined || url === '') return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (RESTRICTED_SCHEMES.includes(parsed.protocol)) {
    return `無法翻譯瀏覽器內建頁面（${parsed.protocol}//）。Chrome 不允許擴充功能擷取這類頁面。`;
  }
  const isWebStore =
    parsed.hostname === 'chromewebstore.google.com' ||
    (parsed.hostname === 'chrome.google.com' && parsed.pathname.startsWith('/webstore'));
  if (isWebStore) {
    return '無法翻譯 Chrome 線上應用程式商店。Chrome 不允許擴充功能在商店頁面執行。';
  }
  return undefined;
}

export function assertCapturable(url: string | undefined): void {
  const reason = restrictedReason(url);
  if (reason !== undefined) throw new RestrictedPageError(reason);
}

export interface DecodedDataUrl {
  base64: string;
  bytes: Uint8Array<ArrayBuffer>;
}

export function decodeDataUrl(dataUrl: string): DecodedDataUrl {
  const comma = dataUrl.indexOf(',');
  if (!dataUrl.startsWith('data:') || comma === -1) {
    throw new UserFacingError('擷取到的畫面格式不正確');
  }
  const base64 = dataUrl.slice(comma + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { base64, bytes };
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** 從 PNG 的 IHDR 讀出像素尺寸（寬在位移 16、高在位移 20，各 4 位元組 big-endian）。 */
export function readPngSize(bytes: Uint8Array): ImageSize {
  const isPng = bytes.length >= 24 && PNG_SIGNATURE.every((value, index) => bytes[index] === value);
  if (!isPng) throw new UserFacingError('擷取到的畫面不是 PNG');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}
