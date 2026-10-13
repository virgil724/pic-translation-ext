import {
  box2dToDocumentRect,
  box2dToRelative,
  expandRect,
  findOverlapping,
  intersectRect,
} from '../shared/coords';
import { fitFontSize } from '../shared/fit';
import type { StatusLevel } from '../shared/messages';
import type { CaptureContext, OverlayStyle, Rect, TranslationItem } from '../shared/types';

const HOST_ID = 'pic-translate-overlay-host';
const TOAST_DURATION_MS = 4000;
const ERROR_TOAST_DURATION_MS = 10000;
const PAINT_TIMEOUT_MS = 250;
/** 蓋住原文的底色框比模型給的框每邊多出的比例。 */
const BOX_BLEED_RATIO = 0.06;
const UNIT_RECT: Rect = { left: 0, top: 0, width: 1, height: 1 };
/** 兩個框重疊的面積超過較小那個的這個比例，才當成互相遮擋。 */
const STACK_OVERLAP_RATIO = 0.05;

// all: initial 擋掉頁面對 host 元素本身的樣式；內部樣式都在 shadow root 裡。
const HOST_STYLE = [
  'all: initial',
  'position: absolute',
  'top: 0',
  'left: 0',
  'width: 0',
  'height: 0',
  'z-index: 2147483647',
  'pointer-events: none',
].join('; ');

const SHADOW_CSS = `
.layer {
  position: absolute;
  top: 0;
  left: 0;
  pointer-events: none;
}
.layer.boxes-hidden .box {
  display: none;
}
.frame {
  position: absolute;
  pointer-events: none;
}
.box {
  position: absolute;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2px;
  border-radius: 4px;
  overflow: visible;
  background: var(--pt-background);
  color: var(--pt-color);
  font-family: var(--pt-font-family);
  font-weight: 500;
  line-height: 1.25;
  pointer-events: none;
}
.box.stacked {
  pointer-events: auto;
  cursor: pointer;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.35);
}
.text {
  min-width: 0;
  min-height: 0;
  max-width: 100%;
  max-height: 100%;
  text-align: center;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.box.vertical .text {
  writing-mode: vertical-rl;
  text-align: start;
}
.page-button {
  position: absolute;
  top: 8px;
  right: 8px;
  padding: 6px 12px;
  border: none;
  border-radius: 6px;
  background: rgba(26, 115, 232, 0.92);
  color: #ffffff;
  font: 600 13px/1.2 system-ui, sans-serif;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.4);
  cursor: pointer;
  pointer-events: auto;
  opacity: 0.75;
}
.page-button:hover {
  opacity: 1;
}
.page-button.busy {
  background: rgba(95, 99, 104, 0.92);
  cursor: progress;
  opacity: 1;
}
.toast {
  position: fixed;
  top: 16px;
  right: 16px;
  max-width: 360px;
  padding: 8px 12px;
  border-radius: 6px;
  background: #202124;
  color: #ffffff;
  font: 14px/1.4 system-ui, sans-serif;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  pointer-events: none;
}
.toast.error {
  background: #b3261e;
}
.toast[hidden] {
  display: none;
}
`;

/** 等到瀏覽器把目前的 DOM 狀態畫上螢幕。分頁在背景時 rAF 不會觸發，所以加上逾時。 */
export function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, PAINT_TIMEOUT_MS);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  });
}

interface BoxRecord {
  box: HTMLElement;
  text: HTMLElement;
  /** 框的位置，和同一組的其他框用同一種單位，用來判斷有沒有互相重疊。 */
  rect: Rect;
}

/** 一頁漫畫對應的容器：疊在該頁元素正上方，裡面放翻譯按鈕和用百分比定位的譯文框。 */
interface PageFrame {
  frame: HTMLElement;
  button: HTMLButtonElement;
  boxes: BoxRecord[];
  style: OverlayStyle | undefined;
  /** 上次調整字級時的寬度；頁面縮放後要重新調整。 */
  fittedWidth: number;
  translated: boolean;
  busy: boolean;
  /** 上次套用的位置，用來判斷這次需不需要更新樣式。 */
  placement: string;
}

export interface OverlayOptions {
  onPageButton: (page: HTMLElement) => void;
  /** 一頁的圖實際畫在視窗內的哪個範圍。 */
  getPageRect: (page: HTMLElement) => Rect;
  followMotion: boolean;
}

