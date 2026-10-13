import { API_PROVIDERS, type ApiProvider, type OverlayStyle, type Settings } from './types';

const STORAGE_KEY = 'settings';

export const DEFAULT_SETTINGS: Settings = {
  provider: 'gemini-api',
  apiKey: '',
  model: 'gemini-3.8-flash',
  overlay: {
    background: '#ffffff',
    color: '#111111',
    fontFamily: '"Noto Sans TC", "Microsoft JhengHei", "PingFang TC", sans-serif',
    minFontSize: 10,
    maxFontSize: 32,
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isApiProvider(value: unknown): value is ApiProvider {
  return typeof value === 'string' && (API_PROVIDERS as readonly string[]).includes(value);
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}

function numberOr(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** 把 storage 裡不可信的值補齊成完整的 Settings。 */
export function normalizeSettings(raw: unknown): Settings {
  const source = isRecord(raw) ? raw : {};
  const overlay = isRecord(source.overlay) ? source.overlay : {};
  const defaults = DEFAULT_SETTINGS.overlay;
  const minFontSize = numberOr(overlay.minFontSize, defaults.minFontSize, 6, 48);
  const normalizedOverlay: OverlayStyle = {
    background: stringOr(overlay.background, defaults.background),
    color: stringOr(overlay.color, defaults.color),
    fontFamily: stringOr(overlay.fontFamily, defaults.fontFamily),
    minFontSize,
    maxFontSize: numberOr(overlay.maxFontSize, defaults.maxFontSize, minFontSize, 96),
  };
  return {
    provider: isApiProvider(source.provider) ? source.provider : DEFAULT_SETTINGS.provider,
    apiKey: stringOr(source.apiKey, ''),
    model: stringOr(source.model, DEFAULT_SETTINGS.model),
    overlay: normalizedOverlay,
  };
}

// 只給 service worker 和 options 頁使用；content script 拿不到 chrome.storage.local
// （service worker 啟動時把存取層級設成 TRUSTED_CONTEXTS）。
export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return normalizeSettings(stored[STORAGE_KEY]);
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: normalizeSettings(settings) });
}
