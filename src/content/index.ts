import { intersectRect } from '../shared/coords';
import {
  isContentRequest,
  type ContentRequestType,
  type ContentResponse,
  type TranslatePageRequest,
} from '../shared/messages';
import type {
  CapturePlan,
  CaptureStep,
  OverlayStyle,
  Rect,
  TranslationItem,
  ViewportSnapshot,
} from '../shared/types';
import { nextPaint, Overlay } from './overlay';
import { findAdapter, getPageKeys, getPageRect, isPageReady } from './sites';

/** 捲動後等網站自己的捲動處理（例如頂端列滑出）跑完，再找擋住頁面的元素。 */
const SCROLL_SETTLE_MS = 120;

interface SavedVisibility {
  value: string;
  priority: string;
}

interface CaptureSession {
  /** 目標頁；null 表示擷取整個視窗。 */
  page: HTMLElement | null;
  /** 擷取前目標頁頂端在視窗內的位置，結束後捲回原處用。 */
  initialTop: number;
  /** 被暫時隱藏的頁面元素，以及它們原本的 inline visibility。 */
  hidden: Map<HTMLElement, SavedVisibility>;
}

const adapter = findAdapter(window.location);
const sessions = new Map<number, CaptureSession>();
const pageIds = new Map<number, HTMLElement>();
const idsByPage = new WeakMap<HTMLElement, number>();
let nextCaptureId = 1;
let nextPageId = 1;

const overlay = new Overlay({
  onPageButton: requestPageTranslation,
  getPageRect,
  followMotion: adapter?.followMotion ?? false,
});

function snapshotViewport(): ViewportSnapshot {
  return {
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
  };
}

