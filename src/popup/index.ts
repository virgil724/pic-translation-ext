// 只在無法翻譯的頁面出現：service worker 把錯誤訊息放在網址的 hash 裡。
const message = decodeURIComponent(location.hash.slice(1));
const target = document.getElementById('message');
if (target) {
  target.textContent = message === '' ? '這個頁面無法翻譯。' : message;
}
