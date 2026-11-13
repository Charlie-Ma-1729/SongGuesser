// 多人模式用戶端：加入／建立房間、大廳、各自播放、鎖定、揭曉、排行榜
import { Net } from './net.js';
import { wsUrl } from '../config.js';
import { sharedPlayer } from '../player.js';
import * as ui from '../ui.js';
import { readForm, fillForm, renderPlayers, renderFinal, renderReveal } from './lobby.js';

const $ = (id) => document.getElementById(id);
const SS_KEY = 'songguesser-mp'; // sessionStorage：{code, pid, nick, role}（每個分頁各自一份，重新整理可回座）
const NICK_KEY = 'songguesser-nick';

const S = {
  net: null, role: null, pid: null, code: null, nick: '', counts: {}, pending: null,
  room: null, hostId: null,
  works: [], q: null, phase: 'lobby', windowMs: 0,
  sel: -1, selKey: null, selLabel: '', locked: false, canAnswer: false,
  localT0: null, t0Server: null, quorumEndsAt: null, nextAt: null, reveal: null,
  player: null, activated: false, activateTimer: null, goTimer: null,
  tickTimer: null, lastRankRows: null,
};
let deps = { getVolume: () => 80, stopSingle: () => {} };

const isHost = () => S.role === 'player' && S.pid && S.pid === S.hostId;
const isScreen = () => S.role === 'screen';
/** 這台裝置要不要載入 YouTube：主畫面一定要；玩家只有「各自播放」才要 */
const needsVideo = () => isScreen() || (S.q && S.q.playMode === 'own');

function saveSession() {
  try { sessionStorage.setItem(SS_KEY, JSON.stringify({ code: S.code, pid: S.pid, nick: S.nick, role: S.role })); } catch { /* ignore */ }
}
function loadSession() {
  try { return JSON.parse(sessionStorage.getItem(SS_KEY) || 'null'); } catch { return null; }
}
function clearSession() { try { sessionStorage.removeItem(SS_KEY); } catch { /* ignore */ } }

function showMsg(id, text) { const e = $(id); if (e) e.textContent = text || ''; }
const inviteLink = () => `${location.origin}${location.pathname}?room=${S.code}`;

// ===================== 連線 =====================
function connect(pending) {
  S.pending = pending;
  if (S.net) S.net.close();
  showMsg('m-msg', '連線中…');
  S.net = new Net(wsUrl(), {
    onOpen: () => {
      $('netbar').classList.add('hidden');
      showMsg('m-msg', '');
      // 重連時用 session 的 playerId 回座；第一次則送 create / join
      const msg = S.code && (S.pid || S.role === 'screen') ? { t: 'join', code: S.code, playerId: S.pid, nick: S.nick, role: S.role } : S.pending;
      if (msg) S.net.send(msg);
    },
    onClose: () => { if (S.code && S.net) $('netbar').classList.remove('hidden'); }, // 已在房間裡斷線：顯示「重新連線中」
    onFail: () => showMsg('m-msg', '連不上多人伺服器。多人模式需要有 Node 伺服器（請見 README），或確認網址與網路。'),
    onMessage: handle,
  });
  S.net.connect();
}

function leaveRoom(silent = false) {
  if (S.net) { S.net.send({ t: 'leave' }); S.net.close(); }
  $('netbar').classList.add('hidden');
  S.net = null; S.code = null; S.pid = null; S.room = null; S.q = null; S.phase = 'lobby'; S.role = null;
  clearTimeout(S.goTimer); clearTimeout(S.activateTimer); clearInterval(S.tickTimer);
  S.tickTimer = null;
  if (S.player) { S.player.stop(); }
  clearSession();
  document.body.classList.remove('multi', 'is-host', 'is-screen');
  document.querySelector('.stage').classList.remove('mp', 'mp-screenmode');
  history.replaceState(null, '', location.pathname);
  if (!silent) ui.showScreen('setup');
}

