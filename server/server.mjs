// 猜歌大賽多人伺服器：靜態檔（白名單）+ WebSocket（/ws）+ /healthz
// 環境變數：PORT（6713）、HOST（0.0.0.0）、ALLOWED_ORIGINS（逗號分隔，例如 https://yourname.github.io）、MAX_ROOMS（200）
import http from 'node:http';
import { readFileSync, statSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { ROOT, bank } from './bank.mjs';
import { Room } from './room.mjs';
import { parseMsg, normCode, randomCode, cleanNick } from './protocol.mjs';

const PORT = Number(process.env.PORT || 6713);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_ROOMS = Number(process.env.MAX_ROOMS || 200);
const ALLOWED = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
const ROOM_IDLE_MS = 30 * 60 * 1000;
// 房間狀態存檔：伺服器重啟（systemctl restart、更新程式、當機）後把房間還原，玩家的瀏覽器會自動重連、接回原本的座位與分數
const STATE_FILE = process.env.STATE_FILE || path.join(ROOT, 'state', 'rooms.json');
const STATE_SAVE_MS = Number(process.env.STATE_SAVE_MS || 2000);

const log = (...a) => console.log(new Date().toISOString(), ...a);

/** @type {Map<string, Room>} */
export const rooms = new Map();

// ===== 靜態檔（只開放白名單路徑）=====
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };
const ALLOW_PATH = [
  /^\/$/, /^\/index\.html$/, /^\/css\/[\w.-]+\.css$/, /^\/js\/(?:multi\/)?[\w.-]+\.js$/, /^\/data\/(?:anime|song|ost|movie)\.json$/,
];
const fileCache = new Map(); // path → {mtime, raw, gz}

function serveStatic(req, res) {
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { res.writeHead(400).end(); return; }
  let p = decodeURIComponent(url.pathname);
  if (url.pathname === '/healthz') {
    let players = 0;
    for (const r of rooms.values()) players += r.players.size;
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, rooms: rooms.size, players, questions: Object.values(bank).reduce((s, a) => s + a.length, 0) }));
    return;
  }
  if (!ALLOW_PATH.some((re) => re.test(p))) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found'); return; }
  if (p === '/') p = '/index.html';
  const file = path.join(ROOT, p);
  try {
    const st = statSync(file);
    let c = fileCache.get(file);
    if (!c || c.mtime !== st.mtimeMs) {
      const raw = readFileSync(file);
      c = { mtime: st.mtimeMs, raw, gz: raw.length > 1024 ? gzipSync(raw) : null };
      fileCache.set(file, c);
    }
    const headers = { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' };
    const useGz = c.gz && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    if (useGz) headers['content-encoding'] = 'gzip';
    headers.vary = 'accept-encoding';
    res.writeHead(200, headers).end(req.method === 'HEAD' ? undefined : (useGz ? c.gz : c.raw));
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
  }
}

const server = http.createServer(serveStatic);

// ===== WebSocket =====
const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });

function originOk(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // 非瀏覽器客戶端（測試腳本）
  if (ALLOWED.includes(origin)) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; } // 同源
}

