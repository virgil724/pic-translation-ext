import { containRect } from '../shared/coords';
import type { Rect } from '../shared/types';

/** 針對特定網站的設定：告訴 content script 哪些元素是一頁一頁的漫畫圖。 */
export interface SiteAdapter {
  name: string;
  /** 網域，含子網域。 */
  hosts: readonly string[];
  /** 每個符合的元素（img 或 canvas）是一頁。 */
  pageSelector: string;
  /**
   * 翻頁式閱讀器：頁面靠 left／transform 移動而不是捲動視窗，
   * 沒有事件可以監聽，所以每個畫格重新對位，並且只顯示視窗內的頁面。
   */
  followMotion: boolean;
  /**
   * canvas 頁面沒有網址可以辨識是哪一頁，改用它所在的「格子」是整章第幾個來認。
   * 這個選擇器要選到閱讀器為每一頁保留、不會被回收的容器。img 頁面用圖片網址辨識，不需要設定。
   */
  slotSelector?: string;
}

const ADAPTERS: readonly SiteAdapter[] = [
  {
    name: 'nicomanga',
    hosts: ['nicomanga.com'],
    pageSelector: 'img.chapter-img',
    followMotion: false,
  },
  {
    name: 'shonenjumpplus',
    hosts: ['shonenjumpplus.com'],
    pageSelector: 'canvas.js-page-image',
    followMotion: true,
    slotSelector: '.js-page-area',
  },
  {
    name: 'magapoke',
    hosts: ['pocket.shonenmagazine.com'],
    pageSelector: '.c-viewer__comic-item-image canvas',
    followMotion: true,
    slotSelector: '.c-viewer__page',
  },
  {
    name: 'ganma',
    hosts: ['ganma.jp'],
    pageSelector: '[class*="HorizontalReader_container"] img[data-nimg]',
    followMotion: true,
  },
];

export function findAdapter(location: Location): SiteAdapter | undefined {
  const { hostname } = location;
  return ADAPTERS.find((adapter) => adapter.hosts.some((host) => hostname === host || hostname.endsWith(`.${host}`)));
}

/** 小於這個尺寸的圖當成佔位圖（例如跨頁閱讀器補空位用的透明小圖）。 */
const MIN_NATURAL_SIZE = 100;

/** 圖片還沒載入完成時（延遲載入的佔位圖）不能翻譯，尺寸也還會變。 */
export function isPageReady(page: HTMLElement): boolean {
  if (!page.isConnected) return false;
  if (page instanceof HTMLImageElement) return page.complete && page.naturalWidth >= MIN_NATURAL_SIZE;
  if (page instanceof HTMLCanvasElement) return page.width >= MIN_NATURAL_SIZE;
  return true;
}

function toRect(rect: DOMRect): Rect {
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

/** 把 object-position 的一個分量換成 0–1 的比例；不是百分比時當成置中。 */
function positionFraction(value: string | undefined): number {
  if (value?.endsWith('%')) {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed / 100;
  }
  return 0.5;
}

/**
 * 一頁的圖實際畫在視窗內的哪個範圍（CSS px）。
 * 用了 object-fit: contain 的 img，元素的框比圖大，要算出圖本身的位置。
 */
export function getPageRect(page: HTMLElement): Rect {
  const box = toRect(page.getBoundingClientRect());
  if (!(page instanceof HTMLImageElement) || page.naturalWidth === 0 || page.naturalHeight === 0) return box;
  const style = getComputedStyle(page);
  if (style.objectFit !== 'contain' && style.objectFit !== 'scale-down') return box;
  const [x, y] = style.objectPosition.split(' ');
  return containRect(
    box,
    { width: page.naturalWidth, height: page.naturalHeight },
    { x: positionFraction(x), y: positionFraction(y) },
  );
}

/**
 * 算出每一頁的識別字串，同一頁的元素被閱讀器回收重建後仍然相同。
 * 認不出來的頁面不會出現在結果裡。
 */
export function getPageKeys(pages: readonly HTMLElement[], adapter: SiteAdapter): Map<HTMLElement, string> {
  const keys = new Map<HTMLElement, string>();
  // 同一個網站換章節時網址會變，把路徑放進去避免不同章節的第 N 頁互相誤認。
  const prefix = window.location.pathname;
  const slots = adapter.slotSelector ? [...document.querySelectorAll(adapter.slotSelector)] : [];
  for (const page of pages) {
    if (page instanceof HTMLImageElement) {
      if (page.src !== '') keys.set(page, `${prefix}|img:${page.src}`);
      continue;
    }
    if (!adapter.slotSelector) continue;
    const slot = page.closest(adapter.slotSelector);
    const index = slot ? slots.indexOf(slot) : -1;
    if (index >= 0) keys.set(page, `${prefix}|slot:${index}`);
  }
  return keys;
}