// ===================== 訊息 =====================
function handle(m) {
  switch (m.t) {
    case 'joined': return onJoined(m);
    case 'room': return onRoom(m);
    case 'works': S.works = m.list.map((w) => ({ ...w, n: norm(w.main + ' ' + w.sub) })); return;
    case 'question': return onQuestion(m);
    case 'go': return onGo(m);
    case 't0': if (S.q && m.idx === S.q.idx) S.t0Server = m.t0; return;
    case 'quorum': if (S.q && m.idx === S.q.idx) S.quorumEndsAt = m.endsAt; return;
    case 'you': return onYou(m);
    case 'reveal': return onReveal(m);
    case 'skipped': ui.toast(`本題略過：${m.reason}`, true); return;
    case 'final': return onFinal(m);
    case 'kicked': alert('你已被房主移出房間'); leaveRoom(); return;
    case 'error': return onError(m);
    default: return;
  }
}

function onError(m) {
  if (['NO_ROOM', 'NICK', 'FULL', 'STARTED', 'BANNED', 'BUSY'].includes(m.code)) {
    // 加入失敗：回到加入畫面顯示原因
    const had = S.code;
    $('netbar').classList.add('hidden');
    if (S.net) S.net.close();
    S.net = null; S.code = null; S.pid = null;
    if (had) clearSession();
    ui.showScreen('mjoin');
    showMsg('m-msg', m.msg);
    return;
  }
  if (document.querySelector('#screen-mlobby.active')) showMsg('l-msg', m.msg);
  else ui.toast(m.msg, true);
}

function onJoined(m) {
  S.code = m.code; S.role = m.role; S.counts = m.counts || {};
  if (m.playerId) S.pid = m.playerId;
  saveSession();
  history.replaceState(null, '', `${location.pathname}?room=${S.code}${S.role === 'screen' ? '&screen=1' : ''}`);
  document.body.classList.add('multi');
  document.body.classList.toggle('is-screen', S.role === 'screen');
  $('l-code').textContent = S.code;
  ensureTick();
}

function onRoom(m) {
  const prevPhase = S.phase;
  S.room = m; S.hostId = m.hostId; S.phase = m.phase;
  document.body.classList.toggle('is-host', isHost());
  if (m.phase === 'reveal' && S.reveal) applyRevealButton(); // 房主可能剛換人
  if (m.phase === 'final') { $('f-again').classList.toggle('hidden', !isHost()); $('f-wait').textContent = isHost() ? '' : '等待房主再開一局…'; }
  const active = document.querySelector('.screen.active');
  if (m.phase === 'lobby') {
    if (!active || active.id !== 'screen-mlobby') {
      if (S.player) S.player.stop();
      clearTimeout(S.goTimer);
      S.q = null;
      ui.showScreen('mlobby');
    }
    renderLobby();
  } else if (m.phase === 'final') {
    // final 訊息會負責切畫面
  } else if (active && !['screen-game', 'screen-mfinal'].includes(active.id) && prevPhase !== 'lobby') {
    ui.showScreen('game');
  }
  renderLocks();
}

// ===================== 大廳 =====================
function renderLobby() {
  const m = S.room;
  if (!m) return;
  const host = isHost();
  renderPlayers(m, S.pid, host, (id, nick) => { if (confirm(`要把「${nick}」移出房間嗎？`)) S.net.send({ t: 'kick', id }); });
  fillForm(m.settings, S.counts);
  $('l-settings').classList.toggle('readonly', !host);
  $('l-lockhint').textContent = host ? '' : '（只有房主能修改）';
  $('l-start').classList.toggle('hidden', !host);
  $('l-wait').classList.toggle('hidden', host);
  $('l-wait').textContent = isScreen() ? '你是「主畫面」：遊戲開始後會自動切換到播放畫面。' : '等待房主開始遊戲…';
  const needScreen = m.settings.playMode === 'screen' && m.screens === 0;
  $('l-start').disabled = needScreen;
  $('l-start').textContent = needScreen ? '請先開啟主畫面（點上方「🖥 開啟主畫面」）' : '開始遊戲 ▶';
  $('l-screen').classList.toggle('hidden', isScreen());
  showMsg('l-msg', '');
}

function sendSettings() { if (isHost()) S.net.send({ t: 'settings', settings: readForm() }); }

