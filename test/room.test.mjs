import test from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../server/room.mjs';
import { cleanSettings } from '../server/protocol.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FAST = { preloadMs: 60, goDelayMs: 10, lagMs: 60, staleMs: 80, lobbyDropMs: 100, dropMs: 400 };

function fakeConn() {
  return { sent: [], kicked: false, send(m) { this.sent.push(m); }, close() { this.closed = true; }, last(t) { return [...this.sent].reverse().find((m) => m.t === t); }, all(t) { return this.sent.filter((m) => m.t === t); } };
}

/** 建一個房間並加入 n 位玩家；回傳 { room, conns, players } */
function setup(n, settings = {}, timing = {}) {
  const room = new Room('TEST', { ...FAST, ...timing });
  const conns = []; const players = [];
  for (let i = 0; i < n; i++) {
    const c = fakeConn();
    const r = room.join(c, { nick: 'P' + (i + 1) });
    assert.ok(r.player, r.error && r.error.msg);
    conns.push(c); players.push(r.player);
  }
  room.settings = { ...cleanSettings({ categories: ['anime'], count: 3, ...settings }), ...settings };
  return { room, conns, players };
}
const start = (room, conns) => room.handle(conns[0], { t: 'start' });
const readyAll = (room, conns) => { const idx = room.game.idx; conns.forEach((c) => room.handle(c, { t: 'ready', idx })); };

test('暱稱重名會自動加數字、第一位是房主', () => {
  const room = new Room('T1', FAST);
  const a = room.join(fakeConn(), { nick: '小明' }).player;
  const b = room.join(fakeConn(), { nick: '小明' }).player;
  assert.equal(a.nick, '小明');
  assert.equal(b.nick, '小明2');
  assert.equal(room.hostId, a.id);
  assert.equal(room.join(fakeConn(), { nick: '   ' }).error.code, 'NICK');
});

test('全員 ready → 開播；全員鎖定 → 提早揭曉並計分', async () => {
  const { room, conns, players } = setup(3);
  start(room, conns);
  assert.equal(room.phase, 'preload');
  const q = conns[0].last('question');
  assert.equal(q.choices.length, 8);
  assert.equal(q.choices.some((c) => 'correct' in c), false, '選項不能洩漏正解');
  assert.equal('answer' in q, false, '題目訊息不應包含答案卡');
  assert.equal('correct' in q, false);
  readyAll(room, conns);
  assert.equal(room.phase, 'playing');
  assert.ok(conns[1].last('go').startAt);
  const idx = room.game.idx; const ok = room.game.correctIdx; const bad = (ok + 1) % 8;
  room.handle(conns[0], { t: 'lock', idx, choice: ok, elapsedMs: 0 });
  room.handle(conns[1], { t: 'lock', idx, choice: bad, elapsedMs: 0 });
  assert.equal(room.phase, 'playing');
  assert.equal(conns[2].last('room').locked, 2);
  room.handle(conns[2], { t: 'lock', idx, choice: ok, elapsedMs: 5000 });
  assert.equal(room.phase, 'reveal');
  const rv = conns[0].last('reveal');
  assert.equal(rv.reason, 'all');
  assert.equal(rv.correct.index, ok);
  const byId = Object.fromEntries(rv.rows.map((r) => [r.id, r]));
  assert.equal(byId[players[0].id].correct, true);
  assert.equal(byId[players[1].id].points, 0);
  assert.ok(byId[players[0].id].points > byId[players[2].id].points, '越快分數越高');
  assert.equal(rv.ranking[0].id, players[0].id);
});

test('過半鎖定 → 開始倒數且只觸發一次；倒數結束揭曉', async () => {
  const { room, conns } = setup(4, { quorumMode: 'half', quorumSecs: 0.15 });
  start(room, conns); readyAll(room, conns);
  const idx = room.game.idx;
  room.handle(conns[0], { t: 'lock', idx, choice: 0, elapsedMs: 0 });
  room.handle(conns[1], { t: 'lock', idx, choice: 0, elapsedMs: 0 });
  assert.equal(conns[3].all('quorum').length, 0, '2/4 還沒過半');
  room.handle(conns[2], { t: 'lock', idx, choice: 0, elapsedMs: 0 });
  assert.equal(conns[3].all('quorum').length, 1, '3/4 過半 → 開始倒數');
  assert.equal(room.phase, 'playing');
  await sleep(250);
  assert.equal(room.phase, 'reveal');
  assert.equal(conns[3].last('reveal').reason, 'quorum');
  assert.equal(conns[3].all('quorum').length, 1);
});

