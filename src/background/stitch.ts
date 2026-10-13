import { UserFacingError } from '../shared/errors';
import type { Slice } from '../shared/coords';
import type { ImageSize } from '../shared/types';

/** 送給 Gemini 的圖片長邊上限。座標是正規化的，縮小不影響定位。 */
const MAX_LONG_SIDE = 2048;

function context2d(canvas: OffscreenCanvas): OffscreenCanvasRenderingContext2D {
  const context = canvas.getContext('2d');
  if (!context) throw new UserFacingError('無法建立拼接用的畫布');
  return context;
}

/** 把分段擷取的截圖拼成一張完整的頁面圖。 */
export class PageStitcher {
  private readonly canvas: OffscreenCanvas;
  private readonly context: OffscreenCanvasRenderingContext2D;

  /** size 是目標頁的像素尺寸（CSS px × devicePixelRatio）。 */
  constructor(size: ImageSize) {
    this.canvas = new OffscreenCanvas(Math.max(1, Math.round(size.width)), Math.max(1, Math.round(size.height)));
    this.context = context2d(this.canvas);
    this.context.fillStyle = '#ffffff';
    this.context.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  async addSlice(pngBytes: Uint8Array<ArrayBuffer>, slice: Slice): Promise<void> {
    const { src, dest } = slice;
    const bitmap = await createImageBitmap(
      new Blob([pngBytes], { type: 'image/png' }),
      src.left,
      src.top,
      src.width,
      src.height,
    );
    this.context.drawImage(bitmap, dest.x, dest.y);
    bitmap.close();
  }

  async toPng(): Promise<Uint8Array<ArrayBuffer>> {
    let output = this.canvas;
    const longSide = Math.max(output.width, output.height);
    if (longSide > MAX_LONG_SIDE) {
      const scale = MAX_LONG_SIDE / longSide;
      const scaled = new OffscreenCanvas(
        Math.max(1, Math.round(output.width * scale)),
        Math.max(1, Math.round(output.height * scale)),
      );
      const context = context2d(scaled);
      context.imageSmoothingQuality = 'high';
      context.drawImage(output, 0, 0, scaled.width, scaled.height);
      output = scaled;
    }
    const blob = await output.convertToBlob({ type: 'image/png' });
    return new Uint8Array(await blob.arrayBuffer());
  }
}

export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
