// 房間與回合狀態機（伺服器權威）
// 階段：lobby → preload → playing → reveal → (preload …) → final → (again) lobby
import { randomBytes } from 'node:crypto';
import { buildQueue, buildChoices } from '../js/questions.js';
import { scoreAnswer, rankPlayers } from '../js/scoring.js';
import { bank, works, keyOf } from './bank.mjs';
import { DEFAULT_SETTINGS, MAX_PLAYERS, MAX_SCREENS, cleanSettings, cleanNick, cleanId } from './protocol.mjs';

export const TIMING = {
  preloadMs: 8000, // 等所有人預載的上限
  goDelayMs: 1500, // 發出「開播」到真正開播的間隔
  lagMs: 4000, // 硬性截止：作答窗口結束後再多等的延遲容忍
  staleMs: 10000, // 斷線超過這麼久就不算進「鎖定人數」分母
  lobbyDropMs: 10 * 60 * 1000, // 大廳中斷線超過這麼久才移出（手機鎖螢幕、切 App 都不該被踢）
  dropMs: 60 * 60 * 1000, // 遊戲中斷線的玩家保留這麼久（分數、連對都保留）；離線者不會卡住別人（見 staleMs）
  hostReturnMs: 60000, // 房主斷線後這段時間內回來，可以拿回房主
  restoreGraceMs: 12000, // 伺服器重啟還原後，給大家重連的緩衝（倒數／截止至少再等這麼久）
};

const newId = () => randomBytes(12).toString('base64url');

/** 打字搜尋用的作品清單（所選題庫的所有作品，不含本題答案資訊） */
function buildWorks(s) {
  const wl = [];
  const seen = new Set();
  for (const c of s.categories) for (const w of works[c] || []) if (!seen.has(w.k)) { seen.add(w.k); wl.push(w); }
  return wl;
}

const PLAYER_KEYS = ['id', 'nick', 'score', 'correct', 'answered', 'totalMs', 'streak', 'eligible', 'spectator', 'ready', 'failed', 'selection', 'lock', 'joinedAt'];

export class Room {
  constructor(code, timing = {}) {
    this.code = code;
    this.T = { ...TIMING, ...timing };
    this.phase = 'lobby';
    this.hostId = null;
    this.settings = { ...DEFAULT_SETTINGS };
    this.players = new Map(); // id → Player
    this.screens = new Set(); // conn
    this.banned = new Set();
    this.game = null;
    this.timers = {};
    this.lastReveal = null;
    this.lastFinal = null;
    this.lastActive = Date.now();
  }

  // ===== 連線 =====
  /** 加入或重連。回傳 {player} 或 {error:{code,msg}} */
  join(conn, { playerId, nick }) {
    const id = cleanId(playerId);
    let p = id ? this.players.get(id) : null;
    if (!p) {
      // 沒有（或找不到）playerId，但有「同暱稱而且目前離線」的座位 → 視為同一個人回來
      // （分頁被關掉、手機把網頁殺掉後重新開連結，就能接回原本的分數）
      const name = cleanNick(nick);
      if (name) p = [...this.players.values()].find((x) => !x.connected && x.nick.toLowerCase() === name.toLowerCase()) || null;
    }
    if (p) { // 重連
      if (p.conn && p.conn !== conn) { try { p.conn.kicked = true; p.conn.close(); } catch { /* ignore */ } }
      p.conn = conn; p.connected = true; p.lastSeen = Date.now();
      if (this.prevHost && this.prevHost.id === p.id && Date.now() - this.prevHost.at < this.T.hostReturnMs) this.hostId = p.id;
      this.prevHost = null;
    } else {
      if (id && this.banned.has(id)) return { error: { code: 'BANNED', msg: '你已被房主移出這個房間' } };
      const name = cleanNick(nick);
      if (!name) return { error: { code: 'NICK', msg: '請輸入暱稱' } };
      if (this.players.size >= MAX_PLAYERS) return { error: { code: 'FULL', msg: `房間已滿（${MAX_PLAYERS} 人）` } };
      if (this.phase !== 'lobby' && !this.settings.allowLateJoin) return { error: { code: 'STARTED', msg: '遊戲已開始，房主不允許中途加入' } };
      p = {
        id: id || newId(), nick: this._uniqueNick(name), conn, connected: true, lastSeen: Date.now(), joinedAt: Date.now(),
        score: 0, correct: 0, answered: 0, totalMs: 0, streak: 0,
        eligible: false, spectator: this.phase !== 'lobby', ready: false, failed: false, selection: null, lock: null,
      };
      this.players.set(p.id, p);
      if (!this.hostId) this.hostId = p.id;
    }
    conn.room = this; conn.player = p; conn.screen = false;
    this.lastActive = Date.now();
    this._ensureHost();
    this._snapshot(conn, p);
    this._broadcastRoom();
    return { player: p };
  }

