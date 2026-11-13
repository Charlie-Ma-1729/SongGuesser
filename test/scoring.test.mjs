import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreAnswer, rankPlayers, BASE, SPEED_MAX, FIXED, PENALTY } from '../js/scoring.js';

const W = 20000;

test('速度模式：越快越高，答錯／未答 0', () => {
  const fast = scoreAnswer({ correct: true, answered: true, elapsedMs: 0, windowMs: W, mode: 'speed' });
  const mid = scoreAnswer({ correct: true, answered: true, elapsedMs: W / 2, windowMs: W, mode: 'speed' });
  const slow = scoreAnswer({ correct: true, answered: true, elapsedMs: W, windowMs: W, mode: 'speed' });
  assert.equal(fast.points, BASE + SPEED_MAX);
  assert.equal(mid.points, BASE + SPEED_MAX / 2);
  assert.equal(slow.points, BASE);
  assert.equal(scoreAnswer({ correct: false, answered: true, elapsedMs: 0, windowMs: W, mode: 'speed' }).points, 0);
  assert.equal(scoreAnswer({ correct: false, answered: false, elapsedMs: 0, windowMs: W, mode: 'speed' }).points, 0);
});

test('固定模式：不論快慢都一樣', () => {
  const a = scoreAnswer({ correct: true, answered: true, elapsedMs: 100, windowMs: W, mode: 'fixed' });
  const b = scoreAnswer({ correct: true, answered: true, elapsedMs: W, windowMs: W, mode: 'fixed' });
  assert.equal(a.points, FIXED);
  assert.equal(b.points, FIXED);
});

test('連對模式：連對越多加越多，有上限；答錯歸零', () => {
  const s0 = scoreAnswer({ correct: true, answered: true, elapsedMs: W, windowMs: W, mode: 'combo', streak: 0 });
  const s2 = scoreAnswer({ correct: true, answered: true, elapsedMs: W, windowMs: W, mode: 'combo', streak: 2 });
  const s9 = scoreAnswer({ correct: true, answered: true, elapsedMs: W, windowMs: W, mode: 'combo', streak: 9 });
  assert.equal(s0.points, BASE);
  assert.equal(s2.points, BASE + 100);
  assert.equal(s9.points, BASE + 250);
  assert.equal(s2.streak, 3);
  const wrong = scoreAnswer({ correct: false, answered: true, elapsedMs: 0, windowMs: W, mode: 'combo', streak: 4 });
  assert.equal(wrong.streak, 0);
});

test('答錯倒扣只在開啟時生效，未作答不扣', () => {
  assert.equal(scoreAnswer({ correct: false, answered: true, elapsedMs: 0, windowMs: W, mode: 'speed', penalty: true }).points, -PENALTY);
  assert.equal(scoreAnswer({ correct: false, answered: false, elapsedMs: 0, windowMs: W, mode: 'speed', penalty: true }).points, 0);
});

test('排行榜：同分依答對題數、平均時間；名次依分數並列', () => {
  const r = rankPlayers([
    { id: 'a', score: 1000, correct: 2, answered: 3, totalMs: 10000 },
    { id: 'b', score: 1000, correct: 2, answered: 3, totalMs: 6000 },
    { id: 'c', score: 1500, correct: 3, answered: 3, totalMs: 30000 },
    { id: 'd', score: 0, correct: 0, answered: 0, totalMs: 0 },
  ]);
  assert.deepEqual(r.map((x) => x.id), ['c', 'b', 'a', 'd']);
  assert.deepEqual(r.map((x) => x.rank), [1, 2, 2, 4]);
  assert.equal(r[1].avgMs, 3000);
  assert.equal(r[3].avgMs, null);
});
