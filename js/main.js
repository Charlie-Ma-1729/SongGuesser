import { CATEGORIES, loadBank, buildQueue, buildChoices } from './questions.js';
import { Game } from './game.js';
import * as ui from './ui.js';

const $ = (id) => document.getElementById(id);
let bank = {};
let game = null;

// ===== 音量（記在 localStorage，兩個滑桿同步）=====
const VOL_KEY = 'songguesser-volume';
let volume = 80;
let lastNonZero = 80;
try {
  const v = Number(localStorage.getItem(VOL_KEY));
  if (localStorage.getItem(VOL_KEY) !== null && v >= 0 && v <= 100) volume = v;
} catch { /* ignore */ }
if (volume > 0) lastNonZero = volume;

function setVolume(v, save = true) {
  volume = Math.max(0, Math.min(100, Math.round(v)));
  if (volume > 0) lastNonZero = volume;
  for (const id of ['vol-setup', 'vol-game']) {
    $(id).value = volume;
    $(id + '-out').textContent = volume === 0 ? '靜音' : volume;
  }
  if (game) game.player.setVolume(volume);
  if (save) { try { localStorage.setItem(VOL_KEY, String(volume)); } catch { /* ignore */ } }
}
for (const id of ['vol-setup', 'vol-game']) {
  $(id).addEventListener('input', (e) => setVolume(Number(e.target.value)));
}
setVolume(volume, false);

function selectedCategories() {
  return [...document.querySelectorAll('#categories input:checked')].map((i) => i.value);
}
function selectedKinds() {
  return [...document.querySelectorAll('#kinds input:checked')].map((i) => i.value);
}

function renderCategories() {
  const box = $('categories');
  box.innerHTML = '';
  CATEGORIES.forEach((c) => {
    const n = (bank[c.id] || []).length;
    const label = document.createElement('label');
    label.className = 'chip' + (n ? '' : ' disabled');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = c.id;
    input.disabled = !n;
    input.checked = !!n;
    label.append(input, ` ${c.label}　${n ? n + ' 首' : '即將推出'}`);
    box.append(label);
  });
}

async function init() {
  bank = await loadBank();
  renderCategories();
  const total = Object.values(bank).reduce((s, a) => s + a.length, 0);
  const btn = $('btn-start');
  if (total === 0) {
    btn.textContent = '題庫是空的（請先建置題庫）';
    return;
  }
  btn.disabled = false;
  btn.textContent = '開始遊戲 ▶';
}

async function startGame() {
  const cats = selectedCategories();
  const kinds = selectedKinds();
  const pool = cats.flatMap((c) => bank[c] || []);
  const count = Number($('opt-count').value);
  const queue = buildQueue(pool, {
    kinds,
    maxDifficulty: Number($('opt-difficulty').value),
    maxPerWork: Number($('opt-perwork').value),
    count,
  });
  if (queue.length === 0) {
    alert('符合條件的題目是 0 首，請放寬設定。');
    return;
  }
  ui.showScreen('game');
  if (!game) game = new Game(volume);

  // 8 選 1：干擾項取自「同一個題庫」，所以先記下每題屬於哪個題庫
  let makeChoices = null;
  if ($('opt-choice').value === '1') {
    const catOf = new Map();
    for (const c of cats) for (const q of bank[c] || []) catOf.set(q.id, c);
    const maxDifficulty = Number($('opt-difficulty').value);
    makeChoices = (q) => {
      const cat = catOf.get(q.id);
      return buildChoices(q, bank[cat] || [], cat, { maxDifficulty });
    };
  }
  await game.start(queue, count, Number($('opt-duration').value), $('opt-auto').value === '1', $('opt-start').value === '1', makeChoices);
}

$('btn-start').addEventListener('click', startGame);
$('btn-again').addEventListener('click', () => ui.showScreen('setup'));
$('btn-quit').addEventListener('click', () => { if (game) game.quit(); ui.showScreen('setup'); });
$('btn-main').addEventListener('click', () => game && game.press());
$('btn-replay').addEventListener('click', () => game && game.replay());
$('btn-skip').addEventListener('click', () => game && game.skip());
$('btn-flag').addEventListener('click', () => game && game.flagCurrent());
$('choices').addEventListener('click', (e) => {
  const d = e.target.closest('.choice');
  if (d && game) game.pick(Number(d.dataset.i));
});

// 點擊後讓按鈕失焦，避免空白鍵同時觸發「按鈕點擊」與「鍵盤事件」
document.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) b.blur();
});

document.addEventListener('keydown', (e) => {
  if (!$('screen-game').classList.contains('active') || !game) return;
  if (e.target.tagName === 'SELECT') return;
  if (e.target.tagName === 'INPUT') {
    // 音量滑桿聚焦時，空白鍵／方向鍵仍照常運作（方向鍵由下方統一處理）
    if (e.target.type !== 'range') return;
    e.target.blur();
  }
  if (e.code === 'ArrowUp') { e.preventDefault(); setVolume(volume + 5); }
  else if (e.code === 'ArrowDown') { e.preventDefault(); setVolume(volume - 5); }
  else if (e.code === 'KeyM') setVolume(volume === 0 ? lastNonZero : 0);
  else if (e.code === 'Space') { e.preventDefault(); game.press(); }
  else if (e.code === 'KeyR') game.replay();
  else if (e.code === 'KeyX') game.flagCurrent();
  else if (/^(Digit|Numpad)[1-8]$/.test(e.code)) game.pick(Number(e.code.slice(-1)) - 1);
  else if (e.code === 'ArrowRight') game.skip();
});

init();
