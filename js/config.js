// 多人模式伺服器位址。
// - 空字串：連到「目前這個網頁所在的主機」的 /ws（由 Node 伺服器直接提供網頁時使用）
// - 在 GitHub Pages 上玩多人時，改成你的伺服器，例如 'wss://songguesser.example.com/ws'
//   （伺服器要把 Pages 網址加進 ALLOWED_ORIGINS，例如 https://yourname.github.io）
export const MULTI_WS_URL = '';

export function wsUrl() {
  if (MULTI_WS_URL) return MULTI_WS_URL;
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
}
