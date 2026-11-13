// WebSocket 連線（自動重連）+ NTP 式時鐘校正
export class Net {
  /** @param {string} url @param {{onOpen?:Function,onClose?:Function,onMessage?:(m:object)=>void,onFail?:Function}} h */
  constructor(url, h = {}) {
    this.url = url;
    this.h = h;
    this.ws = null;
    this.offset = 0; // 伺服器時間 − 本機時間
    this.rtt = Infinity;
    this.closedByUs = false;
    this.attempt = 0;
    this.everOpened = false;
    this.syncTimer = null;
    this.retryTimer = null;
    this.lastMsg = Date.now();
    this._bindWake();
  }

  /** 伺服器時間（毫秒） */
  get now() { return Date.now() + this.offset; }
  /** 伺服器時間點 → 本機 Date.now() 時間點 */
  toLocal(serverMs) { return serverMs - this.offset; }
  get open() { return !!this.ws && this.ws.readyState === 1; }

  connect() {
    this.closedByUs = false;
    let ws;
    try { ws = new WebSocket(this.url); } catch (e) { this._failed(); return; }
    this.ws = ws;
    ws.onopen = () => {
      this.everOpened = true; this.attempt = 0; this.lastMsg = Date.now();
      this._sync();
      clearInterval(this.syncTimer);
      this.syncTimer = setInterval(() => this._sync(), 30000);
      this.h.onOpen && this.h.onOpen();
    };
    ws.onmessage = (e) => {
      this.lastMsg = Date.now();
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.t === 'pong') { this._onPong(m); return; }
      this.h.onMessage && this.h.onMessage(m);
    };
    ws.onclose = () => {
      clearInterval(this.syncTimer);
      this.h.onClose && this.h.onClose();
      if (this.closedByUs) return;
      this._failed();
    };
    ws.onerror = () => { /* onclose 會接著觸發 */ };
  }

  _failed() {
    this.attempt++;
    if (!this.everOpened && this.attempt >= 2) { this.h.onFail && this.h.onFail(); } // 一開始就連不上：回報
    const wait = Math.min(8000, 500 * 2 ** Math.min(this.attempt, 4));
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => { if (!this.closedByUs) this.connect(); }, wait);
  }

  send(obj) {
    if (this.open) this.ws.send(JSON.stringify(obj));
  }

  close() {
    this.closedByUs = true;
    clearInterval(this.syncTimer);
    clearTimeout(this.retryTimer);
    this._unbindWake();
    try { this.ws && this.ws.close(); } catch { /* ignore */ }
  }

  /** 手機回到前景、網路恢復時：馬上重連（不用等退避計時），或確認舊連線還活著 */
  _bindWake() {
    this._wake = () => {
      if (this.closedByUs || document.visibilityState === 'hidden') return;
      if (!this.open) {
        if (this.ws && this.ws.readyState === 0) return; // 正在連線中
        clearTimeout(this.retryTimer); this.attempt = 0; this.connect();
      } else {
        this.send({ t: 'ping', c: Date.now() });
        const before = this.lastMsg;
        setTimeout(() => { if (this.open && this.lastMsg === before) this._kill(); }, 4000); // 4 秒沒回應 = 其實已斷線
      }
    };
    document.addEventListener('visibilitychange', this._wake);
    window.addEventListener('online', this._wake);
    window.addEventListener('pageshow', this._wake);
  }

  _unbindWake() {
    document.removeEventListener('visibilitychange', this._wake);
    window.removeEventListener('online', this._wake);
    window.removeEventListener('pageshow', this._wake);
  }

  /** 連線已死（休眠後 TCP 沒斷、但實際上收不到）：不等瀏覽器慢慢超時，直接丟掉並重連 */
  _kill() {
    const ws = this.ws;
    if (!ws) return;
    ws.onclose = null; ws.onmessage = null; ws.onerror = null;
    try { ws.close(); } catch { /* ignore */ }
    this.ws = null;
    clearInterval(this.syncTimer);
    this.h.onClose && this.h.onClose();
    if (!this.closedByUs) this._failed();
  }

  /** 連續送 5 個 ping，取 RTT 最小的那次來估偏移（RTT 小＝路徑對稱的機率高） */
  _sync() {
    this.rtt = Infinity;
    // 看門狗：送出 ping 後 10 秒內完全沒收到任何訊息 → 連線已死（手機休眠後常見），主動關掉觸發重連
    const before = this.lastMsg;
    setTimeout(() => { if (this.open && this.lastMsg === before) this._kill(); }, 10000);
    for (let i = 0; i < 5; i++) setTimeout(() => this.send({ t: 'ping', c: Date.now() }), i * 200);
  }

  _onPong(m) {
    const t1 = Date.now();
    const rtt = t1 - m.c;
    if (rtt < this.rtt) {
      this.rtt = rtt;
      this.offset = m.s + rtt / 2 - t1;
    }
  }
}
