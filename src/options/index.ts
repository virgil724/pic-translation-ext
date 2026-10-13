import { loadSettings, normalizeSettings, saveSettings } from '../shared/settings';
import type { Settings } from '../shared/types';

function input(id: string): HTMLInputElement {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLInputElement)) throw new Error(`找不到輸入欄位 #${id}`);
  return element;
}

const fields = {
  apiKey: input('apiKey'),
  model: input('model'),
  background: input('background'),
  color: input('color'),
  fontFamily: input('fontFamily'),
  minFontSize: input('minFontSize'),
  maxFontSize: input('maxFontSize'),
};
const providerElement = document.getElementById('provider');
const provider = providerElement instanceof HTMLSelectElement ? providerElement : undefined;
const form = document.getElementById('form');
const status = document.getElementById('status');
const preview = document.getElementById('preview');

function fill(settings: Settings): void {
  if (provider) provider.value = settings.provider;
  fields.apiKey.value = settings.apiKey;
  fields.model.value = settings.model;
  fields.background.value = settings.overlay.background;
  fields.color.value = settings.overlay.color;
  fields.fontFamily.value = settings.overlay.fontFamily;
  fields.minFontSize.value = String(settings.overlay.minFontSize);
  fields.maxFontSize.value = String(settings.overlay.maxFontSize);
}

function read(): Settings {
  // 值不在清單內時 saveSettings 會補回預設值。
  return normalizeSettings({
    provider: provider?.value,
    apiKey: fields.apiKey.value,
    model: fields.model.value,
    overlay: {
      background: fields.background.value,
      color: fields.color.value,
      fontFamily: fields.fontFamily.value,
      minFontSize: fields.minFontSize.valueAsNumber,
      maxFontSize: fields.maxFontSize.valueAsNumber,
    },
  });
}

function updatePreview(): void {
  if (!preview) return;
  preview.style.background = fields.background.value;
  preview.style.color = fields.color.value;
  preview.style.fontFamily = fields.fontFamily.value;
}

function showStatus(text: string, isError: boolean): void {
  if (!status) return;
  status.textContent = text;
  status.className = isError ? 'status error' : 'status success';
}

async function save(): Promise<void> {
  try {
    await saveSettings(read());
    // 存進去的值經過補齊與範圍限制，重新讀回來讓畫面和實際設定一致。
    fill(await loadSettings());
    updatePreview();
    showStatus('設定已儲存', false);
  } catch (error) {
    showStatus(`儲存失敗：${error instanceof Error ? error.message : String(error)}`, true);
  }
}

form?.addEventListener('submit', (event) => {
  event.preventDefault();
  void save();
});
for (const field of [fields.background, fields.color, fields.fontFamily]) {
  field.addEventListener('input', updatePreview);
}

void loadSettings().then((settings) => {
  fill(settings);
  updatePreview();
});