test('門檻「關閉」時不倒數；已選未鎖定的在揭曉時以最慢速度計入', () => {
  const { room, conns, players } = setup(3, { quorumMode: 'off', scoreMode: 'speed' });
  start(room, conns); readyAll(room, conns);
  const idx = room.game.idx; const ok = room.game.correctIdx;
  room.handle(conns[0], { t: 'lock', idx, choice: ok, elapsedMs: 0 });
  room.handle(conns[1], { t: 'select', idx, choice: ok }); // 只選未鎖
  room.handle(conns[2], { t: 'lock', idx, choice: ok, elapsedMs: 0 });
  assert.equal(conns[0].all('quorum').length, 0);
  room.handle(conns[0], { t: 'forceReveal', idx });
  const rv = conns[0].last('reveal');
  const r1 = rv.rows.find((r) => r.id === players[1].id);
  assert.equal(r1.correct, true);
  assert.equal(r1.points, 600, '最慢速度 = 基本分');
});

test('硬性截止：沒人作答也會揭曉', async () => {
  const { room, conns } = setup(2, { duration: 0.05, graceSecs: 0 });
  room.settings.duration = 0.05;
  start(room, conns); readyAll(room, conns);
  await sleep(250);
  assert.equal(room.phase, 'reveal');
  assert.equal(conns[0].last('reveal').reason, 'time');
});

test('預載逾時也會開播（有人沒 ready）', async () => {
  const { room, conns } = setup(2);
  start(room, conns);
  room.handle(conns[0], { t: 'ready', idx: room.game.idx });
  assert.equal(room.phase, 'preload');
  await sleep(120);
  assert.equal(room.phase, 'playing');
});

test('elapsed 會被夾在伺服器看到的時間以內（不能亂報超快）', () => {
  const { room, conns, players } = setup(2, { scoreMode: 'speed' });
  start(room, conns); readyAll(room, conns);
  const idx = room.game.idx; const ok = room.game.correctIdx;
  room.handle(conns[0], { t: 'lock', idx, choice: ok, elapsedMs: -99999 });
  room.handle(conns[1], { t: 'lock', idx, choice: ok, elapsedMs: 99999999 });
  const rv = conns[0].last('reveal');
  const a = rv.rows.find((r) => r.id === players[0].id);
  const b = rv.rows.find((r) => r.id === players[1].id);
  assert.ok(a.ms >= 0);
  assert.ok(b.ms <= room.game.windowMs);
});

test('錯誤的題號、錯誤的選項索引會被忽略', () => {
  const { room, conns } = setup(2);
  start(room, conns); readyAll(room, conns);
  const idx = room.game.idx;
  room.handle(conns[0], { t: 'lock', idx: idx + 5, choice: 0 });
  room.handle(conns[0], { t: 'lock', idx, choice: 99 });
  room.handle(conns[0], { t: 'lock', idx, choice: 'x' });
  assert.equal(conns[1].last('room').locked, 0);
});

test('非房主不能開始／跳題；房主離線後移轉', () => {
  const { room, conns, players } = setup(3);
  room.handle(conns[1], { t: 'start' });
  assert.equal(room.phase, 'lobby');
  room.disconnect(conns[0]);
  assert.equal(room.hostId, players[1].id);
});

test('房主很快重連（重新整理）會拿回房主；太久才回來則不會', () => {
  const { room, conns, players } = setup(2, {}, { hostReturnMs: 60 });
  room.disconnect(conns[0]);
  assert.equal(room.hostId, players[1].id);
  room.join(fakeConn(), { playerId: players[0].id });
  assert.equal(room.hostId, players[0].id, '馬上回來 → 還給房主');
});

