import type { CapturePlan, CaptureStep, OverlayStyle, RenderFrame, TranslationItem } from './types';

// ───── service worker → content script ─────
// content script 以 sendResponse 回覆，碰不到 API key。

/** 確認 content script 是否已注入。 */
export interface PingRequest {
  type: 'pt/ping';
}

/**
 * 工具列按鈕按下時，問頁面上有哪些漫畫頁要翻譯（目前正在看的頁面，依閱讀順序）。
 * pageIds 是空的而且 pending 為 false，表示這個網站沒有可辨識的漫畫頁，改成擷取整個視窗。
 */
export interface ListPagesRequest {
  type: 'pt/list-pages';
}

/**
 * 開始一次擷取：隱藏疊加層，決定要擷取哪一頁。
 * pageId 為 null 時由 content script 挑目前最主要的一頁；頁面上沒有可辨識的漫畫頁就擷取整個視窗。
 */
export interface BeginCaptureRequest {
  type: 'pt/begin-capture';
  pageId: number | null;
}

/**
 * 準備下一段擷取。page 模式會把目標頁的 offsetY（CSS px）捲到視窗頂端，
 * 並暫時隱藏擋在該頁上的固定元素。回覆時畫面已重繪完成，回報的就是擷取當下的狀態。
 */
export interface CaptureStepRequest {
  type: 'pt/capture-step';
  captureId: number;
  offsetY: number;
}

/** 擷取結束（不論成敗）：恢復捲動位置、疊加層和被暫時隱藏的頁面元素。 */
export interface EndCaptureRequest {
  type: 'pt/end-capture';
  captureId: number;
}

/** 畫出翻譯結果。page 模式只取代該頁的譯文。 */
export interface RenderRequest {
  type: 'pt/render';
  captureId: number;
  items: TranslationItem[];
  frame: RenderFrame;
  style: OverlayStyle;
}

/** 整個翻譯流程結束（不論成敗），讓 content script 解除該頁的「翻譯中」狀態。 */
export interface FinishRequest {
  type: 'pt/finish';
  captureId: number;
}

export interface ToggleOverlayRequest {
  type: 'pt/toggle-overlay';
}

export interface ClearOverlayRequest {
  type: 'pt/clear-overlay';
}

export type StatusLevel = 'info' | 'error';

/** 在頁面角落顯示狀態訊息。sticky 的訊息會留到下一則訊息取代它。 */
export interface ShowStatusRequest {
  type: 'pt/show-status';
  text: string;
  level: StatusLevel;
  sticky: boolean;
}

export type ContentRequest =
  | PingRequest
  | ListPagesRequest
  | BeginCaptureRequest
  | CaptureStepRequest
  | EndCaptureRequest
  | RenderRequest
  | FinishRequest
  | ToggleOverlayRequest
  | ClearOverlayRequest
  | ShowStatusRequest;

export type ContentRequestType = ContentRequest['type'];

export interface Ack {
  ok: true;
}

export interface ContentResponseMap {
  'pt/ping': Ack;
  /** pending：畫面上有頁面正在翻譯中（這些頁面不會列在 pageIds 裡）。 */
  'pt/list-pages': { pageIds: number[]; pending: boolean };
  'pt/begin-capture': CapturePlan;
  'pt/capture-step': CaptureStep;
  'pt/end-capture': Ack;
  /** stale：等待期間視窗大小或縮放變了（或該頁已不在頁面上），結果沒有畫出來。 */
  'pt/render': { drawn: number; stale: boolean };
  'pt/finish': Ack;
  'pt/toggle-overlay': { visible: boolean };
  'pt/clear-overlay': Ack;
  'pt/show-status': Ack;
}

export type ContentResponse<T extends ContentRequestType> = ContentResponseMap[T];

const CONTENT_REQUEST_TYPES: ReadonlySet<string> = new Set<ContentRequestType>([
  'pt/ping',
  'pt/list-pages',
  'pt/begin-capture',
  'pt/capture-step',
  'pt/end-capture',
  'pt/render',
  'pt/finish',
  'pt/toggle-overlay',
  'pt/clear-overlay',
  'pt/show-status',
]);

function hasType(value: unknown): value is { type: unknown } {
  return typeof value === 'object' && value !== null && 'type' in value;
}

/** 只檢查 type；訊息來源由呼叫端另外確認是本擴充功能。 */
export function isContentRequest(value: unknown): value is ContentRequest {
  return hasType(value) && typeof value.type === 'string' && CONTENT_REQUEST_TYPES.has(value.type);
}

// ───── content script → service worker ─────

/** 使用者按了某一頁右上角的翻譯按鈕。 */
export interface TranslatePageRequest {
  type: 'pt/translate-page';
  pageId: number;
}

export type BackgroundRequest = TranslatePageRequest;

export function isBackgroundRequest(value: unknown): value is BackgroundRequest {
  return (
    hasType(value) &&
    value.type === 'pt/translate-page' &&
    'pageId' in value &&
    typeof value.pageId === 'number'
  );
}
