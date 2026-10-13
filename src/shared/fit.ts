/**
 * 在 [min, max] 之間找出放得進框內的最大整數字級。
 * 連 min 都放不下時回傳 min，由呼叫端允許文字溢出。
 */
export function fitFontSize(min: number, max: number, fits: (size: number) => boolean): number {
  let lo = Math.ceil(min);
  let hi = Math.floor(max);
  if (hi <= lo || !fits(lo)) return lo;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