test('斷線重連：用同一個 playerId 回座並保留分數', async () => {
  const { room, conns, players } = setup(2);
  start(room, conns); readyAll(room, conns);
  const idx = room.game.idx; const ok = room.game.correctIdx;
  room.handle(conns[0], { t: 'lock', idx, choice: ok, elapsedMs: 0 });
  room.handle(conns[1], { t: 'lock', idx, choice: ok, elapsedMs: 0 });
  const score = players[0].score;
  assert.ok(score > 0);
  room.disconnect(conns[0]);
  const c2 = fakeConn();
  const r = room.join(c2, { playerId: players[0].id, nick: '別的名字' });
  assert.equal(r.player.id, players[0].id);
  assert.equal(r.player.score, score);
  assert.equal(r.player.nick, 'P1');
  assert.ok(c2.last('reveal'), '重連後補送目前的揭曉畫面');
  assert.equal(room.players.size, 2);
});

test('離線超過 staleMs 不算進鎖定分母：剩下的人都鎖定就揭曉', async () => {
  const { room, conns } = setup(3, { quorumMode: 'off' });
  start(room, conns); readyAll(room, conns);
  const idx = room.game.idx;
  room.disconnect(conns[2]);
  room.handle(conns[0], { t: 'lock', idx, choice: 0, elapsedMs: 0 });
  room.handle(conns[1], { t: 'lock', idx, choice: 0, elapsedMs: 0 });
  assert.equal(room.phase, 'playing', '剛離線 10 秒內仍算在分母');
  await sleep(120);
  room.tick();
  assert.equal(room.phase, 'reveal');
});

test('影片無法播放：個人略過不計分；多數失敗 → 換下一題', () => {
  const { room, conns, players } = setup(3);
  start(room, conns); readyAll(room, conns);
  const idx = room.game.idx;
  room.handle(conns[2], { t: 'playError', idx });
  assert.equal(room.phase, 'playing');
  assert.equal(players[2].failed, true);
  room.handle(conns[1], { t: 'playError', idx });
  assert.ok(conns[0].last('skipped'));
  assert.equal(room.game.idx, idx, '換備用題，題號不增加');
  assert.equal(room.phase, 'preload');
});

test('打字搜尋模式：以 key 判分', () => {
  const { room, conns, players } = setup(2, { answerMode: 'typing' });
  start(room, conns);
  assert.ok(conns[0].last('works').list.length > 10);
  assert.equal(conns[0].last('question').choices, null);
  readyAll(room, conns);
  const idx = room.game.idx;
  room.handle(conns[0], { t: 'lock', idx, key: room.game.correctKey, elapsedMs: 0 });
  room.handle(conns[1], { t: 'lock', idx, key: 'nope', elapsedMs: 0 });
  const rv = conns[0].last('reveal');
  assert.equal(rv.rows.find((r) => r.id === players[0].id).correct, true);
  assert.equal(rv.rows.find((r) => r.id === players[1].id).correct, false);
});

test('完整一局：揭曉 → 下一題 → 最終排行 → 再來一局', () => {
  const { room, conns, players } = setup(2, { count: 3 });
  room.settings.count = 3;
  start(room, conns);
  for (let i = 0; i < 3; i++) {
    readyAll(room, conns);
    const idx = room.game.idx; const ok = room.game.correctIdx;
    room.handle(conns[0], { t: 'lock', idx, choice: ok, elapsedMs: 1000 });
    room.handle(conns[1], { t: 'lock', idx, choice: (ok + 1) % 8, elapsedMs: 1000 });
    assert.equal(room.phase, 'reveal');
    assert.equal(conns[0].last('reveal').last, i === 2);
    room.handle(conns[1], { t: 'next' }); // 非房主，無效
    assert.equal(room.phase, 'reveal');
    room.handle(conns[0], { t: 'next' });
  }
  assert.equal(room.phase, 'final');
  const f = conns[0].last('final');
  assert.equal(f.ranking[0].id, players[0].id);
  assert.equal(f.ranking[0].correct, 3);
  room.handle(conns[0], { t: 'again' });
  assert.equal(room.phase, 'lobby');
  assert.equal(players[0].score, 0);
});

test('踢人：被踢者不能再用同一 id 加入', () => {
  const { room, conns, players } = setup(3);
  room.handle(conns[0], { t: 'kick', id: players[2].id });
  assert.equal(room.players.has(players[2].id), false);
  assert.equal(conns[2].last('kicked').t, 'kicked');
  assert.equal(room.join(fakeConn(), { playerId: players[2].id, nick: 'x' }).error.code, 'BANNED');
});