  joinScreen(conn) {
    if (this.screens.size >= MAX_SCREENS) return { error: { code: 'FULL', msg: '主畫面數量已達上限' } };
    conn.room = this; conn.screen = true; conn.player = null; conn.ready = false;
    this.screens.add(conn);
    this.lastActive = Date.now();
    this._snapshot(conn, null);
    this._broadcastRoom();
    return { screen: true };
  }

  disconnect(conn) {
    if (conn.screen) {
      this.screens.delete(conn);
      this._broadcastRoom();
      this._checkBarrier();
      return;
    }
    const p = conn.player;
    if (!p || p.conn !== conn) return; // 已被新連線取代
    p.connected = false; p.conn = null; p.lastSeen = Date.now();
    this._ensureHost();
    this._broadcastRoom();
    this._checkBarrier();
    this._checkProgress();
  }

  _uniqueNick(base) {
    const taken = new Set([...this.players.values()].map((p) => p.nick.toLowerCase()));
    if (!taken.has(base.toLowerCase())) return base;
    for (let i = 2; i < 100; i++) {
      const n = `${[...base].slice(0, 12 - String(i).length).join('')}${i}`;
      if (!taken.has(n.toLowerCase())) return n;
    }
    return base + newId().slice(0, 2);
  }

  _ensureHost() {
    const h = this.players.get(this.hostId);
    if (h && h.connected) return;
    const next = [...this.players.values()].filter((p) => p.connected).sort((a, b) => a.joinedAt - b.joinedAt)[0];
    if (next && next.id !== this.hostId) {
      if (h) this.prevHost = { id: h.id, at: Date.now() }; // 原房主若很快回來（例如重新整理），把房主還給他
      this.hostId = next.id;
    }
  }

  // ===== 傳送 =====
  _send(conn, msg) { try { conn.send(msg); } catch { /* ignore */ } }
  _broadcast(msg) {
    for (const p of this.players.values()) if (p.conn) this._send(p.conn, msg);
    for (const s of this.screens) this._send(s, msg);
  }

  isActive(p) {
    return p.eligible && !p.failed && (p.connected || Date.now() - p.lastSeen <= this.T.staleMs);
  }

  _roomMsg() {
    const act = this.phase === 'playing' ? [...this.players.values()].filter((p) => this.isActive(p)) : [];
    const g = this.game;
    return {
      t: 'room', code: this.code, phase: this.phase, hostId: this.hostId, settings: this.settings,
      idx: g ? g.idx : 0, total: g ? g.total : 0, screens: this.screens.size,
      locked: act.filter((p) => p.lock).length, active: act.length,
      players: [...this.players.values()].map((p) => ({
        id: p.id, nick: p.nick, connected: p.connected, score: p.score,
        locked: !!p.lock, ready: p.ready, spectator: p.spectator, failed: p.failed,
      })),
    };
  }
  _broadcastRoom() { this._broadcast(this._roomMsg()); }

