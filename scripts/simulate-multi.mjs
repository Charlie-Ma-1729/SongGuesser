// 機器人模擬：用真的 WebSocket 連到真的伺服器，跑完一整局，檢查流程與計分。
// 用法：node scripts/simulate-multi.mjs [--bots 6] [--questions 3] [--mode choice|typing] [--score speed|fixed|combo] [--url ws://host:port/ws]
// 沒給 --url 時會在本機隨機 port 啟動伺服器。
import { WebSocket } from 'ws';
import { listen } from '../server/server.mjs';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const N = Number(arg('bots', 6));
const Q = Number(arg('questions', 3));
const MODE = arg('mode', 'choice');
const SCORE = arg('score', 'speed');
let URL_ = arg('url', '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

class Bot {
  constructor(name, skill) {
    this.name = name; this.skill = skill; // skill = 答對機率
    this.ws = new WebSocket(URL_);
    this.msgs = [];
    this.offset = 0;
    this.q = null; this.room = null; this.reveals = 0; this.final = null; this.works = null;
    this.ready = new Promise((res) => this.ws.on('open', res));
    this.ws.on('message', (d) => this.onMsg(JSON.parse(d.toString())));
  }
  send(o) { this.ws.send(JSON.stringify(o)); }
  waitFor(pred, ms = 20000) {
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`${this.name} 等待逾時`)), ms);
      const check = () => { const m = this.msgs.find(pred); if (m) { clearTimeout(t); res(m); } else this._w = check; };
      check();
    });
  }
  async onMsg(m) {
    this.msgs.push(m);
    if (this._w) { const w = this._w; this._w = null; w(); }
    if (m.t === 'joined') { this.id = m.playerId; this.code = m.code; }
    else if (m.t === 'room') this.room = m;
    else if (m.t === 'works') this.works = m.list;
    else if (m.t === 'pong') this.offset = m.s - (m.c + Date.now()) / 2;
    else if (m.t === 'question') { this.q = m; await sleep(100 + Math.random() * 300); this.send({ t: 'ready', idx: m.idx }); }
    else if (m.t === 'go') this.onGo(m);
    else if (m.t === 'reveal') this.reveals++;
    else if (m.t === 'final') this.final = m;
    else if (m.t === 'error') log(this.name, '錯誤', m.msg);
  }
  async onGo(go) {
    const q = this.q;
    const wait = go.startAt - (Date.now() + this.offset);
    await sleep(Math.max(0, wait));
    const t = Date.now();
    await sleep(600 + Math.random() * 3000 * (1 - this.skill / 2));
    if (this.q !== q) return;
    const right = Math.random() < this.skill;
    const msg = { t: 'lock', idx: q.idx, elapsedMs: Date.now() - t };
    if (q.choices) msg.choice = Math.floor(Math.random() * q.choices.length); else msg.key = 'guess-' + Math.floor(Math.random() * 5);
    this.guessRight = right; // 機器人看不到答案；這裡只隨機亂猜，正確率由運氣決定
    this.send(msg);
  }
}

async function main() {
  let srv = null;
  if (!URL_) {
    srv = await listen(0, '127.0.0.1');
    URL_ = `ws://127.0.0.1:${srv.address().port}/ws`;
  }
  log('連線到', URL_);
  const bots = Array.from({ length: N }, (_, i) => new Bot('機器人' + (i + 1), 0.3 + 0.6 * (i / Math.max(1, N - 1))));
  await Promise.all(bots.map((b) => b.ready));
  for (const b of bots) b.send({ t: 'ping', c: Date.now() });
  await sleep(200);

  const host = bots[0];
  host.send({ t: 'create', nick: host.name });
  const joined = await host.waitFor((m) => m.t === 'joined');
  log('房間', joined.code);
  for (const b of bots.slice(1)) { b.send({ t: 'join', code: joined.code, nick: b.name }); await sleep(30); }
  await sleep(300);
  log('房內人數', host.room.players.length);
  if (host.room.players.length !== N) throw new Error('人數不對');

  host.send({ t: 'settings', settings: { categories: ['anime'], count: Q, duration: 5, graceSecs: 0, quorumMode: 'half', quorumSecs: 3, answerMode: MODE, scoreMode: SCORE } });
  await sleep(200);
  host.send({ t: 'start' });

  for (let i = 1; i <= Q; i++) {
    const rv = await host.waitFor((m) => m.t === 'reveal' && m.idx === i, 30000);
    const right = rv.rows.filter((r) => r.correct).length;
    log(`第 ${i}/${Q} 題揭曉（${rv.reason}）：「${rv.answer.work}」答對 ${right}/${rv.rows.length}，前三名：${rv.ranking.slice(0, 3).map((r) => `${r.nick} ${r.score}`).join('、')}`);
    await sleep(200);
    host.send({ t: 'next' });
  }
  const fin = await host.waitFor((m) => m.t === 'final', 15000);
  log('最終排行：');
  for (const r of fin.ranking) console.log(`  ${r.rank}. ${r.nick}  ${r.score} 分（答對 ${r.correct}/${r.answered}${r.avgMs != null ? `，平均 ${(r.avgMs / 1000).toFixed(1)}s` : ''}）`);

  // 檢查：每個機器人都收到同樣的揭曉次數與最終榜
  await sleep(500);
  const bad = bots.filter((b) => b.reveals !== Q || !b.final);
  if (bad.length) throw new Error('有機器人沒收到完整訊息：' + bad.map((b) => `${b.name}(reveal ${b.reveals})`).join(','));
  const sums = new Set(bots.map((b) => JSON.stringify(b.final.ranking)));
  if (sums.size !== 1) throw new Error('各機器人看到的排行榜不一致');
  log(`✅ 模擬完成：${N} 位機器人，${Q} 題，全部收到相同的最終排行榜`);
  bots.forEach((b) => b.ws.close());
  if (srv) srv.close();
  process.exit(0);
}

main().catch((e) => { console.error('❌', e.message); process.exit(1); });
