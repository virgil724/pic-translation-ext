# 畫面翻譯（Gemini）

Chrome 擴充功能（Manifest V3）。擷取目前分頁的畫面，用 Gemini 辨識出每一段日文的位置與內容，翻成台灣繁體中文後疊回原文的位置上。主要用途是看日文漫畫。

> ⚠️ 0.0.1 是早期版本。核心流程已經在測試環境驗證過，但在各漫畫網站上的實際效果仍需要你自己確認。

## 功能

- **一頁一頁翻譯**：自動辨識畫面上的漫畫頁，每頁右上角有翻譯按鈕。
- **整頁擷取**：頁面比視窗高時自動分段擷取再拼接，一次翻譯完整的一頁。
- **譯文跟著原文走**：疊加層用相對座標定位，捲動、翻頁、視窗縮放都不會跑掉。
- **直排支援**：原文是直排時譯文也用直排。
- **字級自動調整**：縮到放得進框內為止，有最小字級下限。
- **重疊切換**：互相遮擋的譯文框可以點一下切換上下層。
- **狀聲詞不蓋**：畫在圖上的狀聲詞保持原樣，不破壞畫面。

## 支援的網站

| 網站 | 閱讀器型態 |
|---|---|
| [nicomanga](https://nicomanga.com) | 直向捲動 |
| [少年ジャンプ＋](https://shonenjumpplus.com) | 橫向翻頁 |
| [マガポケ](https://pocket.shonenmagazine.com) | 橫向翻頁 |
| [GANMA!](https://ganma.jp) | 橫向翻頁 |

其他網站也能用，只是不會辨識「頁」，改成翻譯整個可見範圍。

要加新網站只需在 `src/content/sites.ts` 加一筆選擇器。

## 安裝

需要 Node.js 20 以上。

```bash
npm install
npm run build
```

然後在 Chrome：

1. 開啟 `chrome://extensions`
2. 開啟右上角的「開發人員模式」
3. 點「載入未封裝項目」，選擇 `dist/` 資料夾

## 設定

第一次使用要先填 Gemini API key：擴充功能的「選項」頁面（或 `chrome://extensions` 裡的「擴充功能選項」）。

| 設定 | 說明 |
|---|---|
| API 服務 | 依 key 的來源選擇。AI Studio 的 key 選「Gemini API」，Vertex AI／Agent Platform 的 key 選另一個。**兩種不能互用，選錯會出現 403。** |
| API key | 只存在本機的 `chrome.storage.local`，只有背景程式讀得到，不會傳給網頁。 |
| 模型名稱 | 預設 `gemini-3.8-flash`。需要支援圖片輸入與結構化輸出。 |
| 譯文樣式 | 底色、文字顏色、字型、最小與最大字級。 |

AI Studio 的 key 可在 [aistudio.google.com/apikey](https://aistudio.google.com/apikey) 建立。

## 使用

1. 打開漫畫頁面，按工具列按鈕或快捷鍵 <kbd>Alt</kbd>+<kbd>Q</kbd>。
2. 這一下會翻譯目前正在看的頁面（跨頁顯示時是左右兩頁），同時每一頁右上角會出現翻譯按鈕。
3. 之後直接按各頁的按鈕即可。翻過的頁按鈕會變成「重新翻譯」。

| 快捷鍵 | 功能 |
|---|---|
| <kbd>Alt</kbd>+<kbd>Q</kbd> | 翻譯目前畫面 |
| <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>H</kbd> | 顯示／隱藏譯文 |
| <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>X</kbd> | 清除譯文 |

可在 `chrome://extensions/shortcuts` 修改。

頁面上的按鈕要先按過一次工具列按鈕才會出現：這個擴充功能不要求 `<all_urls>` 權限，只有你主動啟用時才會注入頁面。

## 隱私

翻譯時**畫面截圖會送到 Google 的 Gemini API**。這是功能的必要條件。除此之外不會傳送任何資料，也沒有任何統計或追蹤。

API key 只存在你自己的瀏覽器裡。

## 架構

分層明確，各層職責不混用：

```
src/
├── background/   service worker：擷取、呼叫 Gemini、拼接、cache。API key 只存在這一層
│   ├── capture.ts   captureVisibleTab 的節流與受限頁面判斷
│   ├── gemini.ts    結構化輸出、重試與退避
│   ├── stitch.ts    分段截圖拼接成整頁
│   ├── cache.ts     getOrFetch 與可抽換的後端
│   └── prompt.ts    翻譯規則與回應 schema
├── content/      content script：回報座標、繪製與清除疊加層。不直接呼叫 Gemini
│   ├── overlay.ts   Shadow DOM 疊加層
│   └── sites.ts     各網站的頁面選擇器
├── options/      設定頁
├── popup/        受限頁面的說明視窗
└── shared/       型別、訊息定義、座標換算、設定
```

層與層之間用 `chrome.runtime` 訊息溝通，格式定義在 `src/shared/messages.ts`。

**座標換算**：Gemini 回傳 `box_2d` 為 `[ymin, xmin, ymax, xmax]`，正規化到 0–1000。換算路徑是「正規化座標 → 截圖像素 → CSS px（除以 devicePixelRatio）→ 文件座標或頁面相對座標」，全部寫成純函式並有單元測試。

**權限**：只用 `activeTab`、`storage`、`scripting`，加上 Gemini API 的 `host_permissions`。不要求 `<all_urls>`。

## 開發

```bash
npm run check      # 型別檢查 + lint + 測試 + build
npm run watch      # 監看並自動重建
npm test           # 單元測試
```

TypeScript strict 模式，不使用 `any`。

## 已知限制

- 內層捲動的閱讀器（在某個 `div` 裡捲動而非整頁捲動）尚未支援。
- 翻頁式閱讀器的頁面辨識依賴網站的 DOM 結構，網站改版可能失效。
- 一頁最多分 8 段擷取，超長的條漫單張圖會回報錯誤。
- 擷取期間畫面會自動捲動，這一兩秒不能操作。
- cache 目前是 passthrough（不實際儲存），每次翻譯都會呼叫 API。
- 沒有整章批次翻譯。

## 授權

MIT
