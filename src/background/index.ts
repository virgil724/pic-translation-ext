import { RestrictedPageError, toUserMessage, UserFacingError } from '../shared/errors';
import { sliceGeometry } from '../shared/coords';
import { isBackgroundRequest, type ContentRequest, type ContentResponse, type StatusLevel } from '../shared/messages';
import { loadSettings } from '../shared/settings';
import type { ImageSize, RenderFrame, Settings, TranslationItem } from '../shared/types';
import { buildCacheKey, Cache, PassthroughBackend } from './cache';
import { assertCapturable, captureVisibleTabThrottled, decodeDataUrl, readPngSize } from './capture';
import { translateImage } from './gemini';
import { PROMPT, PROMPT_VERSION, TARGET_LANG } from './prompt';
import { bytesToBase64, PageStitcher } from './stitch';

// 換 cache 後端時只改這一行。
const cache = new Cache<TranslationItem[]>(new PassthroughBackend());

// 正在擷取畫面的分頁。這是進行中操作的鎖，service worker 被終止時操作也跟著中斷，
// 所以不需要（也不應該）持久化。
const capturingTabs = new Set<number>();

const KEEP_ALIVE_INTERVAL_MS = 20_000;
const DEFAULT_TITLE = '翻譯目前畫面';
/** 單一頁最多分幾段擷取；每段受 captureVisibleTab 節流限制，太多段會等很久。 */
const MAX_PAGE_SLICES = 8;
/** 相鄰兩段重疊的高度（CSS px），避免接縫處因為取整少掉一條。 */
const SLICE_OVERLAP_PX = 8;

// API key 存在 storage.local；預設 content script 也讀得到，這裡把它關掉。
void chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });

function sendToTab<R extends ContentRequest>(tabId: number, request: R): Promise<ContentResponse<R['type']>> {
  return chrome.tabs.sendMessage<R, ContentResponse<R['type']>>(tabId, request, { frameId: 0 });
}

async function ensureContentScript(tabId: number): Promise<void> {
  try {
    await sendToTab(tabId, { type: 'pt/ping' });
    return;
  } catch {
    // 還沒注入（或擴充功能重新載入後舊的 content script 已失效）。
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new RestrictedPageError(`無法在這個頁面執行翻譯：${detail}`);
  }
}

function showStatus(tabId: number, text: string, level: StatusLevel, sticky = false): Promise<unknown> {
  return sendToTab(tabId, { type: 'pt/show-status', text, level, sticky });
}

async function setActionError(tabId: number, message: string): Promise<void> {
  await chrome.action.setBadgeBackgroundColor({ tabId, color: '#d93025' });
  await chrome.action.setBadgeText({ tabId, text: '!' });
  await chrome.action.setTitle({ tabId, title: message });
}

async function clearActionError(tabId: number): Promise<void> {
  await chrome.action.setBadgeText({ tabId, text: '' });
  await chrome.action.setTitle({ tabId, title: DEFAULT_TITLE });
  await chrome.action.setPopup({ tabId, popup: '' });
}

/** 無法注入的頁面沒辦法在頁面內顯示訊息，改用工具列按鈕的徽章和彈出視窗。 */
async function reportRestricted(tabId: number, message: string): Promise<void> {
  await setActionError(tabId, message);
  // 設了 popup 之後，這個分頁再按按鈕會直接打開說明；分頁換頁時在 onUpdated 清掉。
  await chrome.action.setPopup({ tabId, popup: `popup.html#${encodeURIComponent(message)}` });
  try {
    await chrome.action.openPopup();
  } catch {
    // 視窗不在前景等情況下打不開，徽章和滑鼠提示仍然會顯示。
  }
}

async function reportError(tabId: number, error: unknown): Promise<void> {
  const message = toUserMessage(error);
  if (!(error instanceof UserFacingError)) console.error(error);
  try {
    if (error instanceof RestrictedPageError) {
      await reportRestricted(tabId, message);
      return;
    }
    try {
      await showStatus(tabId, message, 'error');
    } catch {
      // 分頁在翻譯途中換頁或關閉，content script 已不在。
      await setActionError(tabId, message);
    }
  } catch {
    // 分頁已經關閉，沒有地方可以顯示了。
  }
}

/** 長時間等待 Gemini 時定期呼叫擴充功能 API，避免 service worker 因閒置被終止。 */
async function withKeepAlive<T>(task: Promise<T>): Promise<T> {
  const timer = setInterval(() => {
    void chrome.runtime.getPlatformInfo();
  }, KEEP_ALIVE_INTERVAL_MS);
  try {
    return await task;
  } finally {
    clearInterval(timer);
  }
}

interface Shot {
  bytes: Uint8Array<ArrayBuffer>;
  base64: string;
  frame: RenderFrame;
}