server.on('upgrade', (req, socket, head) => {
  const pathname = (() => { try { return new URL(req.url, 'http://x').pathname; } catch { return ''; } })();
  if (pathname !== '/ws' || !originOk(req)) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

function makeConn(ws) {
  return {
    ws, room: null, player: null, screen: false, kicked: false,
    send(obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); },
    close() { try { ws.close(1000); } catch { /* ignore */ } },
  };
}

function newRoom() {
  if (rooms.size >= MAX_ROOMS) return null;
  let code;
  do { code = randomCode(); } while (rooms.has(code));
  const r = new Room(code);
  rooms.set(code, r);
  return r;
}

wss.on('connection', (ws) => {
  const conn = makeConn(ws);
  ws.conn = conn;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  let count = 0;
  const rate = setInterval(() => { count = 0; }, 1000);

  ws.on('message', (data) => {
    try { onMessage(data); } catch (e) { log('處理訊息時發生錯誤（已忽略，伺服器繼續運作）', e && e.stack ? e.stack : e); }
  });

  function onMessage(data) {
    if (++count > 60) { log(`訊息過於頻繁，斷線 ${who(conn)}`); ws.close(1008, 'rate limit'); return; }
    const msg = parseMsg(data.toString());
    if (!msg) return;
    if (msg.t === 'ping') { conn.send({ t: 'pong', c: msg.c, s: Date.now() }); return; }
    if (conn.room) {
      if (msg.t === 'create' || msg.t === 'join') return; // 已在房間內
      conn.room.handle(conn, msg);
      return;
    }
    if (msg.t === 'create') {
      if (!cleanNick(msg.nick)) { conn.send({ t: 'error', code: 'NICK', msg: '請輸入暱稱' }); return; }
      const room = newRoom();
      if (!room) { conn.send({ t: 'error', code: 'BUSY', msg: '伺服器房間已滿，請稍後再試' }); return; }
      const r = room.join(conn, { playerId: msg.playerId, nick: msg.nick });
      if (r.error) { conn.send({ t: 'error', ...r.error }); rooms.delete(room.code); }
    } else if (msg.t === 'join') {
      const room = rooms.get(normCode(msg.code));
      if (!room) { conn.send({ t: 'error', code: 'NO_ROOM', msg: '找不到這個房間，請確認代碼' }); return; }
      const r = msg.role === 'screen' ? room.joinScreen(conn) : room.join(conn, { playerId: msg.playerId, nick: msg.nick });
      if (r.error) conn.send({ t: 'error', ...r.error });
      else log(`加入 ${who(conn)}`);
    }
  }

  ws.on('close', (code, reason) => {
    clearInterval(rate);
    if (conn.room) {
      log(`斷線 code=${code}${reason && reason.length ? ` reason=${reason}` : ''}${conn.kicked ? ' (被踢/被取代)' : ''} ${who(conn)}`);
      try { conn.room.disconnect(conn); } catch (e) { log('disconnect 發生錯誤', e && e.stack ? e.stack : e); }
    }
  });
  ws.on('error', (e) => { log('連線錯誤', e && e.message); });
});

function who(conn) {
  const r = conn.room;
  if (!r) return '(未進房)';
  return `房間=${r.code} 階段=${r.phase} ${conn.screen ? '主畫面' : `玩家=${conn.player ? conn.player.nick : '?'}`}`;
}

// 心跳：20 秒一次，沒回應就斷線
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { log(`心跳逾時（對方 20 秒內沒回應，常見於手機鎖螢幕／網路中斷）${ws.conn ? who(ws.conn) : ''}`); ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* ignore */ }
  }
}, 20000);

// 每秒：房間 tick，清掉閒置太久的房間
setInterval(() => {
  const now = Date.now();
  for (const [code, r] of rooms) {
    try { r.tick(); } catch (e) { log(`房間 ${code} tick 發生錯誤`, e && e.stack ? e.stack : e); }
    if (r.connectedCount === 0 && now - r.lastActive > ROOM_IDLE_MS) { r.destroy(); rooms.delete(code); log(`房間 ${code} 閒置過久，已清除`); }
  }
}, 1000);

// 任何沒被接住的錯誤（包含房間計時器裡的）只記錄、不讓整個伺服器掛掉（否則所有房間、所有人會一起斷線）
process.on('uncaughtException', (e) => log('未捕捉的錯誤（已忽略，伺服器繼續運作）', e && e.stack ? e.stack : e));
process.on('unhandledRejection', (e) => log('未處理的 Promise 錯誤', e && e.stack ? e.stack : e));

// ===== 房間存檔／還原 =====
let lastSaved = '';
export function saveState() {
  try {
    const body = JSON.stringify([...rooms.values()].map((r) => r.serialize()));
    if (body === lastSaved) return; // 沒變化就不寫檔
    const data = `{"savedAt":${Date.now()},"rooms":${body}}`;
    mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    const tmp = STATE_FILE + '.tmp';
    writeFileSync(tmp, data);
    renameSync(tmp, STATE_FILE); // 先寫暫存再改名，避免寫到一半當機留下壞檔
    lastSaved = body;
  } catch (e) { log('房間存檔失敗', e && e.message); }
}

export function loadState() {
  if (!existsSync(STATE_FILE)) return 0;
  let n = 0;
  try {
    const d = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    const idMap = new Map();
    for (const list of Object.values(bank)) for (const q of list) idMap.set(q.id, q);
    for (const rd of d.rooms || []) {
      try {
        if (!rd.players || !rd.players.length || rooms.has(rd.code)) continue;
        rooms.set(rd.code, Room.restore(rd, idMap));
        n++;
      } catch (e) { log(`還原房間 ${rd && rd.code} 失敗，略過`, e && e.stack ? e.stack : e); }
    }
    log(`已還原 ${n} 個房間（來自 ${new Date(d.savedAt).toISOString()} 的存檔），等待玩家自動重連`);
  } catch (e) { log('讀取房間存檔失敗（忽略，從空的開始）', e && e.message); }
  return n;
}

function shutdown(sig) {
  log(`收到 ${sig}，存檔後關閉（玩家會自動重連）`);
  saveState();
  for (const ws of wss.clients) { try { ws.close(1012, 'server restarting'); } catch { /* ignore */ } }
  setTimeout(() => process.exit(0), 300);
}

export function listen(port = PORT, host = HOST) {
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadState();
  setInterval(saveState, STATE_SAVE_MS);
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  listen().then(() => console.log(`猜歌大賽伺服器已啟動：http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}（WebSocket 路徑 /ws）`));
}
