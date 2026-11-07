// DOM 呈現層（不含遊戲邏輯）
const $ = (id) => document.getElementById(id);

const KIND_LABEL = { OP: 'OP 片頭曲', ED: 'ED 片尾曲', INSERT: '插入曲', OST: 'OST 配樂' };

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

export function showQuestion(q, index, total) {
  $('progress').textContent = `第 ${index} / ${total} 題`;
  hideEverything();
  $('badge').textContent = KIND_LABEL[q.kind] || '動漫';
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
  [['演唱', a.artist], ['作詞', a.lyricist], ['作曲', a.composer], ['編曲', a.arranger]].forEach(([k, v]) => {
    if (!v) return;
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    dl.append(dt, dd);
  });
  $('answer').classList.remove('hidden');
  document.querySelector('.stage').classList.add('revealed');
  $('cover').classList.add('open'); // 揭曉後露出影片
  $('btn-main').textContent = '下一題 (空白鍵)';
}

export function showEnd(n) {
  $('end-text').textContent = `一共猜了 ${n} 首，辛苦了！`;
  showScreen('end');
}