  /** 加入／重連時，把目前狀態補給該連線 */
  _snapshot(conn, p) {
    const counts = Object.fromEntries(Object.entries(bank).map(([k, v]) => [k, v.length]));
    this._send(conn, { t: 'joined', code: this.code, role: p ? 'player' : 'screen', playerId: p ? p.id : null, serverNow: Date.now(), counts });
    this._send(conn, this._roomMsg());
    const g = this.game;
    if (!g) return;
    if (this.settings.answerMode === 'typing') this._send(conn, { t: 'works', list: g.works });
    if (this.phase === 'preload' || this.phase === 'playing' || this.phase === 'reveal') {
      this._send(conn, g.qMsg);
      if (g.goMsg) this._send(conn, g.goMsg);
      if (g.t0 != null) this._send(conn, { t: 't0', idx: g.idx, t0: g.t0 });
      if (g.quorumEndsAt) this._send(conn, { t: 'quorum', idx: g.idx, endsAt: g.quorumEndsAt });
      if (p) this._send(conn, { t: 'you', idx: g.idx, selection: p.selection, locked: !!p.lock, failed: p.failed });
    }
    if (this.phase === 'reveal' && this.lastReveal) this._send(conn, this.lastReveal);
    if (this.phase === 'final' && this.lastFinal) this._send(conn, this.lastFinal);
  }

  // ===== 訊息處理 =====
  handle(conn, msg) {
    const p = conn.player;
    const isHost = p && p.id === this.hostId;
    this.lastActive = Date.now();
    if (p) p.lastSeen = Date.now();
    if (conn.screen) return this._handleScreen(conn, msg);
    if (!p) return;
    switch (msg.t) {
      case 'settings': if (isHost && this.phase === 'lobby') { this.settings = cleanSettings(msg.settings, this.settings); this._broadcastRoom(); } break;
      case 'start': if (isHost && this.phase === 'lobby') this._start(conn); break;
      case 'ready': if (this._cur(msg) && this.phase === 'preload') { p.ready = true; this._checkBarrier(); this._broadcastRoom(); } break;
      case 'select': if (this._cur(msg)) this._select(p, msg); break;
      case 'lock': if (this._cur(msg)) this._lock(p, msg); break;
      case 'playError': if (this._cur(msg)) this._playError(p); break;
      case 'next': if (isHost && this.phase === 'reveal') this._nextQuestion(); break;
      case 'skip': if (isHost && (this.phase === 'preload' || this.phase === 'playing')) this._skipQuestion('房主跳過本題'); break;
      case 'forceReveal': if (isHost && this.phase === 'playing') this._reveal('host'); break;
      case 'end': if (isHost && this.phase !== 'lobby' && this.phase !== 'final') this._final(); break;
      case 'again': if (isHost && this.phase === 'final') this._again(); break;
      case 'kick': if (isHost) this._kick(String(msg.id || '')); break;
      case 'leave': this._remove(p.id); break;
      default: break;
    }
  }

  _handleScreen(conn, msg) {
    if (msg.t === 'ready' && this._cur(msg) && this.phase === 'preload') { conn.ready = true; this._checkBarrier(); }
    else if (msg.t === 'playing' && this._cur(msg) && this.phase === 'playing') this._screenPlaying();
    else if (msg.t === 'playError' && this._cur(msg) && (this.phase === 'preload' || this.phase === 'playing')) this._skipQuestion('主畫面無法播放這首影片');
  }

  /** 訊息帶的題號必須是目前這題（避免延遲的舊訊息） */
  _cur(msg) { return this.game && msg.idx === this.game.idx; }

  // ===== 開始遊戲 =====
  _start(conn) {
    const s = this.settings;
    if (s.playMode === 'screen' && this.screens.size === 0) return this._send(conn, { t: 'error', code: 'NO_SCREEN', msg: '「主畫面播放」需要先開啟主畫面（用另一個分頁／裝置加入並選「作為主畫面」）' });
    const catOf = new Map();
    const pool = [];
    for (const c of s.categories) for (const q of bank[c] || []) { catOf.set(q.id, c); pool.push(q); }
    const queue = buildQueue(pool, { kinds: s.kinds, maxDifficulty: s.difficulty, maxPerWork: s.perWork, count: s.count });
    if (queue.length === 0) return this._send(conn, { t: 'error', code: 'EMPTY', msg: '符合條件的題目是 0 首，請放寬設定' });
    const wl = s.answerMode === 'typing' ? buildWorks(s) : [];
    for (const p of this.players.values()) { p.score = 0; p.correct = 0; p.answered = 0; p.totalMs = 0; p.streak = 0; p.spectator = false; }
    this.game = { queue, catOf, idx: 0, total: Math.min(s.count, queue.length), works: wl, q: null };
    this.lastReveal = null; this.lastFinal = null;
    if (s.answerMode === 'typing') this._broadcast({ t: 'works', list: wl });
    this._nextQuestion();
  }

