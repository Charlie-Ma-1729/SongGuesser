import { CATEGORIES, loadBank, buildQueue } from './questions.js';
import { Game } from './game.js';
import * as ui from './ui.js';

const $ = (id) => document.getElementById(id);
let bank = {};
let game = null;

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
  if (!game) game = new Game();
  await game.start(queue, count, Number($('opt-duration').value));
}

$('btn-start').addEventListener('click', startGame);
$('btn-again').addEventListener('click', () => ui.showScreen('setup'));
$('btn-quit').addEventListener('click', () => { if (game) game.quit(); ui.showScreen('setup'); });
$('btn-main').addEventListener('click', () => game && game.press());
$('btn-replay').addEventListener('click', () => game && game.replay());
$('btn-skip').addEventListener('click', () => game && game.skip());
$('btn-flag').addEventListener('click', () => game && game.flagCurrent());

// 點擊後讓按鈕失焦，避免空白鍵同時觸發「按鈕點擊」與「鍵盤事件」
document.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) b.blur();
});

document.addEventListener('keydown', (e) => {
  if (!$('screen-game').classList.contains('active') || !game) return;
  if (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT') return;
  if (e.code === 'Space') { e.preventDefault(); game.press(); }
  else if (e.code === 'KeyR') game.replay();
  else if (e.code === 'KeyX') game.flagCurrent();
  else if (e.code === 'ArrowRight') game.skip();
});

init();
