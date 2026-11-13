// 猜歌大賽多人伺服器：靜態檔（白名單）+ WebSocket（/ws）+ /healthz
// 環境變數：PORT（6713）、HOST（0.0.0.0）、ALLOWED_ORIGINS（逗號分隔，例如 https://yourname.github.io）、MAX_ROOMS（200）
import http from 'node:http';
import { readFileSync, statSync } from 'node:fs';
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
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  let count = 0;
  const rate = setInterval(() => { count = 0; }, 1000);

  ws.on('message', (data) => {
    if (++count > 60) { ws.close(1008, 'rate limit'); return; }
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
    }
  });

  ws.on('close', () => {
    clearInterval(rate);
    if (conn.room) conn.room.disconnect(conn);
  });
  ws.on('error', () => { /* close 事件會處理 */ });
});

// 心跳：20 秒一次，沒回應就斷線
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* ignore */ }
  }
}, 20000);

// 每秒：房間 tick，清掉閒置太久的房間
setInterval(() => {
  const now = Date.now();
  for (const [code, r] of rooms) {
    r.tick();
    if (r.connectedCount === 0 && now - r.lastActive > ROOM_IDLE_MS) { r.destroy(); rooms.delete(code); }
  }
}, 1000);

export function listen(port = PORT, host = HOST) {
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  listen().then(() => console.log(`猜歌大賽伺服器已啟動：http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}（WebSocket 路徑 /ws）`));
}