function setRect(element: HTMLElement, rect: Rect, unit: 'px' | '%'): void {
  const scale = unit === '%' ? 100 : 1;
  element.style.left = `${rect.left * scale}${unit}`;
  element.style.top = `${rect.top * scale}${unit}`;
  element.style.width = `${rect.width * scale}${unit}`;
  element.style.height = `${rect.height * scale}${unit}`;
}

function applyStyle(element: HTMLElement, style: OverlayStyle): void {
  element.style.setProperty('--pt-background', style.background);
  element.style.setProperty('--pt-color', style.color);
  element.style.setProperty('--pt-font-family', style.fontFamily);
}

function createBox(item: TranslationItem, translation: string, rect: Rect, unit: 'px' | '%'): BoxRecord {
  const box = document.createElement('div');
  box.className = item.vertical ? 'box vertical' : 'box';
  box.dataset.kind = item.kind;
  const text = document.createElement('div');
  text.className = 'text';
  text.textContent = translation;
  box.append(text);
  setRect(box, rect, unit);
  return { box, text, rect };
}

/**
 * 互相重疊的框會蓋住彼此的譯文。讓這些框可以點：點一下把最上面那個送到最底層，
 * 露出下面的。沒有重疊的框維持不接收滑鼠事件，不擋頁面操作。
 */
function enableStacking(records: readonly BoxRecord[]): void {
  const overlapping = findOverlapping(
    records.map((record) => record.rect),
    STACK_OVERLAP_RATIO,
  );
  records.forEach(({ box }, index) => {
    if (!overlapping[index]) return;
    box.classList.add('stacked');
    box.title = '點一下切換上下層';
    box.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      // 同一層的元素後面的蓋住前面的，移到最前面就是送到最底層。
      box.parentElement?.prepend(box);
    });
  });
}

/** 低於最小字級仍放不下時，停在最小字級並讓文字溢出框外。 */
function fitBox(record: BoxRecord, style: OverlayStyle): void {
  const { text } = record;
  const size = fitFontSize(style.minFontSize, style.maxFontSize, (candidate) => {
    text.style.fontSize = `${candidate}px`;
    // 框的尺寸可能不是整數像素，scroll／client 尺寸各自取整後會差到 1px，留這點容許值。
    return text.scrollWidth <= text.clientWidth + 1 && text.scrollHeight <= text.clientHeight + 1;
  });
  text.style.fontSize = `${size}px`;
}

