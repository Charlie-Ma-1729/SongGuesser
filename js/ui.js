// DOM 呈現層（不含遊戲邏輯）
const $ = (id) => document.getElementById(id);

const KIND_LABEL = { OP: 'OP 片頭曲', ED: 'ED 片尾曲', INSERT: '插入曲', OST: 'OST 配樂', SONG: '電影歌曲' };

export function showScreen(name) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  $('screen-' + name).classList.add('active');
  if (name === 'game') hideEverything(); // 進入遊戲畫面時，先確保影片與答案都是蓋住的
}

/** 立刻蓋住影片、收起答案（切歌時不能露出任何上一題／下一題的畫面） */
function hideEverything() {
  $('cover').classList.remove('open'); // CSS：關上是即時的，不淡入
  $('answer').classList.add('hidden');
  document.querySelector('.stage').classList.remove('revealed');
}

let lastCount = null;
export function setCountdown(n) {
  const el = $('countdown');
  if (n === lastCount) return;
  lastCount = n;
  el.classList.toggle('on', n != null);
  if (n == null) { el.textContent = ''; return; }
  const b = document.createElement('b'); // 每換一個數字就重建元素，讓彈跳動畫重播
  b.textContent = String(n);
  el.replaceChildren(b);
}

/** 重置跑條與倒數（換題、重播時）；show=false 代表「不限長度」，沒有跑條 */
export function resetProgress(show) {
  const fill = $('timebar-fill');
  fill.classList.add('reset');
  fill.style.width = '0%';
  void fill.offsetWidth; // 立刻套用，下一次更新才會有動畫
  fill.classList.remove('reset');
  $('timebar').classList.toggle('off', !show);
  setCountdown(null);
}

/** 播放中更新跑條；auto 為 true 時最後 5 秒顯示大字倒數 */
export function setProgress(elapsed, duration, auto) {
  $('timebar-fill').style.width = `${Math.min(100, (elapsed / duration) * 100)}%`;
  const remain = duration - elapsed;
  setCountdown(auto && remain > 0 && remain <= 5 ? Math.max(1, Math.ceil(remain)) : null);
}

let badgeAnim = null;
/** OP／ED 標籤：先在畫面正中央放大顯示，停一下再縮小飛到原本的位置 */
function flyBadge() {
  const el = $('badge');
  if (badgeAnim) { badgeAnim.cancel(); badgeAnim = null; }
  if (!el.animate || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const r = el.getBoundingClientRect();
  if (!r.width) return;
  const dx = window.innerWidth / 2 - (r.left + r.width / 2);
  const dy = window.innerHeight / 2 - (r.top + r.height / 2);
  const scale = Math.min(4, (window.innerWidth * 0.5) / r.width);
  const from = `translate(${dx}px, ${dy}px) scale(${scale})`;
  badgeAnim = el.animate(
    [
      { transform: from, opacity: 0, offset: 0 },
      { transform: from, opacity: 1, offset: 0.12 },
      { transform: from, opacity: 1, offset: 0.62 },
      { transform: 'none', opacity: 1, offset: 1 },
    ],
    { duration: 2000, easing: 'cubic-bezier(.4,0,.2,1)' },
  );
  badgeAnim.onfinish = badgeAnim.oncancel = () => { badgeAnim = null; };
}

let toastTimer = null;
export function toast(msg, warn = false) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('warn', warn);
  clearTimeout(toastTimer);
  if (msg) toastTimer = setTimeout(() => { el.textContent = ''; }, 5000);
}

// ===== 8 選 1 選擇題 =====
let curChoices = null;
let picked = -1;

function renderChoices(choices) {
  curChoices = choices;
  picked = -1;
  const box = $('choices');
  box.replaceChildren();
  box.classList.toggle('hidden', !choices);
  box.classList.remove('done');
  document.querySelector('.stage').classList.toggle('mc', !!choices);
  if (!choices) return;
  choices.forEach((c, i) => {
    const d = document.createElement('div');
    d.className = 'choice';
    d.dataset.i = String(i);
    const no = document.createElement('span');
    no.className = 'no';
    no.textContent = String(i + 1);
    const txt = document.createElement('span');
    txt.className = 'txt';
    const m = document.createElement('b');
    m.textContent = c.main;
    txt.append(m);
    if (c.sub) {
      const s = document.createElement('small');
      s.textContent = c.sub;
      txt.append(s);
    }
    d.append(no, txt);
    box.append(d);
  });
}