  _clearTimers() {
    for (const k of Object.keys(this.timers)) { clearTimeout(this.timers[k]); delete this.timers[k]; }
  }

  _nextQuestion({ replace = false } = {}) {
    this._clearTimers();
    const g = this.game;
    const s = this.settings;
    if (replace) g.idx--;
    let q; let choices = null; let cat;
    for (;;) {
      if (g.idx >= g.total || g.queue.length === 0) return this._final();
      q = g.queue.shift();
      cat = g.catOf.get(q.id);
      if (s.answerMode === 'choice') {
        choices = buildChoices(q, bank[cat] || [], cat, { maxDifficulty: s.difficulty });
        if (!choices) continue; // 題庫太小湊不出選項 → 換下一題
      }
      break;
    }
    g.idx++;
    g.q = q; g.choices = choices; g.cat = cat;
    g.correctIdx = choices ? choices.findIndex((c) => c.correct) : -1;
    g.correctKey = keyOf(q, cat);
    g.startAt = null; g.t0 = null; g.goMsg = null; g.quorumEndsAt = null;
    g.windowMs = (s.duration + s.graceSecs) * 1000;
    for (const p of this.players.values()) {
      p.spectator = false; p.eligible = true; p.ready = false; p.failed = false; p.selection = null; p.lock = null;
    }
    for (const sc of this.screens) sc.ready = false;
    g.qMsg = {
      t: 'question', idx: g.idx, total: g.total, ytId: q.ytId,
      start: (s.fromMiddle && q.mid != null ? q.mid : q.start) || 0,
      duration: s.duration, graceSecs: s.graceSecs, kind: q.kind, prompt: q.prompt,
      choices: choices ? choices.map(({ main, sub }) => ({ main, sub })) : null,
      answerMode: s.answerMode, playMode: s.playMode,
    };
    this.phase = 'preload';
    this._broadcast(g.qMsg);
    this._broadcastRoom();
    this.timers.preload = setTimeout(() => this._go(), this.T.preloadMs);
    this._checkBarrier();
  }

  /** 準備同步屏障：所有「該載入影片的人」都 ready 就開播 */
  _checkBarrier() {
    if (this.phase !== 'preload') return;
    const s = this.settings;
    let all;
    if (s.playMode === 'screen') all = this.screens.size > 0 && [...this.screens].every((c) => c.ready);
    else {
      const act = [...this.players.values()].filter((p) => this.isActive(p));
      all = act.every((p) => p.ready);
    }
    if (all) this._go();
  }

  _go() {
    if (this.phase !== 'preload') return;
    clearTimeout(this.timers.preload);
    const g = this.game;
    g.startAt = Date.now() + this.T.goDelayMs;
    g.goMsg = { t: 'go', idx: g.idx, startAt: g.startAt, serverNow: Date.now() };
    this.phase = 'playing';
    this._broadcast(g.goMsg);
    this._broadcastRoom();
    this.timers.hard = setTimeout(() => this._reveal('time'), g.startAt + g.windowMs + this.T.lagMs - Date.now());
    this._checkProgress();
  }

  /** 主畫面模式：以主畫面「真正開播」的時刻為全員的 t0 */
  _screenPlaying() {
    const g = this.game;
    if (g.t0 != null) return;
    g.t0 = Date.now();
    this._broadcast({ t: 't0', idx: g.idx, t0: g.t0 });
  }