function toRect(rect: DOMRect): Rect {
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

function viewportRect(): Rect {
  return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ───── 頁面清單 ─────

function findPages(): HTMLElement[] {
  if (!adapter) return [];
  return [...document.querySelectorAll<HTMLElement>(adapter.pageSelector)];
}

function pageIdOf(page: HTMLElement): number {
  let id = idsByPage.get(page);
  if (id === undefined) {
    id = nextPageId++;
    idsByPage.set(page, id);
    pageIds.set(id, page);
  }
  return id;
}

function syncPages(): void {
  const pages = findPages();
  overlay.syncPages(pages);
  const alive = new Set(pages);
  for (const [id, page] of pageIds) {
    if (!alive.has(page)) pageIds.delete(id);
  }
  restoreTranslations(pages);
}

interface SavedTranslation {
  items: TranslationItem[];
  style: OverlayStyle;
}

/**
 * 翻過的頁面的結果，以頁面的識別字串為鍵。閱讀器會把離目前位置較遠的頁面元素回收，
 * 翻回來時是新的元素；靠這份紀錄把譯文畫回去，不用重新翻譯。重新整理頁面後就沒了。
 */
const savedTranslations = new Map<string, SavedTranslation>();

function pageKeyOf(page: HTMLElement): string | undefined {
  return adapter ? getPageKeys([page], adapter).get(page) : undefined;
}

/** 把之前翻過、但元素被重建而失去譯文的頁面畫回來。 */
function restoreTranslations(pages: readonly HTMLElement[]): void {
  if (!adapter || savedTranslations.size === 0) return;
  for (const [page, key] of getPageKeys(pages, adapter)) {
    const saved = savedTranslations.get(key);
    if (!saved || overlay.isTranslated(page) || overlay.isBusy(page) || !isPageReady(page)) continue;
    overlay.renderPage(page, saved.items, saved.style);
  }
}

/** 一頁至少露出這個比例，或佔掉視窗這個比例，才算「正在看」。 */
const VISIBLE_THRESHOLD = 0.5;

/**
 * 目前正在看、而且已載入的頁面，依閱讀順序排列（日本漫畫：由右到左、由上到下）。
 * 跨頁閱讀器會有兩頁；直向捲動的網站通常只有一頁。
 * 沒有任何一頁達到門檻時，退而求其次回傳露出面積最大的那一頁。
 */
function visiblePages(): HTMLElement[] {
  const viewport = viewportRect();
  const viewportArea = viewport.width * viewport.height;
  const candidates: { page: HTMLElement; rect: Rect; area: number }[] = [];
  for (const page of findPages()) {
    if (!isPageReady(page)) continue;
    const rect = getPageRect(page);
    const visible = intersectRect(rect, viewport);
    if (!visible) continue;
    candidates.push({ page, rect, area: visible.width * visible.height });
  }
  const watching = candidates.filter(
    ({ rect, area }) =>
      area >= rect.width * rect.height * VISIBLE_THRESHOLD || area >= viewportArea * VISIBLE_THRESHOLD,
  );
  if (watching.length === 0) {
    const [largest] = candidates.sort((a, b) => b.area - a.area);
    return largest ? [largest.page] : [];
  }
  return watching.sort((a, b) => a.rect.top - b.rect.top || b.rect.left - a.rect.left).map(({ page }) => page);
}

/** 工具列按鈕要翻譯的頁面：還沒翻過的優先；都翻過了就全部重翻。 */
function listPagesToTranslate(): { pageIds: number[]; pending: boolean } {
  if (!adapter) return { pageIds: [], pending: false };
  syncPages();
  const visible = visiblePages();
  // 已經在翻譯的頁面不要重複送出。
  const idle = visible.filter((page) => !overlay.isBusy(page));
  const fresh = idle.filter((page) => !overlay.isTranslated(page));
  return { pageIds: (fresh.length > 0 ? fresh : idle).map(pageIdOf), pending: idle.length < visible.length };
}

function requestPageTranslation(page: HTMLElement): void {
  if (!isPageReady(page)) {
    overlay.showStatus('這一頁還沒載入完成。', 'info', false);
    return;
  }
  const request: TranslatePageRequest = { type: 'pt/translate-page', pageId: pageIdOf(page) };
  chrome.runtime.sendMessage(request).catch(() => {
    // 擴充功能被重新載入或更新後，這份 content script 已經連不上背景程式。
    overlay.showStatus('無法連線到擴充功能，請重新整理頁面後再按一次工具列按鈕。', 'error', false);
  });
}

// ───── 擷取 ─────

function beginCapture(requestedPageId: number | null): CapturePlan {
  let page: HTMLElement | null = null;
  if (requestedPageId !== null) {
    page = pageIds.get(requestedPageId) ?? null;
    if (!page?.isConnected) return { mode: 'error', message: '找不到這一頁，頁面內容可能已經更新。' };
  } else if (adapter) {
    syncPages();
    page = visiblePages()[0] ?? null;
    if (!page) return { mode: 'error', message: '畫面上沒有已載入的漫畫頁，請捲到要翻譯的那一頁再試。' };
  }
  if (page && !isPageReady(page)) return { mode: 'error', message: '這一頁還沒載入完成。' };

  const captureId = nextCaptureId++;
  const rect = page ? getPageRect(page) : undefined;
  if (page && rect && (rect.width <= 0 || rect.height <= 0)) {
    return { mode: 'error', message: '這一頁目前沒有顯示在頁面上。' };
  }
  sessions.set(captureId, { page, initialTop: rect?.top ?? 0, hidden: new Map() });
  if (page && rect) {
    overlay.setPageBusy(page, true);
    return { mode: 'page', captureId, size: { width: rect.width, height: rect.height } };
  }
  return { mode: 'viewport', captureId };
}

/** 暫時隱藏擋在目標頁上的固定／黏著元素（網站的頂端列、浮動按鈕、浮動廣告）。 */
function hideBlockers(session: CaptureSession, page: HTMLElement): void {
  const target = intersectRect(getPageRect(page), viewportRect());
  if (!target) return;
  for (const element of document.documentElement.querySelectorAll<HTMLElement>('*')) {
    if (session.hidden.has(element) || element.contains(page)) continue;
    const computed = getComputedStyle(element);
    if (computed.position !== 'fixed' && computed.position !== 'sticky') continue;
    if (computed.display === 'none' || computed.visibility === 'hidden') continue;
    if (!intersectRect(toRect(element.getBoundingClientRect()), target)) continue;
    session.hidden.set(element, {
      value: element.style.getPropertyValue('visibility'),
      priority: element.style.getPropertyPriority('visibility'),
    });
    element.style.setProperty('visibility', 'hidden', 'important');
  }
}

async function captureStep(captureId: number, offsetY: number): Promise<CaptureStep> {
  const session = sessions.get(captureId);
  await overlay.hideForCapture();
  const page = session?.page;
  if (!session || !page) {
    return { viewport: snapshotViewport(), pageRect: null };
  }

  const documentTop = getPageRect(page).top + window.scrollY;
  window.scrollTo({ top: documentTop + offsetY, left: window.scrollX, behavior: 'instant' });
  await sleep(SCROLL_SETTLE_MS);
  hideBlockers(session, page);
  await nextPaint();
  // 捲動可能觸發延遲載入讓版面位移，所以位置要在重繪後、回覆前才量。
  return { viewport: snapshotViewport(), pageRect: getPageRect(page) };
}

function endCapture(captureId: number): void {
  const session = sessions.get(captureId);
  if (session) {
    for (const [element, saved] of session.hidden) {
      if (saved.value === '') element.style.removeProperty('visibility');
      else element.style.setProperty('visibility', saved.value, saved.priority);
    }
    session.hidden.clear();
    if (session.page?.isConnected) {
      // 捲回去時以目標頁為準，而不是原本的 scrollY：途中版面可能已經位移。
      const drift = getPageRect(session.page).top - session.initialTop;
      window.scrollBy({ top: drift, left: 0, behavior: 'instant' });
    }
  }
  overlay.restoreAfterCapture();
}

function finish(captureId: number): void {
  const session = sessions.get(captureId);
  if (session?.page) overlay.setPageBusy(session.page, false);
  sessions.delete(captureId);
}

// ───── 視窗變化 ─────

/**
 * 視窗大小或縮放改變後，用文件座標定位的譯文已經對不準原文，直接清掉。
 * 掛在頁面元素上的譯文會跟著頁面縮放，不受影響。
 */
function onViewportChanged(): void {
  overlay.layout();
  if (!overlay.hasLooseBoxes) return;
  overlay.clearLoose();
  overlay.showStatus('視窗大小或縮放已改變，譯文已清除，請重新翻譯。', 'info', false);
}

/** devicePixelRatio 改變（縮放、視窗移到另一個螢幕）不一定會觸發 resize，另外監聽。 */
function watchDevicePixelRatio(): void {
  const query = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
  query.addEventListener(
    'change',
    () => {
      onViewportChanged();
      watchDevicePixelRatio();
    },
    { once: true },
  );
}

window.addEventListener('resize', onViewportChanged);
watchDevicePixelRatio();

if (adapter) {
  syncPages();
  let scanScheduled = false;
  new MutationObserver(() => {
    if (scanScheduled) return;
    scanScheduled = true;
    requestAnimationFrame(() => {
      scanScheduled = false;
      syncPages();
    });
  }).observe(document.body, { childList: true, subtree: true });
}

// ───── 訊息 ─────

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !isContentRequest(message)) return false;

  const reply = <T extends ContentRequestType>(_type: T, response: ContentResponse<T>): void => {
    sendResponse(response);
  };

  switch (message.type) {
    case 'pt/ping':
      reply(message.type, { ok: true });
      return false;

    case 'pt/list-pages':
      reply(message.type, listPagesToTranslate());
      return false;

    case 'pt/begin-capture':
      reply(message.type, beginCapture(message.pageId));
      return false;

    case 'pt/capture-step':
      void captureStep(message.captureId, message.offsetY).then((step) => {
        reply(message.type, step);
      });
      return true;

    case 'pt/end-capture':
      endCapture(message.captureId);
      reply(message.type, { ok: true });
      return false;

    case 'pt/render': {
      const session = sessions.get(message.captureId);
      if (message.frame.kind === 'page') {
        const drawn = session?.page ? overlay.renderPage(session.page, message.items, message.style) : undefined;
        const key = drawn !== undefined && session?.page ? pageKeyOf(session.page) : undefined;
        if (key !== undefined) savedTranslations.set(key, { items: message.items, style: message.style });
        reply(message.type, drawn === undefined ? { drawn: 0, stale: true } : { drawn, stale: false });
        return false;
      }
      // 等 Gemini 回應的期間視窗被縮放過的話，這批座標已經對不上了。
      const now = snapshotViewport();
      const then = message.frame.capture.viewport;
      const stale =
        now.innerWidth !== then.innerWidth ||
        now.innerHeight !== then.innerHeight ||
        now.devicePixelRatio !== then.devicePixelRatio;
      if (stale) {
        overlay.clearLoose();
        reply(message.type, { drawn: 0, stale: true });
      } else {
        const drawn = overlay.renderViewport(message.items, message.frame.capture, message.style);
        reply(message.type, { drawn, stale: false });
      }
      return false;
    }

    case 'pt/finish':
      finish(message.captureId);
      reply(message.type, { ok: true });
      return false;

    case 'pt/toggle-overlay': {
      const visible = overlay.toggle();
      if (overlay.hasBoxes) overlay.showStatus(visible ? '已顯示譯文' : '已隱藏譯文', 'info', false);
      reply(message.type, { visible });
      return false;
    }

    case 'pt/clear-overlay':
      savedTranslations.clear();
      overlay.clear();
      overlay.showStatus('已清除譯文', 'info', false);
      reply(message.type, { ok: true });
      return false;

    case 'pt/show-status':
      overlay.showStatus(message.text, message.level, message.sticky);
      reply(message.type, { ok: true });
      return false;
  }
});