// ===================== 出題 =====================
function showGame() {
  ui.showScreen('game');
  const stage = document.querySelector('.stage');
  stage.classList.add('mp');
  stage.classList.toggle('mp-screenmode', S.q.playMode === 'screen' && !isScreen());
  $('btn-quit').textContent = '離開';
}

function onQuestion(m) {
  // 斷線重連：伺服器會把「目前這題」再送一次。同一題就只更新資料，不重置選擇、不重載影片、不重置計時
  if (S.q && S.q.idx === m.idx && S.phase !== 'lobby' && S.phase !== 'final') {
    S.q = m;
    showGame();
    renderLocks();
    return;
  }
  clearTimeout(S.goTimer); clearTimeout(S.activateTimer);
  S.q = m; S.go = null; S.phase = 'preload'; S.windowMs = (m.duration + m.graceSecs) * 1000;
  S.sel = -1; S.selKey = null; S.selLabel = ''; S.locked = false; S.canAnswer = false;
  S.localT0 = null; S.t0Server = null; S.quorumEndsAt = null; S.nextAt = null; S.reveal = null;
  showGame();
  ui.showQuestion({ kind: m.kind, prompt: m.prompt }, m.idx, m.total, m.choices);
  ui.lockChoices(false);
  $('mreveal').classList.add('hidden');
  $('mstatus').classList.remove('hidden');
  const typing = m.answerMode === 'typing';
  $('mtype').classList.toggle('hidden', typing ? isScreen() : true);
  $('mtype').classList.remove('locked');
  $('mtype-input').value = ''; $('mtype-list').replaceChildren(); $('mtype-picked').textContent = '';
  if (isScreen() && typing) { $('mtype').classList.add('hidden'); }
  setMainButton();
  $('m-clock').textContent = '';
  $('m-quorum').textContent = '';
  $('btn-mforce').classList.add('hidden'); $('btn-mskip').classList.toggle('hidden', false); $('btn-mend').classList.remove('hidden');
  renderLocks();

  if (needsVideo()) {
    ensurePlayer();
    ui.setPlaying(false);
    $('cover-text').textContent = '載入影片中…';
    // 第一題時播放器可能還在載入 YouTube API：等它好了再預載（期間若已換題就放棄）
    S.player.initP.then(() => { if (S.q === m) S.player.cue({ ytId: m.ytId, start: m.start, duration: m.duration }); });
  } else {
    $('cover-text').textContent = '🎧 請聽主畫面的音樂';
  }
}

function ensurePlayer() {
  if (S.player && S.player.h === S.handlers) return;
  S.handlers = {
    onCued: () => onCued(),
    onActivated: () => { S.activated = true; clearTimeout(S.activateTimer); sendReady(); },
    onPlaying: () => {
      if (S.phase !== 'playing' && S.phase !== 'preload') return;
      if (S.localT0 == null) {
        S.localT0 = Date.now(); // 本機「真正開始出聲」的時間點 = 我的作答計時起點
        if (isScreen() && S.q) S.net.send({ t: 'playing', idx: S.q.idx });
      }
      ui.setPlaying(true);
    },
    onClipEnd: () => { ui.setPlaying(false); },
    onProgress: (elapsed, duration) => { if (S.phase === 'playing') ui.setProgress(elapsed, duration); },
    onError: () => {
      if (S.q && (S.phase === 'preload' || S.phase === 'playing')) {
        S.net.send({ t: 'playError', idx: S.q.idx });
        ui.toast('這首影片在你的裝置無法播放，本題你不計分', true);
        S.canAnswer = false; setMainButton();
      }
    },
    onStuck: () => { if (S.phase === 'preload' || S.phase === 'playing') ui.toast('沒有聲音？點一下頁面試試', true); },
  };
  S.player = sharedPlayer(S.handlers);
  S.player.h = S.handlers;
  S.player.initP.then(() => { S.player.setVolume(deps.getVolume()); });
}

function sendReady() { if (S.q) S.net.send({ t: 'ready', idx: S.q.idx }); $('cover-text').textContent = '✅ 已就緒，等待其他人…'; }

