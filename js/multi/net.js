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
      this.everOpened = true; this.attempt = 0;
      this._sync();
      clearInterval(this.syncTimer);
      this.syncTimer = setInterval(() => this._sync(), 30000);
      this.h.onOpen && this.h.onOpen();
    };
    ws.onmessage = (e) => {
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
    setTimeout(() => { if (!this.closedByUs) this.connect(); }, wait);
  }

  send(obj) {
    if (this.open) this.ws.send(JSON.stringify(obj));
  }

  close() {
    this.closedByUs = true;
    clearInterval(this.syncTimer);
    try { this.ws && this.ws.close(); } catch { /* ignore */ }
  }

  /** 連續送 5 個 ping，取 RTT 最小的那次來估偏移（RTT 小＝路徑對稱的機率高） */
  _sync() {
    this.rtt = Infinity;
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
