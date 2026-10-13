import type { Box2d, CaptureContext, ImageSize, Point, Rect, ViewportSnapshot } from './types';

const NORMALIZED_MAX = 1000;

function clampNormalized(value: number): number {
  return Math.min(NORMALIZED_MAX, Math.max(0, value));
}

/** 0–1000 正規化座標 → 截圖像素。超出範圍的值會被夾回圖內。 */
export function normalizedToImagePx(box: Box2d, image: ImageSize): Rect {
  const [ymin, xmin, ymax, xmax] = box;
  const top = (clampNormalized(Math.min(ymin, ymax)) / NORMALIZED_MAX) * image.height;
  const bottom = (clampNormalized(Math.max(ymin, ymax)) / NORMALIZED_MAX) * image.height;
  const left = (clampNormalized(Math.min(xmin, xmax)) / NORMALIZED_MAX) * image.width;
  const right = (clampNormalized(Math.max(xmin, xmax)) / NORMALIZED_MAX) * image.width;
  return { left, top, width: right - left, height: bottom - top };
}

/** 截圖像素 → CSS px（仍以截圖左上角為原點）。 */
export function imagePxToCssPx(rect: Rect, devicePixelRatio: number): Rect {
  return {
    left: rect.left / devicePixelRatio,
    top: rect.top / devicePixelRatio,
    width: rect.width / devicePixelRatio,
    height: rect.height / devicePixelRatio,
  };
}

function translate(rect: Rect, dx: number, dy: number): Rect {
  return { left: rect.left + dx, top: rect.top + dy, width: rect.width, height: rect.height };
}

/** 視窗內的 CSS px → 文件座標（加上擷取當下的捲動量）。 */
export function cssPxToDocument(rect: Rect, viewport: Pick<ViewportSnapshot, 'scrollX' | 'scrollY'>): Rect {
  return translate(rect, viewport.scrollX, viewport.scrollY);
}

export function box2dToDocumentRect(box: Box2d, capture: CaptureContext): Rect {
  const imagePx = normalizedToImagePx(box, capture.image);
  const cssPx = imagePxToCssPx(imagePx, capture.viewport.devicePixelRatio);
  return cssPxToDocument(cssPx, capture.viewport);
}

/** 0–1000 正規化座標 → 相對於整張圖的比例（0–1）。圖就是某個頁面元素時，用它來定位。 */
export function box2dToRelative(box: Box2d): Rect {
  return normalizedToImagePx(box, { width: 1, height: 1 });
}

/** 兩個矩形的交集；沒有交集時回傳 undefined。 */
export function intersectRect(a: Rect, b: Rect): Rect | undefined {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.left + a.width, b.left + b.width);
  const bottom = Math.min(a.top + a.height, b.top + b.height);
  if (right <= left || bottom <= top) return undefined;
  return { left, top, width: right - left, height: bottom - top };
}

export interface Slice {
  /** 要從這張截圖取出的範圍（整數像素）。 */
  src: Rect;
  /** 貼到拼接畫布上的位置（整數像素，以目標頁左上角為原點）。 */
  dest: Point;
  /** 這一段涵蓋目標頁的高度範圍（CSS px，從頁面頂端算起）。 */
  coveredTop: number;
  coveredBottom: number;
}

/**
 * 分段擷取時，算出一張截圖裡屬於目標頁的部分，以及它在拼接畫布上的位置。
 * pageRect 是目標頁在擷取當下的視窗座標。目標頁完全不在視窗內時回傳 undefined。
 */
export function sliceGeometry(
  pageRect: Rect,
  viewport: Pick<ViewportSnapshot, 'innerWidth' | 'innerHeight' | 'devicePixelRatio'>,
  shot: ImageSize,
): Slice | undefined {
  const visible = intersectRect(pageRect, {
    left: 0,
    top: 0,
    width: viewport.innerWidth,
    height: viewport.innerHeight,
  });
  if (!visible) return undefined;
  const dpr = viewport.devicePixelRatio;
  const clamp = (value: number, max: number) => Math.min(max, Math.max(0, value));
  // 向內取整，避免把頁面邊緣外的半個像素帶進來。
  const x0 = clamp(Math.ceil(visible.left * dpr), shot.width);
  const y0 = clamp(Math.ceil(visible.top * dpr), shot.height);
  const x1 = clamp(Math.floor((visible.left + visible.width) * dpr), shot.width);
  const y1 = clamp(Math.floor((visible.top + visible.height) * dpr), shot.height);
  if (x1 <= x0 || y1 <= y0) return undefined;
  return {
    src: { left: x0, top: y0, width: x1 - x0, height: y1 - y0 },
    dest: {
      x: Math.round(x0 - pageRect.left * dpr),
      y: Math.round(y0 - pageRect.top * dpr),
    },
    coveredTop: visible.top - pageRect.top,
    coveredBottom: visible.top + visible.height - pageRect.top,
  };
}
/**
 * 把矩形的每一邊向外擴張自身寬高的 ratio 倍，並限制在 bounds 內。
 * 模型給的框常常貼得太緊，邊緣會露出原文的筆畫，蓋的時候稍微放大一點。
 */
export function expandRect(rect: Rect, ratio: number, bounds?: Rect): Rect {
  let left = rect.left - rect.width * ratio;
  let top = rect.top - rect.height * ratio;
  let right = rect.left + rect.width * (1 + ratio);
  let bottom = rect.top + rect.height * (1 + ratio);
  if (bounds) {
    left = Math.max(left, bounds.left);
    top = Math.max(top, bounds.top);
    right = Math.min(right, bounds.left + bounds.width);
    bottom = Math.min(bottom, bounds.top + bounds.height);
  }
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

/**
 * object-fit: contain 的圖在元素框裡實際佔的範圍：等比例縮到放得進 box，
 * 剩下的空間依 position（0–1，對應 object-position 的百分比）分配。
 */
export function containRect(box: Rect, natural: ImageSize, position: Point): Rect {
  const scale = Math.min(box.width / natural.width, box.height / natural.height);
  const width = natural.width * scale;
  const height = natural.height * scale;
  return {
    left: box.left + (box.width - width) * position.x,
    top: box.top + (box.height - height) * position.y,
    width,
    height,
  };
}

/**
 * 找出和其他矩形明顯重疊的矩形。重疊面積要超過較小那個矩形的 minRatio 才算，
 * 只是邊緣碰到的不算。回傳和輸入等長的陣列。
 */
export function findOverlapping(rects: readonly Rect[], minRatio: number): boolean[] {
  const overlapping = rects.map(() => false);
  rects.forEach((a, i) => {
    for (let j = i + 1; j < rects.length; j++) {
      const b = rects[j];
      if (!b) continue;
      const shared = intersectRect(a, b);
      if (!shared) continue;
      const smaller = Math.min(a.width * a.height, b.width * b.height);
      if (smaller > 0 && shared.width * shared.height > smaller * minRatio) {
        overlapping[i] = true;
        overlapping[j] = true;
      }
    }
  });
  return overlapping;
}