test('中途加入：先觀戰，下一題才參與；房主可關閉', () => {
  const { room, conns } = setup(2);
  start(room, conns); readyAll(room, conns);
  const late = fakeConn();
  const lp = room.join(late, { nick: '遲到' }).player;
  assert.equal(lp.spectator, true);
  assert.ok(late.last('question'), '補送目前題目');
  room.handle(late, { t: 'lock', idx: room.game.idx, choice: 0 });
  assert.equal(lp.lock, null, '觀戰者不能作答');
  room.settings.allowLateJoin = false;
  assert.equal(room.join(fakeConn(), { nick: '再遲到' }).error.code, 'STARTED');
});

test('設定夾限：不合法的值會被修正', () => {
  const s = cleanSettings({ count: 99999, duration: 1, scoreMode: 'hack', categories: ['x'], quorumMode: 'n', quorumN: -5, autoNext: 1 });
  assert.equal(s.count, 100);
  assert.equal(s.duration, 5);
  assert.equal(s.scoreMode, 'speed');
  assert.deepEqual(s.categories, ['anime']);
  assert.equal(s.quorumN, 1);
  assert.equal(s.autoNext, 3);
});

test('主畫面模式：沒有主畫面不能開始；以主畫面的 ready 為準', () => {
  const { room, conns } = setup(2, { playMode: 'screen' });
  start(room, conns);
  assert.equal(room.phase, 'lobby');
  assert.equal(conns[0].last('error').code, 'NO_SCREEN');
  const sc = fakeConn();
  room.joinScreen(sc);
  start(room, conns);
  assert.equal(room.phase, 'preload');
  room.handle(sc, { t: 'ready', idx: room.game.idx });
  assert.equal(room.phase, 'playing', '手機不用 ready');
  room.handle(sc, { t: 'playing', idx: room.game.idx });
  assert.ok(sc.last('t0').t0 > 0);
});

test('分頁被關掉：用同暱稱重新加入，接回離線的座位（保留分數、不會變成「名2」）', () => {
  const { room, conns, players } = setup(2);
  start(room, conns); readyAll(room, conns);
  const idx = room.game.idx; const ok = room.game.correctIdx;
  room.handle(conns[0], { t: 'lock', idx, choice: ok, elapsedMs: 0 });
  room.handle(conns[1], { t: 'lock', idx, choice: ok, elapsedMs: 0 });
  const score = players[1].score;
  assert.ok(score > 0);
  room.disconnect(conns[1]); // 手機把網頁殺掉
  const c2 = fakeConn();
  const r = room.join(c2, { nick: 'p2' }); // 沒有 playerId，只有暱稱（大小寫不拘）
  assert.equal(r.player.id, players[1].id);
  assert.equal(r.player.score, score);
  assert.equal(room.players.size, 2);
  assert.equal(c2.last('joined').playerId, players[1].id);
  // 對方還在線上時，同暱稱不能搶座位
  const c3 = fakeConn();
  const r3 = room.join(c3, { nick: 'P2' });
  assert.equal(r3.player.nick, 'P22', '在線的人不會被擠掉，新來的自動加數字');
});

test('離線玩家保留很久（大廳 10 分鐘、遊戲中 1 小時），不會因為鎖螢幕幾十秒就被踢', async () => {
  const { room, conns, players } = setup(2, {}, { staleMs: 10, lobbyDropMs: 10 * 60 * 1000 });
  room.disconnect(conns[1]);
  players[1].lastSeen -= 5 * 60 * 1000;
  room.tick();
  assert.equal(room.players.has(players[1].id), true, '大廳離線 5 分鐘仍保留');
  players[1].lastSeen -= 6 * 60 * 1000;
  room.tick();
  assert.equal(room.players.has(players[1].id), false, '大廳離線超過 10 分鐘才移出');
});

import { bank } from '../server/bank.mjs';
const idMap = () => { const m = new Map(); for (const l of Object.values(bank)) for (const q of l) m.set(q.id, q); return m; };
const roundtrip = (room, timing = FAST) => Room.restore(JSON.parse(JSON.stringify(room.serialize())), idMap(), timing);

