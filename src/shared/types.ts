export const TEXT_KINDS = ['dialogue', 'narration', 'sfx', 'other'] as const;
export type TextKind = (typeof TEXT_KINDS)[number];

/** Gemini 的 box_2d：[ymin, xmin, ymax, xmax]，相對整張圖正規化到 0–1000。 */
export type Box2d = readonly [ymin: number, xmin: number, ymax: number, xmax: number];

export interface TranslationItem {
  box_2d: Box2d;
  source: string;
  translation: string;
  kind: TextKind;
  vertical: boolean;
}

/** content script 在擷取當下回報的視窗狀態，之後所有座標換算都以這組值為準。 */
export interface ViewportSnapshot {
  scrollX: number;
  scrollY: number;
  innerWidth: number;
  innerHeight: number;
  devicePixelRatio: number;
}

export interface ImageSize {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** 整個可見範圍的截圖，換算座標時需要的資訊。 */
export interface CaptureContext {
  viewport: ViewportSnapshot;
  /** 截圖的實際像素尺寸。 */
  image: ImageSize;
}

/** content script 對 begin-capture 的回覆：這次要怎麼擷取。 */
export type CapturePlan =
  /** 沒有可辨識的漫畫頁：擷取整個可見範圍一次。 */
  | { mode: 'viewport'; captureId: number }
  /** 針對單一漫畫頁：頁面比視窗高時分段擷取再拼接。size 是該頁在版面上的 CSS px 尺寸。 */
  | { mode: 'page'; captureId: number; size: ImageSize }
  | { mode: 'error'; message: string };

/** 每一段擷取前 content script 回報的狀態。 */
export interface CaptureStep {
  viewport: ViewportSnapshot;
  /** page 模式：目標頁此刻在視窗內的位置（CSS px）；viewport 模式為 null。 */
  pageRect: Rect | null;
}

/** 譯文座標所依據的圖：整個視窗的截圖，或是單一漫畫頁（座標相對於該頁元素）。 */
export type RenderFrame = { kind: 'viewport'; capture: CaptureContext } | { kind: 'page' };

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface OverlayStyle {
  background: string;
  color: string;
  fontFamily: string;
  minFontSize: number;
  maxFontSize: number;
}

/**
 * API key 所屬的服務，兩者的請求格式相同，只差在網址。
 * - gemini-api：AI Studio 發的 key（generativelanguage.googleapis.com）
 * - agent-platform：Agent Platform／Vertex AI 發的 key（aiplatform.googleapis.com）
 */
export const API_PROVIDERS = ['gemini-api', 'agent-platform'] as const;
export type ApiProvider = (typeof API_PROVIDERS)[number];

export interface Settings {
  provider: ApiProvider;
  apiKey: string;
  model: string;
  overlay: OverlayStyle;
}
