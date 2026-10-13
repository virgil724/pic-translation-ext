/** message 可以直接顯示給使用者看的錯誤。 */
export class UserFacingError extends Error {
  override name = 'UserFacingError';
}

/** 無法擷取或注入的頁面（chrome://、線上應用程式商店等）。 */
export class RestrictedPageError extends UserFacingError {
  override name = 'RestrictedPageError';
}

export function toUserMessage(error: unknown): string {
  if (error instanceof UserFacingError) return error.message;
  const detail = error instanceof Error ? error.message : String(error);
  return `發生未預期的錯誤：${detail}`;
}
