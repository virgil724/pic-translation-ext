import { describe, expect, it } from 'vitest';
import {
  box2dToDocumentRect,
  box2dToRelative,
  containRect,
  expandRect,
  findOverlapping,
  sliceGeometry,
  cssPxToDocument,
  imagePxToCssPx,
  normalizedToImagePx,
} from '../src/shared/coords';
import type { CaptureContext } from '../src/shared/types';

function capture(overrides: Partial<CaptureContext['viewport']> = {}): CaptureContext {
  const viewport = {
    scrollX: 0,
    scrollY: 0,
    innerWidth: 1000,
    innerHeight: 800,
    devicePixelRatio: 1,
    ...overrides,
  };
  return {
    viewport,
    image: {
      width: viewport.innerWidth * viewport.devicePixelRatio,
      height: viewport.innerHeight * viewport.devicePixelRatio,
    },
  };
}

describe('normalizedToImagePx', () => {
  it('把 [ymin, xmin, ymax, xmax] 依圖片尺寸換成像素', () => {
    const rect = normalizedToImagePx([100, 200, 300, 600], { width: 2000, height: 1000 });
    expect(rect).toEqual({ left: 400, top: 100, width: 800, height: 200 });
  });

  it('y 用高度、x 用寬度換算，不會搞混', () => {
    const rect = normalizedToImagePx([500, 0, 1000, 500], { width: 400, height: 1200 });
    expect(rect).toEqual({ left: 0, top: 600, width: 200, height: 600 });
  });

  it('超出 0–1000 的值夾回圖內', () => {
    const rect = normalizedToImagePx([-50, -10, 1200, 1100], { width: 1000, height: 800 });
    expect(rect).toEqual({ left: 0, top: 0, width: 1000, height: 800 });
  });

  it('min 和 max 顛倒時仍得到正的寬高', () => {
    const rect = normalizedToImagePx([300, 600, 100, 200], { width: 1000, height: 1000 });
    expect(rect).toEqual({ left: 200, top: 100, width: 400, height: 200 });
  });
});

describe('imagePxToCssPx', () => {
  it('除以 devicePixelRatio', () => {
    expect(imagePxToCssPx({ left: 400, top: 100, width: 800, height: 200 }, 2)).toEqual({
      left: 200,
      top: 50,
      width: 400,
      height: 100,
    });
  });
});

describe('cssPxToDocument', () => {
  it('只平移位置，不改變大小', () => {
    const rect = cssPxToDocument({ left: 10, top: 20, width: 30, height: 40 }, { scrollX: 5, scrollY: 1000 });
    expect(rect).toEqual({ left: 15, top: 1020, width: 30, height: 40 });
  });
});

describe('box2dToDocumentRect', () => {
  const box = [250, 100, 500, 400] as const;

  it('DPR 1、未捲動', () => {
    expect(box2dToDocumentRect(box, capture())).toEqual({ left: 100, top: 200, width: 300, height: 200 });
  });

  it('DPR 2：截圖像素加倍，CSS 座標不變', () => {
    const ctx = capture({ devicePixelRatio: 2 });
    expect(ctx.image).toEqual({ width: 2000, height: 1600 });
    expect(box2dToDocumentRect(box, ctx)).toEqual({ left: 100, top: 200, width: 300, height: 200 });
  });

  it('DPR 1 且頁面捲動到中間', () => {
    const ctx = capture({ scrollX: 30, scrollY: 2400 });
    expect(box2dToDocumentRect(box, ctx)).toEqual({ left: 130, top: 2600, width: 300, height: 200 });
  });

  it('DPR 2 且頁面捲動到中間', () => {
    const ctx = capture({ devicePixelRatio: 2, scrollX: 30, scrollY: 2400 });
    expect(box2dToDocumentRect(box, ctx)).toEqual({ left: 130, top: 2600, width: 300, height: 200 });
  });

  it('非整數 DPR（1.5）', () => {
    const ctx = capture({ devicePixelRatio: 1.5, scrollY: 100 });
    const rect = box2dToDocumentRect(box, ctx);
    expect(rect.left).toBeCloseTo(100);
    expect(rect.top).toBeCloseTo(300);
    expect(rect.width).toBeCloseTo(300);
    expect(rect.height).toBeCloseTo(200);
  });

  it('用的是擷取當下的捲動量，和之後的視窗狀態無關', () => {
    const atCapture = capture({ scrollY: 500 });
    const rect = box2dToDocumentRect(box, atCapture);
    // 文件座標固定；使用者之後捲到 scrollY=900 時，框在視窗內的位置是 top - 900。
    expect(rect.top).toBe(700);
    expect(rect.top - 900).toBe(-200);
  });
});

describe('box2dToRelative', () => {
  it('換成相對於整張圖的 0–1 比例', () => {
    expect(box2dToRelative([250, 250, 500, 750])).toEqual({ left: 0.25, top: 0.25, width: 0.5, height: 0.25 });
  });
});