/** 影片預載好了：已取得播放權限 → 直接 ready；否則先嘗試自動啟用，不行再請使用者點一下 */
function onCued() {
  if (S.q && S.phase === 'playing' && S.go) return playFromGo(); // 播放中才重新整理／重連回來
  if (!S.q || S.phase !== 'preload') return;
  if (S.activated) return sendReady();
  S.player.activate();
  S.activateTimer = setTimeout(() => {
    if (S.activated || S.phase !== 'preload') return;
    $('cover-text').textContent = '👆 點一下這裡，啟用聲音並準備好';
    $('cover').classList.add('tap');
  }, 1500);
}
$('cover').addEventListener('click', () => {
  if (!document.body.classList.contains('multi') || S.activated || !S.player) return;
  $('cover').classList.remove('tap');
  S.player.activate();
});

function onGo(m) {
  if (!S.q || m.idx !== S.q.idx) return;
  S.phase = 'playing'; S.canAnswer = !isScreen(); $('cover').classList.remove('tap');
  setMainButton();
  $('btn-mforce').classList.remove('hidden'); // 只有房主看得到（.host-only）
  S.go = m;
  if (needsVideo() && S.player) playFromGo();
}

/** 依伺服器的開播時間點播放：還沒到就排程；已經過了（重連／重新整理回來）就從「應該播到的位置」接著播 */
function playFromGo() {
  const m = S.go;
  if (!m || !S.q || m.idx !== S.q.idx || !S.player || !S.player.clip) return; // 影片還沒預載好 → onCued 會再呼叫
  const lateMs = S.net.now - m.startAt; // > 0 = 已經開播一段時間了
  clearTimeout(S.goTimer);
  if (lateMs > 800) {
    S.localT0 = Date.now() - lateMs; // 作答經過時間與其他人一致
    if (lateMs < S.q.duration * 1000) S.player.play(lateMs / 1000);
    else { ui.setPlaying(false); $('cover-text').textContent = '⏱ 音樂已經播完，可以直接作答'; }
  } else {
    S.goTimer = setTimeout(() => S.player.play(), Math.max(0, S.net.toLocal(m.startAt) - Date.now()));
  }
}

function onYou(m) { // 重連：還原我的選擇與鎖定狀態
  if (!S.q || m.idx !== S.q.idx) return;
  if (m.locked) { S.locked = true; ui.lockChoices(true); }
  if (m.selection) {
    if (m.selection.choice !== undefined) { S.sel = m.selection.choice; ui.setPicked(S.sel); }
    else if (m.selection.key) { S.selKey = m.selection.key; const w = S.works.find((x) => x.k === m.selection.key); S.selLabel = w ? w.main : ''; $('mtype-picked').replaceChildren(pickedNode()); }
  }
  setMainButton();
}

// ===================== 作答 =====================
function setMainButton() {
  const b = $('btn-main');
  if (isScreen()) return;
  if (S.phase === 'reveal') return; // 由 onReveal 設定
  if (!S.q) { b.disabled = true; return; }
  if (S.locked) { b.textContent = '✅ 已鎖定，等待其他人…'; b.disabled = true; return; }
  if (S.phase === 'preload') { b.textContent = '⏳ 等待大家載入影片…'; b.disabled = true; return; }
  if (!S.canAnswer) { b.textContent = '本題你無法作答'; b.disabled = true; return; }
  const has = S.q.answerMode === 'choice' ? S.sel >= 0 : !!S.selKey;
  b.textContent = has ? '🔒 鎖定答案 (空白鍵)' : '請先選一個答案';
  b.disabled = !has;
}

function pickChoice(i) {
  if (!S.canAnswer || S.locked || S.phase !== 'playing') return;
  S.sel = i; ui.setPicked(i);
  S.net.send({ t: 'select', idx: S.q.idx, choice: i });
  setMainButton();
}

function pickedNode() {
  const f = document.createDocumentFragment();
  if (!S.selLabel) return f;
  f.append('你的答案：');
  const b = document.createElement('b'); b.textContent = S.selLabel; f.append(b);
  return f;
}