/** 擷取整個可見範圍一次。 */
async function captureViewport(tabId: number, windowId: number, captureId: number): Promise<Shot> {
  // prepared 是擷取當下的視窗狀態，一路帶到 render，不在請求回來後重新讀取。
  const { dataUrl, prepared } = await captureVisibleTabThrottled(windowId, () =>
    sendToTab(tabId, { type: 'pt/capture-step', captureId, offsetY: 0 }),
  );
  const { base64, bytes } = decodeDataUrl(dataUrl);
  return {
    bytes,
    base64,
    frame: { kind: 'viewport', capture: { viewport: prepared.viewport, image: readPngSize(bytes) } },
  };
}

/** 擷取單一漫畫頁：頁面比視窗高時一段一段捲動擷取，再拼成完整的一頁。 */
async function capturePage(tabId: number, windowId: number, captureId: number, size: ImageSize): Promise<Shot> {
  let stitcher: PageStitcher | undefined;
  let offsetY = 0;
  let coveredBottom = 0;
  for (let count = 0; ; count++) {
    if (count >= MAX_PAGE_SLICES) {
      throw new UserFacingError('這一頁太長，無法整頁擷取。請放大視窗或縮小頁面後再試。');
    }
    const requestOffset = offsetY;
    const { dataUrl, prepared } = await captureVisibleTabThrottled(windowId, () =>
      sendToTab(tabId, { type: 'pt/capture-step', captureId, offsetY: requestOffset }),
    );
    const { viewport, pageRect } = prepared;
    if (!pageRect) throw new UserFacingError('找不到要擷取的頁面。');
    const { bytes } = decodeDataUrl(dataUrl);
    const slice = sliceGeometry(pageRect, viewport, readPngSize(bytes));
    if (!slice) throw new UserFacingError('要翻譯的頁面不在畫面上，無法擷取。');

    // 頁面在捲動後又被移動過（延遲載入、網站自己的捲動），和上一段之間會留下空白：重擷取這一段。
    if (slice.coveredTop > coveredBottom + 1) continue;

    // 以擷取當下量到的尺寸為準；第一段決定畫布大小。
    stitcher ??= new PageStitcher({
      width: pageRect.width * viewport.devicePixelRatio,
      height: pageRect.height * viewport.devicePixelRatio,
    });
    await stitcher.addSlice(bytes, slice);

    coveredBottom = Math.max(coveredBottom, slice.coveredBottom);
    if (coveredBottom >= Math.min(size.height, pageRect.height) - 1) break;
    const next = coveredBottom - SLICE_OVERLAP_PX;
    // 捲不動了（已到文件底部）卻還沒涵蓋到頁尾，不會再有進展。
    if (next <= offsetY) break;
    offsetY = next;
  }
  const bytes = await stitcher.toPng();
  return { bytes, base64: bytesToBase64(bytes), frame: { kind: 'page' } };
}

interface Captured {
  captureId: number;
  shot: Shot;
}

/** 擷取一頁（或整個視窗）。成功後呼叫端要負責送 pt/finish。 */
async function captureOne(tab: chrome.tabs.Tab, tabId: number, pageId: number | null): Promise<Captured> {
  const plan = await sendToTab(tabId, { type: 'pt/begin-capture', pageId });
  if (plan.mode === 'error') throw new UserFacingError(plan.message);
  const { captureId } = plan;
  try {
    const shot =
      plan.mode === 'page'
        ? await capturePage(tabId, tab.windowId, captureId, plan.size)
        : await captureViewport(tabId, tab.windowId, captureId);
    return { captureId, shot };
  } catch (error) {
    await sendToTab(tabId, { type: 'pt/finish', captureId }).catch(() => undefined);
    throw error;
  } finally {
    await sendToTab(tabId, { type: 'pt/end-capture', captureId }).catch(() => undefined);
  }
}

/** 把一張擷取好的圖送去翻譯並畫回頁面，回傳畫出的段數。 */
async function translateOne(tabId: number, settings: Settings, { captureId, shot }: Captured): Promise<number> {
  try {
    const key = await buildCacheKey({
      imageBytes: shot.bytes,
      targetLang: TARGET_LANG,
      model: settings.model,
      promptVersion: PROMPT_VERSION,
    });
    const items = await cache.getOrFetch(key, () =>
      translateImage({
        provider: settings.provider,
        apiKey: settings.apiKey,
        model: settings.model,
        prompt: PROMPT,
        imageBase64: shot.base64,
      }),
    );
    const { drawn, stale } = await sendToTab(tabId, {
      type: 'pt/render',
      captureId,
      items,
      frame: shot.frame,
      style: settings.overlay,
    });
    if (stale) throw new UserFacingError('翻譯期間頁面或視窗改變了，請重新翻譯。');
    return drawn;
  } finally {
    await sendToTab(tabId, { type: 'pt/finish', captureId }).catch(() => undefined);
  }
}