/** 標記（或取消標記）某個選項，只是視覺上的記號，不計分 */
export function pickChoice(i) {
  if (!curChoices || i < 0 || i >= curChoices.length) return;
  picked = picked === i ? -1 : i;
  [...$('choices').children].forEach((d, k) => d.classList.toggle('picked', k === picked));
}

/** 多人模式：直接指定選取的選項（-1 = 取消），不做切換 */
export function setPicked(i) {
  if (!curChoices) return;
  picked = i >= 0 && i < curChoices.length ? i : -1;
  [...$('choices').children].forEach((d, k) => d.classList.toggle('picked', k === picked));
}
export const getPicked = () => picked;
/** 多人模式：鎖定後選項不能再改 */
export function lockChoices(on) { $('choices').classList.toggle('locked', on); }
/** 多人模式：伺服器公布正解索引後標示對錯（選項沒有 correct 欄位） */
export function markChoices(correctIdx) {
  if (!curChoices) return;
  const box = $('choices');
  box.classList.add('done');
  [...box.children].forEach((d, k) => {
    d.classList.toggle('correct', k === correctIdx);
    d.classList.toggle('wrong', k === picked && k !== correctIdx);
  });
}

/** 揭曉：正解亮綠色、其他變暗；若有標記且標錯，標記項變紅 */
export function revealChoices() {
  if (!curChoices) return;
  const box = $('choices');
  box.classList.add('done');
  [...box.children].forEach((d, k) => {
    const ok = !!curChoices[k].correct;
    d.classList.toggle('correct', ok);
    d.classList.toggle('wrong', !ok && k === picked);
  });
}

export function showQuestion(q, index, total, choices = null) {
  $('progress').textContent = `第 ${index} / ${total} 題`;
  hideEverything();
  renderChoices(choices);
  $('badge').textContent = KIND_LABEL[q.kind] || '配樂';
  flyBadge();
  $('prompt').textContent = q.prompt || '這首歌來自哪部動畫？';
  $('cover-text').textContent = '載入中…';
  $('btn-main').textContent = '揭曉答案 (空白鍵)';
  setPlaying(false);
}

export function setPlaying(on) {
  $('eq').classList.toggle('on', on);
  if (on) $('cover-text').textContent = '🎧 仔細聽…';
}

export function setClipEnded() {
  setPlaying(false);
  $('cover-text').textContent = '⏱ 時間到！按空白鍵揭曉（R 可重播）';
}

export function showAnswer(q) {
  const a = q.answer || {};
  $('ans-work').textContent = a.work || '';
  $('ans-title').textContent = a.title ? `♪ ${a.title}` : '';
  const dl = $('ans-credits');
  dl.innerHTML = '';
  [[q.kind === 'OST' ? '作曲／演出' : '演唱', a.artist], ['作詞', a.lyricist], ['作曲', a.composer], ['編曲', a.arranger]].forEach(([k, v]) => {
    if (!v) return;
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    dl.append(dt, dd);
  });
  setCountdown(null);
  $('answer').classList.remove('hidden');
  document.querySelector('.stage').classList.add('revealed');
  $('cover').classList.add('open'); // 揭曉後露出影片
  $('btn-main').textContent = '下一題 (空白鍵)';
}

/** 自動模式揭曉後：在「下一題」按鈕上顯示剩餘秒數 */
export function setNextCountdown(n) {
  $('btn-main').textContent = `下一題 (空白鍵) · ${n} 秒後自動`;
}

export function showEnd(n) {
  $('end-text').textContent = `一共猜了 ${n} 首，辛苦了！`;
  showScreen('end');
}