function lockNow() {
  if (!S.q || S.locked || !S.canAnswer || S.phase !== 'playing') return;
  const has = S.q.answerMode === 'choice' ? S.sel >= 0 : !!S.selKey;
  if (!has) return;
  const msg = { t: 'lock', idx: S.q.idx, elapsedMs: S.localT0 != null && S.q.playMode === 'own' ? Date.now() - S.localT0 : 0 };
  if (S.q.answerMode === 'choice') msg.choice = S.sel; else msg.key = S.selKey;
  S.net.send(msg);
  S.locked = true;
  ui.lockChoices(true);
  $('mtype').classList.add('locked');
  setMainButton();
}

// ----- 打字搜尋 -----
const norm = (s) => String(s || '').normalize('NFKC').toLowerCase().replace(/[\s·・:：\-–—_!！?？,.，。、'’"“”()（）[\]【】~～]/g, '');
let activeLi = -1;
function search(q) {
  const n = norm(q);
  const list = $('mtype-list');
  list.replaceChildren(); activeLi = -1;
  if (!n) return;
  const hits = S.works.filter((w) => w.n.includes(n));
  hits.sort((a, b) => (norm(b.main).startsWith(n) - norm(a.main).startsWith(n)) || a.main.length - b.main.length);
  hits.slice(0, 10).forEach((w) => {
    const li = document.createElement('li');
    const b = document.createElement('b'); b.textContent = w.main;
    li.append(b);
    if (w.sub) { const s = document.createElement('small'); s.textContent = w.sub; li.append(s); }
    li.addEventListener('click', () => pickWork(w));
    list.append(li);
  });
  if (!hits.length) { const li = document.createElement('li'); li.textContent = '找不到，換個關鍵字試試'; li.style.cursor = 'default'; list.append(li); }
}
function pickWork(w) {
  if (!S.canAnswer || S.locked || S.phase !== 'playing') return;
  S.selKey = w.k; S.selLabel = w.main;
  $('mtype-picked').replaceChildren(pickedNode());
  $('mtype-list').replaceChildren(); $('mtype-input').value = '';
  S.net.send({ t: 'select', idx: S.q.idx, key: w.k });
  setMainButton();
}

// ===================== 揭曉 / 最終 =====================
function onReveal(m) {
  if (!S.q || m.idx !== S.q.idx) {
    if (!S.q) return; // 還沒收到題目就收到揭曉（極少見）
  }
  S.phase = 'reveal'; S.canAnswer = false; S.reveal = m; S.nextAt = m.nextAt;
  clearTimeout(S.goTimer);
  ui.showAnswer({ kind: m.kind, answer: m.answer });
  if (m.correct.index !== undefined) ui.markChoices(m.correct.index);
  ui.lockChoices(true);
  $('mtype').classList.add('locked');
  if (m.correct.key !== undefined) {
    const me = m.rows.find((r) => r.id === S.pid);
    $('mtype-picked').textContent = me ? (me.correct ? '✔ 答對了！' : me.answered ? '✘ 答錯了' : '未作答') : '';
  }
  if (needsVideo() && S.player) S.player.release(m.revealStart ?? undefined);
  renderReveal(m, S.pid);
  $('m-quorum').textContent = '';
  $('m-clock').textContent = '';
  $('btn-mforce').classList.add('hidden'); $('btn-mskip').classList.add('hidden');
  applyRevealButton();
  renderLocks();
}

/** 揭曉後的主按鈕：房主＝下一題；其他人＝等待（房主換人時也會重算） */
function applyRevealButton() {
  const b = $('btn-main');
  if (isScreen() || !S.reveal) return;
  if (isHost()) { b.textContent = S.reveal.last ? '查看最終排行榜 (空白鍵)' : '下一題 (空白鍵)'; b.disabled = false; }
  else { b.textContent = '等待房主按下一題…'; b.disabled = true; }
}

function onFinal(m) {
  S.phase = 'final';
  clearTimeout(S.goTimer);
  if (S.player) S.player.stop();
  renderFinal(m.ranking, S.pid, m.total);
  const host = isHost();
  $('f-again').classList.toggle('hidden', !host);
  $('f-wait').textContent = host ? '' : '等待房主再開一局…';
  ui.showScreen('mfinal');
}

// ===================== 鎖定狀態列 =====================
function renderLocks() {
  const m = S.room;
  if (!m || !S.q) return;
  const box = $('m-locks');
  box.replaceChildren();
  const inGame = m.players.filter((p) => !p.spectator);
  inGame.forEach((p) => {
    const c = document.createElement('span');
    c.className = 'mlock' + (p.locked ? ' on' : '') + (!p.connected ? ' off' : '') + (p.id === S.pid ? ' me' : '');
    c.textContent = p.nick;
    box.append(c);
  });
  if (S.phase === 'reveal') $('m-lockcount').textContent = `第 ${m.idx} / ${m.total} 題結束`;
  else if (S.phase === 'preload') $('m-lockcount').textContent = `載入中 ${m.players.filter((p) => p.ready).length} / ${inGame.length}`;
  else $('m-lockcount').textContent = `已鎖定 ${m.locked} / ${m.active}`;
}

// ===================== 計時顯示（每 200ms）=====================
function ensureTick() {
  if (S.tickTimer) return;
  S.tickTimer = setInterval(tick, 200);
}
function tick() {
  if (!S.q || !S.net) return;
  if (S.phase === 'playing') {
    const own = S.q.playMode === 'own' || isScreen();
    let elapsed = null;
    if (own) { if (S.localT0 != null) elapsed = Date.now() - S.localT0; }
    else if (S.t0Server != null) elapsed = S.net.now - S.t0Server;
    if (elapsed != null) {
      const left = (S.windowMs - elapsed) / 1000;
      $('m-clock').textContent = left > 0 ? `⏱ 作答剩 ${Math.ceil(left)} 秒` : '⏱ 時間到';
      if (!own) { ui.setProgress(elapsed / 1000, S.q.duration); }
      if (own && elapsed / 1000 > S.q.duration) $('cover-text').textContent = left > 0 ? `⏱ 音樂結束，還能作答 ${Math.ceil(left)} 秒` : '⏱ 時間到，等待揭曉…';
    }
    if (S.quorumEndsAt) {
      const r = Math.max(0, Math.ceil((S.quorumEndsAt - S.net.now) / 1000));
      $('m-quorum').textContent = `⏳ 鎖定人數已達標，${r} 秒後揭曉`;
      ui.setCountdown(r > 0 && r <= 5 ? r : null);
    }
  } else if (S.phase === 'reveal' && S.nextAt) {
    const r = Math.max(0, Math.ceil((S.nextAt - S.net.now) / 1000));
    $('m-clock').textContent = r > 0 ? `${r} 秒後自動下一題` : '';
  }
}

// ===================== 入口 =====================
function nickValue() { return $('m-nick').value.trim().slice(0, 12); }

export function initMulti(d) {
  deps = d;
  let savedNick = '';
  try { savedNick = localStorage.getItem(NICK_KEY) || ''; } catch { /* ignore */ }
  $('m-nick').value = savedNick;

  const startMulti = () => { deps.stopSingle(); ui.showScreen('mjoin'); showMsg('m-msg', ''); };
  $('btn-multi').addEventListener('click', startMulti);
  $('m-back').addEventListener('click', () => ui.showScreen('setup'));

  const remember = (n) => { try { localStorage.setItem(NICK_KEY, n); } catch { /* ignore */ } };
  $('m-create').addEventListener('click', () => {
    const nick = nickValue();
    if (!nick) { showMsg('m-msg', '請先輸入暱稱'); $('m-nick').focus(); return; }
    remember(nick); S.nick = nick; S.code = null; S.pid = null; S.role = 'player';
    connect({ t: 'create', nick });
  });
  const join = () => {
    const code = $('m-code').value.trim().toUpperCase();
    const asScreen = $('m-asscreen').checked;
    const nick = nickValue();
    if (code.length !== 4) { showMsg('m-msg', '請輸入 4 碼的房間代碼'); return; }
    if (!asScreen && !nick) { showMsg('m-msg', '請先輸入暱稱'); $('m-nick').focus(); return; }
    if (nick) remember(nick);
    S.nick = nick; S.code = null; S.pid = null; S.role = asScreen ? 'screen' : 'player';
    connect({ t: 'join', code, nick, role: asScreen ? 'screen' : 'player' });
  };
  $('m-join').addEventListener('click', join);
  $('m-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
  $('m-code').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
  $('m-nick').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('m-create').click(); });

  // 大廳
  $('l-leave').addEventListener('click', () => leaveRoom());
  $('l-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(inviteLink()); showMsg('l-msg', ''); ui.toast('已複製邀請連結', false); $('l-copy').textContent = '✅ 已複製'; setTimeout(() => { $('l-copy').textContent = '📋 複製邀請連結'; }, 1800); }
    catch { prompt('複製這個邀請連結：', inviteLink()); }
  });
  $('l-screen').addEventListener('click', () => window.open(`${inviteLink()}&screen=1`, '_blank'));
  $('l-start').addEventListener('click', () => { sendSettings(); S.net.send({ t: 'start' }); });
  const form = $('l-settings');
  form.addEventListener('change', sendSettings);

  // 遊戲中
  $('btn-main').addEventListener('click', () => {
    if (!document.body.classList.contains('multi')) return;
    mainAction();
  });
  $('btn-mforce').addEventListener('click', () => S.net && S.net.send({ t: 'forceReveal' }));
  $('btn-mskip').addEventListener('click', () => { if (confirm('跳過本題（不計分，換下一首）？')) S.net.send({ t: 'skip' }); });
  $('btn-mend').addEventListener('click', () => { if (confirm('結束遊戲並顯示最終排行榜？')) S.net.send({ t: 'end' }); });
  $('btn-quit').addEventListener('click', () => { if (document.body.classList.contains('multi')) leaveRoom(true); });
  $('choices').addEventListener('click', (e) => {
    if (!document.body.classList.contains('multi')) return;
    const d = e.target.closest('.choice');
    if (d) pickChoice(Number(d.dataset.i));
  });
  const inp = $('mtype-input');
  inp.addEventListener('input', () => search(inp.value));
  inp.addEventListener('keydown', (e) => {
    const items = [...$('mtype-list').children];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!items.length) return;
      activeLi = (activeLi + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items.forEach((li, i) => li.classList.toggle('active', i === activeLi));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      (items[activeLi >= 0 ? activeLi : 0] || { click() {} }).click();
    }
  });

  // 最終
  $('f-again').addEventListener('click', () => S.net && S.net.send({ t: 'again' }));
  $('f-leave').addEventListener('click', () => leaveRoom());

  // 鍵盤（多人）
  document.addEventListener('keydown', (e) => {
    if (!document.body.classList.contains('multi') || !$('screen-game').classList.contains('active')) return;
    if (e.target.tagName === 'INPUT' && e.target.type !== 'range') return;
    if (e.target.tagName === 'SELECT') return;
    if (e.code === 'Space' || e.code === 'Enter') { e.preventDefault(); mainAction(); }
    else if (/^(Digit|Numpad)[1-8]$/.test(e.code) && S.q && S.q.answerMode === 'choice') pickChoice(Number(e.code.slice(-1)) - 1);
  });

  // 網址帶房間代碼：?room=ABCD（&screen=1 = 主畫面）；同分頁重新整理則自動回座
  const params = new URLSearchParams(location.search);
  const room = (params.get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
  if (room) {
    const sess = loadSession();
    deps.stopSingle();
    $('m-code').value = room;
    if (sess && sess.code === room) {
      S.code = room; S.pid = sess.pid; S.nick = sess.nick; S.role = sess.role;
      document.body.classList.add('multi');
      ui.showScreen('mjoin'); showMsg('m-msg', '重新連線中…');
      connect(null);
    } else if (params.get('screen') === '1') {
      $('m-asscreen').checked = true;
      S.nick = ''; S.role = 'screen';
      ui.showScreen('mjoin');
      connect({ t: 'join', code: room, role: 'screen' });
    } else {
      ui.showScreen('mjoin');
      $('m-nick').focus();
    }
  }
}

function mainAction() {
  if (!S.net || isScreen()) return;
  if (S.phase === 'reveal') { if (isHost()) S.net.send({ t: 'next' }); return; }
  lockNow();
}