  // ===== 作答 =====
  _validAnswer(msg) {
    const g = this.game;
    if (this.settings.answerMode === 'choice') {
      const c = msg.choice;
      return Number.isInteger(c) && c >= 0 && c < g.choices.length ? { choice: c } : null;
    }
    return typeof msg.key === 'string' && msg.key.length > 0 && msg.key.length < 80 ? { key: msg.key } : null;
  }
  _isCorrect(a) {
    const g = this.game;
    return a.choice !== undefined ? a.choice === g.correctIdx : a.key === g.correctKey;
  }
  _label(a) {
    const g = this.game;
    if (a.choice !== undefined) return g.choices[a.choice].main;
    const w = (g.works || []).find((x) => x.k === a.key);
    return w ? w.main : '';
  }

  _select(p, msg) {
    if ((this.phase !== 'preload' && this.phase !== 'playing') || !p.eligible || p.lock || p.failed) return;
    const a = this._validAnswer(msg);
    if (a) p.selection = a;
  }

  _lock(p, msg) {
    if (this.phase !== 'playing' || !p.eligible || p.lock || p.failed) return;
    const a = this._validAnswer(msg);
    if (!a) return;
    const g = this.game;
    const now = Date.now();
    let elapsed;
    if (this.settings.playMode === 'screen') elapsed = now - (g.t0 ?? g.startAt);
    else elapsed = Math.max(0, Math.min(Number(msg.elapsedMs) || 0, now - g.startAt + 300)); // 夾上限：不能比伺服器看到的更久
    elapsed = Math.max(0, Math.min(elapsed, g.windowMs));
    p.selection = a;
    p.lock = { ...a, elapsed, correct: this._isCorrect(a) };
    this._broadcastRoom();
    this._checkProgress();
  }

  _playError(p) {
    if (this.phase !== 'preload' && this.phase !== 'playing') return;
    if (!p.eligible || p.failed) return;
    p.failed = true; p.ready = true;
    const el = [...this.players.values()].filter((x) => x.eligible && (x.connected || Date.now() - x.lastSeen <= this.T.staleMs));
    const failed = el.filter((x) => x.failed).length;
    if (this.settings.playMode === 'own' && failed * 2 >= el.length) return this._skipQuestion('多數玩家無法播放這首影片');
    this._broadcastRoom();
    this._checkBarrier();
    this._checkProgress();
  }

  /** 每次鎖定／失敗／離線後檢查：全員鎖定 → 揭曉；達門檻 → 開始倒數 */
  _checkProgress() {
    if (this.phase !== 'playing') return;
    const g = this.game;
    const act = [...this.players.values()].filter((p) => this.isActive(p));
    if (act.length === 0) return;
    const locked = act.filter((p) => p.lock).length;
    if (locked === act.length) return this._reveal('all');
    const s = this.settings;
    if (g.quorumEndsAt || s.quorumMode === 'off' || locked === 0) return;
    const need = s.quorumMode === 'all' ? act.length
      : s.quorumMode === 'half' ? Math.floor(act.length / 2) + 1
        : Math.min(s.quorumN, act.length);
    if (locked >= need) {
      g.quorumEndsAt = Date.now() + s.quorumSecs * 1000;
      this.timers.quorum = setTimeout(() => this._reveal('quorum'), s.quorumSecs * 1000);
      this._broadcast({ t: 'quorum', idx: g.idx, endsAt: g.quorumEndsAt, serverNow: Date.now() });
    }
  }