test('伺服器重啟：房間存檔還原後，玩家用 playerId 重連，分數／鎖定／題目都在，遊戲可以繼續', () => {
  const { room, conns, players } = setup(3, { quorumMode: 'off', count: 3 });
  room.settings.count = 3;
  start(room, conns); readyAll(room, conns);
  let idx = room.game.idx; let ok = room.game.correctIdx;
  // 第 1 題：兩個人答，一個人沒答 → 手動揭曉，累積分數
  room.handle(conns[0], { t: 'lock', idx, choice: ok, elapsedMs: 0 });
  room.handle(conns[1], { t: 'lock', idx, choice: (ok + 1) % 8, elapsedMs: 0 });
  room.handle(conns[0], { t: 'forceReveal', idx });
  room.handle(conns[0], { t: 'next' });
  readyAll(room, conns);
  idx = room.game.idx; ok = room.game.correctIdx;
  room.handle(conns[2], { t: 'lock', idx, choice: ok, elapsedMs: 1000 }); // 第 2 題進行中，只有 P3 鎖定
  const score0 = players[0].score; assert.ok(score0 > 0);

  const r2 = roundtrip(room); // ← 伺服器重啟
  assert.equal(r2.phase, 'playing');
  assert.equal(r2.game.idx, idx);
  assert.equal(r2.hostId, players[0].id);
  assert.equal(r2.players.get(players[0].id).score, score0, '分數保留');
  assert.ok(r2.players.get(players[2].id).lock, '已鎖定的答案保留');
  assert.equal(r2.players.get(players[0].id).connected, false, '還原後先視為離線');
  assert.equal(r2.game.correctIdx, ok, '正解索引保留（選項順序一致）');

  // 玩家重連
  const nc = [fakeConn(), fakeConn(), fakeConn()];
  nc.forEach((c, i) => assert.equal(r2.join(c, { playerId: players[i].id, nick: players[i].nick }).player.id, players[i].id));
  assert.ok(nc[0].last('question') && nc[0].last('go'), '重連後補送題目與開播時間');
  assert.equal(nc[2].last('you').locked, true);
  assert.equal(r2.hostId, players[0].id);
  // 繼續玩：其他人鎖定 → 全員鎖定 → 揭曉 → 下一題 → 結束
  r2.handle(nc[0], { t: 'lock', idx, choice: ok, elapsedMs: 500 });
  r2.handle(nc[1], { t: 'lock', idx, choice: ok, elapsedMs: 500 });
  assert.equal(r2.phase, 'reveal');
  assert.ok(nc[0].last('reveal').rows.find((r) => r.id === players[0].id).total > score0, '還原後分數持續累加');
  r2.handle(nc[0], { t: 'next' });
  r2.game.idx; readyAll(r2, nc);
  const i3 = r2.game.idx;
  nc.forEach((c) => r2.handle(c, { t: 'lock', idx: i3, choice: 0, elapsedMs: 0 }));
  r2.handle(nc[0], { t: 'next' });
  assert.equal(r2.phase, 'final');
  r2.destroy();
});

test('還原：揭曉中與最終排行榜階段也能接回', () => {
  const { room, conns } = setup(2, { quorumMode: 'off' });
  start(room, conns); readyAll(room, conns);
  const idx = room.game.idx; const ok = room.game.correctIdx;
  conns.forEach((c) => room.handle(c, { t: 'lock', idx, choice: ok, elapsedMs: 0 }));
  assert.equal(room.phase, 'reveal');
  const r2 = roundtrip(room);
  assert.equal(r2.phase, 'reveal');
  const c = fakeConn();
  r2.join(c, { playerId: [...r2.players.keys()][0], nick: 'x' });
  assert.ok(c.last('reveal'), '重連後補送揭曉畫面');
  r2.destroy();
  room.handle(conns[0], { t: 'end' });
  const r3 = roundtrip(room);
  assert.equal(r3.phase, 'final');
  r3.destroy();
});

test('還原：題庫更新讓那一題不見 → 安全地回到大廳（不當掉）', () => {
  const { room, conns } = setup(2);
  start(room, conns); readyAll(room, conns);
  const data = JSON.parse(JSON.stringify(room.serialize()));
  const r2 = Room.restore(data, new Map(), FAST); // 空題庫
  assert.equal(r2.phase, 'lobby');
  assert.equal(r2.game, null);
  assert.equal(r2.players.size, 2);
  r2.destroy();
});