interface Batch {
  settings: Settings;
  captured: Captured[];
}

/**
 * 擷取階段。pageId 有值：頁面按鈕指定的那一頁。
 * pageId 為 null（工具列按鈕、快捷鍵）：目前正在看的每一頁；網站沒有可辨識的漫畫頁時擷取整個視窗。
 * 沒有東西要翻譯時回傳 undefined。
 */
async function captureBatch(tab: chrome.tabs.Tab, tabId: number, pageId: number | null): Promise<Batch | undefined> {
  await clearActionError(tabId);
  assertCapturable(tab.url);
  await ensureContentScript(tabId);

  const settings = await loadSettings();
  if (settings.apiKey === '') {
    void chrome.runtime.openOptionsPage();
    throw new UserFacingError('尚未設定 Gemini API key，請在設定頁填入。');
  }

  let targets: (number | null)[] = [pageId];
  if (pageId === null) {
    const { pageIds, pending } = await sendToTab(tabId, { type: 'pt/list-pages' });
    if (pageIds.length > 0) {
      targets = pageIds;
    } else if (pending) {
      await showStatus(tabId, '畫面上的頁面已經在翻譯中。', 'info');
      return undefined;
    }
  }

  const captured: Captured[] = [];
  try {
    for (const target of targets) captured.push(await captureOne(tab, tabId, target));
  } catch (error) {
    for (const { captureId } of captured) {
      await sendToTab(tabId, { type: 'pt/finish', captureId }).catch(() => undefined);
    }
    throw error;
  }
  return { settings, captured };
}

/** 翻譯階段：各頁同時送出，等 Gemini 的期間不占用畫面。 */
async function translateBatch(tabId: number, { settings, captured }: Batch): Promise<void> {
  await showStatus(tabId, captured.length > 1 ? `翻譯中…（${captured.length} 頁）` : '翻譯中…', 'info', true);
  const results = await Promise.allSettled(captured.map((one) => translateOne(tabId, settings, one)));
  let drawn = 0;
  let failure: PromiseRejectedResult | undefined;
  for (const result of results) {
    if (result.status === 'fulfilled') drawn += result.value;
    else failure ??= result;
  }
  // 部分頁面成功時譯文已經畫上去了，仍然把第一個錯誤報出來。
  if (failure) throw failure.reason;
  await showStatus(tabId, drawn > 0 ? `已翻譯 ${drawn} 段文字` : '沒有可翻譯的文字', 'info');
}

async function translateTab(tab: chrome.tabs.Tab, tabId: number, pageId: number | null): Promise<void> {
  if (capturingTabs.has(tabId)) {
    await showStatus(tabId, '正在擷取畫面，請稍候再按。', 'info').catch(() => undefined);
    return;
  }
  // 只有擷取需要獨占畫面（要隱藏疊加層、可能要捲動）。擷取完就放開，
  // 等 Gemini 回應的期間使用者可以繼續翻頁，也可以開始翻譯下一頁。
  let batch: Batch | undefined;
  capturingTabs.add(tabId);
  try {
    batch = await captureBatch(tab, tabId, pageId);
  } finally {
    capturingTabs.delete(tabId);
  }
  if (batch) await translateBatch(tabId, batch);
}

async function runTranslate(tab: chrome.tabs.Tab, pageId: number | null = null): Promise<void> {
  const tabId = tab.id;
  if (tabId === undefined) return;
  try {
    await withKeepAlive(translateTab(tab, tabId, pageId));
  } catch (error) {
    await reportError(tabId, error);
  }
}

// 頁面上的翻譯按鈕。按鈕只會在使用者按過工具列按鈕之後出現，
// 這時 activeTab 權限還在（到分頁換網站為止），所以可以直接擷取。
chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !sender.tab || !isBackgroundRequest(message)) return false;
  void runTranslate(sender.tab, message.pageId);
  sendResponse({ ok: true });
  return false;
});

// 工具列按鈕與快捷鍵（_execute_action）都會觸發這裡，並取得 activeTab 權限。
chrome.action.onClicked.addListener((tab) => {
  void runTranslate(tab);
});

chrome.commands.onCommand.addListener((command, tab) => {
  const tabId = tab?.id;
  if (tabId === undefined) return;
  const request: ContentRequest | undefined =
    command === 'toggle-overlay'
      ? { type: 'pt/toggle-overlay' }
      : command === 'clear-overlay'
        ? { type: 'pt/clear-overlay' }
        : undefined;
  if (!request) return;
  // 這個分頁還沒翻譯過就沒有 content script，也就沒有東西可切換。
  sendToTab(tabId, request).catch(() => undefined);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    clearActionError(tabId).catch(() => undefined);
  }
});