  // ===== 揭曉與計分 =====
  _reveal(reason) {
    if (this.phase !== 'playing') return;
    this._clearTimers();
    const g = this.game;
    const s = this.settings;
    const rows = [];
    for (const p of this.players.values()) {
      if (!p.eligible) continue;
      let answered = false; let correct = false; let elapsed = g.windowMs; let pick = null;
      if (p.lock) { answered = true; correct = p.lock.correct; elapsed = p.lock.elapsed; pick = p.lock; }
      else if (p.selection && !p.failed) { answered = true; correct = this._isCorrect(p.selection); pick = p.selection; } // 已選未鎖定 → 以最慢速度計入
      let points = 0;
      if (!p.failed) {
        const r = scoreAnswer({ correct, answered, elapsedMs: elapsed, windowMs: g.windowMs, mode: s.scoreMode, streak: p.streak, penalty: s.penalty });
        points = r.points; p.streak = r.streak;
        p.score += points;
        if (answered) p.answered++;
        if (correct) { p.correct++; p.totalMs += elapsed; }
      }
      rows.push({ id: p.id, nick: p.nick, answered, correct, failed: p.failed, points, total: p.score, streak: p.streak, pick: pick ? this._label(pick) : null, ms: answered ? Math.round(elapsed) : null });
    }
    const ranking = this._ranking();
    this.phase = 'reveal';
    this.lastReveal = {
      t: 'reveal', idx: g.idx, total: g.total, reason, last: g.idx >= g.total,
      answer: g.q.answer, kind: g.q.kind, revealStart: g.q.revealStart ?? null, ytId: g.q.ytId,
      correct: g.correctIdx >= 0 ? { index: g.correctIdx } : { key: g.correctKey },
      rows, ranking, nextAt: s.autoNext > 0 ? Date.now() + s.autoNext * 1000 : null, serverNow: Date.now(),
    };
    this._broadcast(this.lastReveal);
    this._broadcastRoom();
    if (s.autoNext > 0) this.timers.next = setTimeout(() => this._nextQuestion(), s.autoNext * 1000);
  }

  _ranking() {
    return rankPlayers([...this.players.values()].map((p) => ({ id: p.id, nick: p.nick, score: p.score, correct: p.correct, answered: p.answered, totalMs: p.totalMs })));
  }

  /** 本題作廢（影片壞掉／房主跳過）：不計分，換備用題 */
  _skipQuestion(reason) {
    if (this.phase !== 'preload' && this.phase !== 'playing') return;
    this._clearTimers();
    this._broadcast({ t: 'skipped', idx: this.game.idx, reason });
    this._nextQuestion({ replace: true });
  }

  _final() {
    this._clearTimers();
    this.phase = 'final';
    this.lastFinal = { t: 'final', total: this.game ? this.game.idx : 0, ranking: this._ranking() };
    this._broadcast(this.lastFinal);
    this._broadcastRoom();
  }

  _again() {
    this._clearTimers();
    this.game = null; this.lastReveal = null; this.lastFinal = null;
    this.phase = 'lobby';
    for (const p of this.players.values()) {
      p.score = 0; p.correct = 0; p.answered = 0; p.totalMs = 0; p.streak = 0;
      p.eligible = false; p.spectator = false; p.ready = false; p.failed = false; p.selection = null; p.lock = null;
    }
    this._broadcastRoom();
  }

  // ===== 房主管理 =====
  _kick(id) {
    const p = this.players.get(id);
    if (!p || p.id === this.hostId) return;
    this.banned.add(p.id);
    if (p.conn) { this._send(p.conn, { t: 'kicked' }); p.conn.kicked = true; try { p.conn.close(); } catch { /* ignore */ } }
    this._remove(p.id);
  }

  _remove(id) {
    const p = this.players.get(id);
    if (!p) return;
    this.players.delete(id);
    if (p.conn) { p.conn.kicked = true; p.conn.player = null; try { p.conn.close(); } catch { /* ignore */ } }
    this._ensureHost();
    this._broadcastRoom();
    this._checkBarrier();
    this._checkProgress();
  }

  /** 每秒呼叫：清掉斷線太久的人、重新檢查鎖定／準備狀態（因為「離線 10 秒」是隨時間變化的） */
  tick() {
    const now = Date.now();
    for (const p of [...this.players.values()]) {
      if (p.connected) continue;
      const limit = this.phase === 'lobby' ? this.T.lobbyDropMs : this.T.dropMs;
      if (now - p.lastSeen > limit) this._remove(p.id);
    }
    if (this.phase === 'preload') this._checkBarrier();
    if (this.phase === 'playing') this._checkProgress();
  }

