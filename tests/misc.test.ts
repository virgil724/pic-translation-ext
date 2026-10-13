import { describe, expect, it } from 'vitest';
import { computeWaitMs, decodeDataUrl, readPngSize, restrictedReason } from '../src/background/capture';
import { fitFontSize } from '../src/shared/fit';
import { isContentRequest } from '../src/shared/messages';
import { DEFAULT_SETTINGS, normalizeSettings } from '../src/shared/settings';

// 1×1 透明 PNG
const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

describe('computeWaitMs', () => {
  it('沒有上次擷取紀錄時不用等', () => {
    expect(computeWaitMs(undefined, 1000, 600)).toBe(0);
  });

  it('距離上次不足間隔時等到滿', () => {
    expect(computeWaitMs(1000, 1200, 600)).toBe(400);
  });

  it('已超過間隔時不用等', () => {
    expect(computeWaitMs(1000, 1700, 600)).toBe(0);
  });

  it('時鐘倒退時不用等', () => {
    expect(computeWaitMs(5000, 1000, 600)).toBe(0);
  });
});

describe('restrictedReason', () => {
  it.each([
    'chrome://extensions/',
    'chrome://newtab/',
    'chrome-extension://abcdefghijklmnop/options.html',
    'devtools://devtools/bundled/inspector.html',
    'about:blank',
    'view-source:https://example.com/',
    'https://chromewebstore.google.com/detail/foo/abc',
    'https://chrome.google.com/webstore/detail/foo/abc',
  ])('擋下 %s', (url) => {
    expect(restrictedReason(url)).toBeTypeOf('string');
  });

  it.each(['https://example.com/manga/1', 'http://localhost:3000/', 'https://chrome.google.com/intl/zh-TW/', undefined])(
    '放行 %s',
    (url) => {
      expect(restrictedReason(url)).toBeUndefined();
    },
  );
});

describe('PNG 解碼', () => {
  it('從 data URL 取出 base64 與位元組，並讀出尺寸', () => {
    const { base64, bytes } = decodeDataUrl(`data:image/png;base64,${PNG_1X1}`);
    expect(base64).toBe(PNG_1X1);
    expect(readPngSize(bytes)).toEqual({ width: 1, height: 1 });
  });

  it('讀出 IHDR 裡的 big-endian 寬高', () => {
    const bytes = new Uint8Array(24);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    new DataView(bytes.buffer).setUint32(16, 3840);
    new DataView(bytes.buffer).setUint32(20, 2160);
    expect(readPngSize(bytes)).toEqual({ width: 3840, height: 2160 });
  });

  it('不是 PNG 時拋出錯誤', () => {
    expect(() => readPngSize(new Uint8Array(32))).toThrow();
    expect(() => decodeDataUrl('not a data url')).toThrow();
  });
});

describe('fitFontSize', () => {
  it('找出放得下的最大字級', () => {
    expect(fitFontSize(10, 32, (size) => size <= 17)).toBe(17);
  });

  it('全部放得下時用最大字級', () => {
    expect(fitFontSize(10, 32, () => true)).toBe(32);
  });

  it('連最小字級都放不下時停在最小字級', () => {
    expect(fitFontSize(10, 32, () => false)).toBe(10);
  });
});

describe('isContentRequest', () => {
  it('只接受已知的訊息類型', () => {
    expect(isContentRequest({ type: 'pt/ping' })).toBe(true);
    expect(isContentRequest({ type: 'other' })).toBe(false);
    expect(isContentRequest({ type: 1 })).toBe(false);
    expect(isContentRequest(null)).toBe(false);
    expect(isContentRequest('pt/ping')).toBe(false);
  });
});

describe('normalizeSettings', () => {
  it('storage 是空的時回傳預設值', () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
  });

  it('保留合法的值，補齊缺少或不合法的欄位', () => {
    const settings = normalizeSettings({
      apiKey: '  key  ',
      model: '',
      overlay: { background: '#000000', minFontSize: 'big', maxFontSize: 20 },
    });
    expect(settings.apiKey).toBe('key');
    expect(settings.model).toBe(DEFAULT_SETTINGS.model);
    expect(settings.overlay).toEqual({ ...DEFAULT_SETTINGS.overlay, background: '#000000', maxFontSize: 20 });
  });

  it('最大字級不會小於最小字級', () => {
    const settings = normalizeSettings({ overlay: { minFontSize: 24, maxFontSize: 12 } });
    expect(settings.overlay.maxFontSize).toBe(24);
  });
});