export class Overlay {
  private readonly host: HTMLElement;
  private readonly layer: HTMLElement;
  /** 沒有對應頁面元素的譯文（整個視窗的截圖），用文件座標定位。 */
  private readonly loose: HTMLElement;
  private readonly toast: HTMLElement;
  private readonly frames = new Map<HTMLElement, PageFrame>();
  private readonly resizeObserver = new ResizeObserver(() => {
    this.scheduleLayout();
  });
  private layoutScheduled = false;
  private toastTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: OverlayOptions) {
    // 擴充功能重新載入後，舊 content script 留下的 host 還在頁面上。
    document.getElementById(HOST_ID)?.remove();

    this.host = document.createElement('div');
    this.host.id = HOST_ID;
    this.host.style.cssText = HOST_STYLE;
    const root = this.host.attachShadow({ mode: 'closed' });

    const style = document.createElement('style');
    style.textContent = SHADOW_CSS;
    this.layer = document.createElement('div');
    this.layer.className = 'layer';
    this.loose = document.createElement('div');
    this.layer.append(this.loose);
    this.toast = document.createElement('div');
    this.toast.className = 'toast';
    this.toast.hidden = true;
    root.append(style, this.layer, this.toast);

    // 延遲載入的圖片載入後，後面每一頁的位置都會變；body 的高度改變時重新對位。
    this.resizeObserver.observe(document.documentElement);
    this.resizeObserver.observe(document.body);
    if (options.followMotion) this.follow();
  }

  /** 翻頁式閱讀器：頁面移動時沒有事件可聽，每個畫格重新對位一次。 */
  private follow(): void {
    requestAnimationFrame(() => {
      if (this.frames.size > 0) this.layout();
      this.follow();
    });
  }

  get hasLooseBoxes(): boolean {
    return this.loose.childElementCount > 0;
  }

  private attach(): void {
    if (!this.host.isConnected) document.documentElement.append(this.host);
  }

  /** 擷取前把整個疊加層（譯文、按鈕、狀態訊息）移出畫面，回傳時已經重繪完成。 */
  async hideForCapture(): Promise<void> {
    this.host.style.display = 'none';
    await nextPaint();
  }

  restoreAfterCapture(): void {
    this.host.style.display = '';
    this.layout();
  }

  // ───── 頁面容器與按鈕 ─────

  /** 讓 pages 裡的每一頁都有容器和翻譯按鈕，並移除已不在清單裡的頁面。 */
  syncPages(pages: readonly HTMLElement[]): void {
    const wanted = new Set(pages);
    for (const [page, entry] of this.frames) {
      if (wanted.has(page) && page.isConnected) continue;
      this.resizeObserver.unobserve(page);
      entry.frame.remove();
      this.frames.delete(page);
    }
    for (const page of pages) {
      if (this.frames.has(page)) continue;
      const frame = document.createElement('div');
      frame.className = 'frame';
      const button = document.createElement('button');
      button.className = 'page-button';
      button.type = 'button';
      // 不讓按鈕拿走鍵盤焦點，否則閱讀器的方向鍵翻頁會失效。
      button.addEventListener('mousedown', (event) => {
        event.preventDefault();
      });
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!this.isBusy(page)) this.options.onPageButton(page);
      });
      frame.append(button);
      this.layer.append(frame);
      const entry: PageFrame = {
        frame,
        button,
        boxes: [],
        style: undefined,
        fittedWidth: 0,
        translated: false,
        busy: false,
        placement: '',
      };
      this.frames.set(page, entry);
      this.updateButton(entry);
      this.resizeObserver.observe(page);
    }
    if (this.frames.size > 0) this.attach();
    this.layout();
  }

  private updateButton(entry: PageFrame): void {
    // 不用 disabled：被停用的按鈕若握有焦點，會把鍵盤事件吃掉。
    entry.button.classList.toggle('busy', entry.busy);
    entry.button.setAttribute('aria-disabled', String(entry.busy));
    entry.button.textContent = entry.busy ? '翻譯中…' : entry.translated ? '重新翻譯' : '翻譯';
  }

  isBusy(page: HTMLElement): boolean {
    return this.frames.get(page)?.busy ?? false;
  }

  isTranslated(page: HTMLElement): boolean {
    return this.frames.get(page)?.translated ?? false;
  }

  setPageBusy(page: HTMLElement, busy: boolean): void {
    const entry = this.frames.get(page);
    if (!entry) return;
    entry.busy = busy;
    this.updateButton(entry);
  }

  // ───── 對位 ─────

  private scheduleLayout(): void {
    if (this.layoutScheduled) return;
    this.layoutScheduled = true;
    requestAnimationFrame(() => {
      this.layoutScheduled = false;
      this.layout();
    });
  }

  /** 把每個頁面容器重新疊到對應的頁面元素上。 */
  layout(): void {
    if (!this.host.isConnected || this.host.style.display === 'none') return;
    // host 的定位原點通常就是文件原點；html 被設了 position 或 transform 時會偏移，這裡補回來。
    const hostRect = this.host.getBoundingClientRect();
    this.layer.style.left = `${-(hostRect.left + window.scrollX)}px`;
    this.layer.style.top = `${-(hostRect.top + window.scrollY)}px`;

    // 先讀完所有位置再寫，避免讀寫交錯造成反覆重排。
    const viewport: Rect = { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
    const rects = [...this.frames].map(([page, entry]) => ({ entry, rect: this.options.getPageRect(page) }));
    for (const { entry, rect } of rects) {
      // 翻頁式閱讀器把其他頁排在視窗外很遠的地方，只顯示看得到的頁面。
      const visible =
        rect.width > 0 && rect.height > 0 && (!this.options.followMotion || intersectRect(rect, viewport) !== undefined);
      const placement = visible
        ? [rect.left + window.scrollX, rect.top + window.scrollY, rect.width, rect.height].map((v) => v.toFixed(2)).join(',')
        : 'hidden';
      // 每個畫格都會跑到這裡，位置沒變就不要動樣式。
      if (placement === entry.placement) continue;
      entry.placement = placement;
      entry.frame.style.display = visible ? '' : 'none';
      if (!visible) continue;
      setRect(
        entry.frame,
        { left: rect.left + window.scrollX, top: rect.top + window.scrollY, width: rect.width, height: rect.height },
        'px',
      );
    }
    for (const { entry, rect } of rects) {
      if (!entry.style || entry.boxes.length === 0 || rect.width <= 0 || entry.placement === 'hidden') continue;
      if (Math.abs(rect.width - entry.fittedWidth) < 0.5) continue;
      for (const record of entry.boxes) fitBox(record, entry.style);
      entry.fittedWidth = rect.width;
    }
  }

  // ───── 譯文 ─────

  private showBoxes(): void {
    this.attach();
    this.host.style.display = '';
    this.layer.classList.remove('boxes-hidden');
  }

  /** 整個視窗截圖的結果：用文件座標定位，取代之前同類的譯文。回傳實際畫出的數量。 */
  renderViewport(items: readonly TranslationItem[], capture: CaptureContext, style: OverlayStyle): number {
    this.showBoxes();
    this.layout();
    this.loose.replaceChildren();
    applyStyle(this.loose, style);

    const records: BoxRecord[] = [];
    for (const item of items) {
      const translation = item.translation.trim();
      // 狀聲詞畫在圖上，蓋掉反而破壞畫面，一律不畫。
      if (translation === '' || item.kind === 'sfx') continue;
      const rect = box2dToDocumentRect(item.box_2d, capture);
      if (rect.width <= 0 || rect.height <= 0) continue;
      const record = createBox(item, translation, expandRect(rect, BOX_BLEED_RATIO), 'px');
      records.push(record);
      this.loose.append(record.box);
      fitBox(record, style);
    }
    enableStacking(records);
    return records.length;
  }

  /**
   * 單一頁的結果：框用相對於該頁的百分比定位，頁面移動或縮放時跟著走。
   * 只取代這一頁的譯文。該頁已不在頁面上時回傳 undefined。
   */
  renderPage(page: HTMLElement, items: readonly TranslationItem[], style: OverlayStyle): number | undefined {
    const entry = this.frames.get(page);
    if (!entry || !page.isConnected) return undefined;
    this.showBoxes();

    for (const record of entry.boxes) record.box.remove();
    entry.boxes = [];
    entry.style = style;
    entry.fittedWidth = 0;
    applyStyle(entry.frame, style);

    for (const item of items) {
      const translation = item.translation.trim();
      // 狀聲詞畫在圖上，蓋掉反而破壞畫面，一律不畫。
      if (translation === '' || item.kind === 'sfx') continue;
      const relative = box2dToRelative(item.box_2d);
      if (relative.width <= 0 || relative.height <= 0) continue;
      const record = createBox(item, translation, expandRect(relative, BOX_BLEED_RATIO, UNIT_RECT), '%');
      // 按鈕留在最後面，才不會被譯文框蓋住。
      entry.frame.insertBefore(record.box, entry.button);
      entry.boxes.push(record);
    }
    enableStacking(entry.boxes);
    entry.translated = true;
    this.updateButton(entry);
    // layout 會把容器對到頁面上，並在尺寸確定後調整字級。
    this.layout();
    return entry.boxes.length;
  }

  /** 切換譯文顯示（按鈕不受影響），回傳切換後是否可見。 */
  toggle(): boolean {
    return !this.layer.classList.toggle('boxes-hidden');
  }

  get hasBoxes(): boolean {
    if (this.hasLooseBoxes) return true;
    for (const entry of this.frames.values()) {
      if (entry.boxes.length > 0) return true;
    }
    return false;
  }

  clearLoose(): void {
    this.loose.replaceChildren();
  }

  clear(): void {
    this.clearLoose();
    for (const entry of this.frames.values()) {
      for (const record of entry.boxes) record.box.remove();
      entry.boxes = [];
      entry.translated = false;
      this.updateButton(entry);
    }
    this.layer.classList.remove('boxes-hidden');
  }

  showStatus(text: string, level: StatusLevel, sticky: boolean): void {
    this.attach();
    clearTimeout(this.toastTimer);
    this.toast.textContent = text;
    this.toast.className = level === 'error' ? 'toast error' : 'toast';
    this.toast.hidden = false;
    if (!sticky) {
      this.toastTimer = setTimeout(
        () => {
          this.toast.hidden = true;
        },
        level === 'error' ? ERROR_TOAST_DURATION_MS : TOAST_DURATION_MS,
      );
    }
  }
}