describe('sliceGeometry', () => {
  const viewport = { innerWidth: 1280, innerHeight: 800, devicePixelRatio: 1 };
  const shot = { width: 1280, height: 800 };

  it('頁面頂端對齊視窗頂端：取視窗內的部分，貼在畫布最上方', () => {
    const slice = sliceGeometry({ left: 68, top: 0, width: 1130, height: 1592 }, viewport, shot);
    expect(slice).toEqual({
      src: { left: 68, top: 0, width: 1130, height: 800 },
      dest: { x: 0, y: 0 },
      coveredTop: 0,
      coveredBottom: 800,
    });
  });

  it('捲到頁面中段：貼到畫布上對應的高度', () => {
    const slice = sliceGeometry({ left: 68, top: -792, width: 1130, height: 1592 }, viewport, shot);
    expect(slice).toEqual({
      src: { left: 68, top: 0, width: 1130, height: 800 },
      dest: { x: 0, y: 792 },
      coveredTop: 792,
      coveredBottom: 1592,
    });
  });

  it('頁面沒有貼齊視窗頂端（文件開頭或捲不動時）：只取頁面所在的範圍', () => {
    const slice = sliceGeometry({ left: 68, top: 300, width: 1130, height: 1592 }, viewport, shot);
    expect(slice?.src).toEqual({ left: 68, top: 300, width: 1130, height: 500 });
    expect(slice?.dest).toEqual({ x: 0, y: 0 });
    expect(slice?.coveredBottom).toBe(500);
  });

  it('DPR 2：來源與目的都用實際像素', () => {
    const slice = sliceGeometry(
      { left: 68, top: -792, width: 1130, height: 1592 },
      { ...viewport, devicePixelRatio: 2 },
      { width: 2560, height: 1600 },
    );
    expect(slice).toEqual({
      src: { left: 136, top: 0, width: 2260, height: 1600 },
      dest: { x: 0, y: 1584 },
      coveredTop: 792,
      coveredBottom: 1592,
    });
  });

  it('位置不是整數像素時向內取整，目的位置和來源對齊', () => {
    const slice = sliceGeometry({ left: 67.5, top: -674.2, width: 1130, height: 1591.55 }, viewport, shot);
    expect(slice?.src).toEqual({ left: 68, top: 0, width: 1129, height: 800 });
    expect(slice?.dest).toEqual({ x: 1, y: 674 });
  });

  it('頁面完全不在視窗內時回傳 undefined', () => {
    expect(sliceGeometry({ left: 68, top: 900, width: 1130, height: 1592 }, viewport, shot)).toBeUndefined();
    expect(sliceGeometry({ left: 68, top: -1700, width: 1130, height: 1592 }, viewport, shot)).toBeUndefined();
  });
});

describe('expandRect', () => {
  it('每一邊向外擴張自身寬高的比例', () => {
    expect(expandRect({ left: 100, top: 200, width: 50, height: 100 }, 0.1)).toEqual({
      left: 95,
      top: 190,
      width: 60,
      height: 120,
    });
  });

  it('不會超出 bounds', () => {
    const bounds = { left: 0, top: 0, width: 1, height: 1 };
    expect(expandRect({ left: 0, top: 0.5, width: 0.5, height: 0.5 }, 0.5, bounds)).toEqual({
      left: 0,
      top: 0.25,
      width: 0.75,
      height: 0.75,
    });
  });
});

describe('containRect', () => {
  const box = { left: 0, top: 0, width: 640, height: 679 };
  const natural = { width: 640, height: 902 };

  it('高度受限時圖比框窄，靠右對齊（object-position: 100% 50%）', () => {
    const rect = containRect(box, natural, { x: 1, y: 0.5 });
    expect(rect.height).toBeCloseTo(679);
    expect(rect.width).toBeCloseTo((640 * 679) / 902);
    expect(rect.left + rect.width).toBeCloseTo(640);
    expect(rect.top).toBeCloseTo(0);
  });

  it('靠左對齊（object-position: 0% 50%）', () => {
    expect(containRect(box, natural, { x: 0, y: 0.5 }).left).toBe(0);
  });

  it('寬度受限時上下置中', () => {
    const rect = containRect({ left: 10, top: 20, width: 200, height: 400 }, { width: 100, height: 100 }, { x: 0.5, y: 0.5 });
    expect(rect).toEqual({ left: 10, top: 120, width: 200, height: 200 });
  });
});

describe('findOverlapping', () => {
  const a = { left: 0, top: 0, width: 100, height: 100 };

  it('標出明顯重疊的矩形，不相干的不標', () => {
    const b = { left: 50, top: 50, width: 100, height: 100 };
    const c = { left: 500, top: 500, width: 50, height: 50 };
    expect(findOverlapping([a, b, c], 0.05)).toEqual([true, true, false]);
  });

  it('只有邊緣稍微碰到不算重疊', () => {
    const touching = { left: 98, top: 0, width: 100, height: 100 };
    expect(findOverlapping([a, touching], 0.05)).toEqual([false, false]);
  });

  it('小框整個落在大框裡算重疊', () => {
    const inner = { left: 40, top: 40, width: 10, height: 10 };
    expect(findOverlapping([a, inner], 0.05)).toEqual([true, true]);
  });
});