  // ===== 重啟不斷線：把房間存成 JSON、重啟後還原 =====
  /** 可 JSON 化的完整房間狀態（不含連線物件與計時器） */
  serialize() {
    const g = this.game;
    return {
      code: this.code, phase: this.phase, hostId: this.hostId, settings: this.settings, banned: [...this.banned],
      lastReveal: this.lastReveal, lastFinal: this.lastFinal,
      players: [...this.players.values()].map((p) => Object.fromEntries(PLAYER_KEYS.map((k) => [k, p[k]]))),
      game: g && {
        idx: g.idx, total: g.total, qId: g.q ? g.q.id : null, queueIds: g.queue.map((q) => q.id),
        catOf: Object.fromEntries([...g.queue, ...(g.q ? [g.q] : [])].map((q) => [q.id, g.catOf.get(q.id)])),
        choices: g.choices, correctIdx: g.correctIdx, correctKey: g.correctKey, cat: g.cat,
        startAt: g.startAt, t0: g.t0, goMsg: g.goMsg, qMsg: g.qMsg, quorumEndsAt: g.quorumEndsAt, windowMs: g.windowMs,
      },
    };
  }

  /** 由 serialize() 的資料還原房間；所有玩家先視為離線，等他們的瀏覽器自動重連後接回 */
  static restore(d, idMap, timing = {}) {
    const r = new Room(d.code, timing);
    r.phase = d.phase; r.hostId = d.hostId;
    r.settings = cleanSettings(d.settings, DEFAULT_SETTINGS);
    r.banned = new Set(d.banned || []);
    r.lastReveal = d.lastReveal || null; r.lastFinal = d.lastFinal || null;
    const now = Date.now();
    for (const p of d.players || []) {
      r.players.set(p.id, { ...p, conn: null, connected: false, lastSeen: now, joinedAt: p.joinedAt || now });
    }
    const gd = d.game;
    if (gd) {
      const q = gd.qId ? idMap.get(gd.qId) : null;
      const inQuestion = ['preload', 'playing', 'reveal'].includes(d.phase);
      if (inQuestion && !q) { r.phase = 'lobby'; r.game = null; r.lastReveal = null; } // 題庫已更新、那題不見了：回大廳
      else {
        r.game = {
          queue: (gd.queueIds || []).map((id) => idMap.get(id)).filter(Boolean),
          catOf: new Map(Object.entries(gd.catOf || {})),
          idx: gd.idx, total: gd.total, q, works: r.settings.answerMode === 'typing' ? buildWorks(r.settings) : [],
          choices: gd.choices, correctIdx: gd.correctIdx, correctKey: gd.correctKey, cat: gd.cat,
          startAt: gd.startAt, t0: gd.t0, goMsg: gd.goMsg, qMsg: gd.qMsg, quorumEndsAt: gd.quorumEndsAt, windowMs: gd.windowMs,
        };
      }
    }
    if (!r.game && r.phase !== 'lobby' && r.phase !== 'final') r.phase = 'lobby';
    r._rearm();
    return r;
  }

  /** 還原後重新排計時器。給大家一點重連的緩衝時間（至少 restoreGraceMs），避免剛重啟就被判時間到 */
  _rearm() {
    const g = this.game;
    const now = Date.now();
    const grace = this.T.restoreGraceMs;
    this.lastActive = now;
    if (this.phase === 'preload') {
      this.timers.preload = setTimeout(() => this._go(), this.T.preloadMs);
    } else if (this.phase === 'playing') {
      const hard = Math.max(g.startAt + g.windowMs + this.T.lagMs - now, grace);
      this.timers.hard = setTimeout(() => this._reveal('time'), hard);
      if (g.quorumEndsAt) {
        g.quorumEndsAt = Math.max(g.quorumEndsAt, now + grace);
        this.timers.quorum = setTimeout(() => this._reveal('quorum'), g.quorumEndsAt - now);
      }
    } else if (this.phase === 'reveal' && this.settings.autoNext > 0) {
      const at = Math.max((this.lastReveal && this.lastReveal.nextAt) || 0, now + 5000);
      if (this.lastReveal) this.lastReveal.nextAt = at;
      this.timers.next = setTimeout(() => this._nextQuestion(), at - now);
    }
  }

  get connectedCount() {
    return [...this.players.values()].filter((p) => p.connected).length + this.screens.size;
  }

  destroy() { this._clearTimers(); }
}
