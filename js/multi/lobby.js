// 多人：大廳、設定表單、排行榜的畫面渲染（不含網路邏輯）
import { CATEGORIES } from '../questions.js';

const $ = (id) => document.getElementById(id);
const NUM_KEYS = ['count', 'duration', 'graceSecs', 'difficulty', 'perWork', 'quorumN', 'quorumSecs', 'autoNext'];
const BOOL_KEYS = ['fromMiddle', 'penalty', 'allowLateJoin'];

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/** 讀出設定表單目前的值 */
export function readForm() {
  const s = {};
  s.categories = [...document.querySelectorAll('#f-categories input:checked')].map((i) => i.value);
  s.kinds = [...document.querySelectorAll('#f-kinds input:checked')].map((i) => i.value);
  document.querySelectorAll('#l-settings [data-k]').forEach((sel) => {
    const k = sel.dataset.k;
    s[k] = NUM_KEYS.includes(k) ? Number(sel.value) : BOOL_KEYS.includes(k) ? sel.value === 'true' : sel.value;
  });
  return s;
}

/** 以伺服器的設定填入表單；題庫勾選區依各題庫題數重建 */
export function fillForm(settings, counts) {
  const box = $('f-categories');
  if (box.dataset.built !== JSON.stringify(counts)) {
    box.replaceChildren();
    CATEGORIES.forEach((c) => {
      const n = counts[c.id] || 0;
      const label = el('label', 'chip' + (n ? '' : ' disabled'));
      const input = document.createElement('input');
      input.type = 'checkbox'; input.value = c.id; input.disabled = !n;
      label.append(input, ` ${c.label}　${n ? n + ' 首' : '即將推出'}`);
      box.append(label);
    });
    box.dataset.built = JSON.stringify(counts);
  }
  box.querySelectorAll('input').forEach((i) => { i.checked = settings.categories.includes(i.value); });
  document.querySelectorAll('#f-kinds input').forEach((i) => { i.checked = settings.kinds.includes(i.value); });
  document.querySelectorAll('#l-settings [data-k]').forEach((sel) => {
    const v = String(settings[sel.dataset.k]);
    if (sel.value !== v) sel.value = v;
  });
  // 指定人數／倒數秒數只在需要時顯示
  const hide = (k, on) => { const l = document.querySelector(`#l-settings [data-k="${k}"]`).closest('label'); l.classList.toggle('hidden', on); };
  hide('quorumN', settings.quorumMode !== 'n');
  hide('quorumSecs', settings.quorumMode === 'off');
}

/** 大廳玩家列表 */
export function renderPlayers(room, meId, isHost, onKick) {
  const box = $('l-players');
  box.replaceChildren();
  room.players.forEach((p) => {
    const chip = el('span', 'pchip' + (p.id === meId ? ' me' : '') + (p.connected ? '' : ' off'));
    chip.append((p.id === room.hostId ? '👑 ' : '') + p.nick);
    if (isHost && p.id !== meId) {
      const b = el('button', null, '✕');
      b.title = '移出房間';
      b.addEventListener('click', () => onKick(p.id, p.nick));
      chip.append(b);
    }
    box.append(chip);
  });
  const sc = room.screens ? `　🖥 主畫面 ×${room.screens}` : '';
  $('l-count').textContent = `（${room.players.length} 人）${sc}`;
}

const MEDAL = ['🥇', '🥈', '🥉'];
const fmtMs = (ms) => (ms == null ? '' : `${(ms / 1000).toFixed(1)}s`);

/** 一列排名：rank / 暱稱（+小字）/ 分數 */
export function rankRow({ rank, nick, sub, right, me }) {
  const r = el('div', 'mrow' + (me ? ' me' : ''));
  r.append(el('span', 'rk', String(rank)));
  const nm = el('span', 'nm', nick);
  if (sub) nm.append(el('small', null, sub));
  r.append(nm, el('span', 'pt', right), el('span', 'tt', ''));
  return r;
}

/** 最終排行榜（頒獎台 + 完整表格） */
export function renderFinal(ranking, meId, total) {
  $('f-sub').textContent = `共 ${total} 題`;
  const pod = $('f-podium');
  pod.replaceChildren();
  const top = ranking.filter((r) => r.rank <= 3).slice(0, 3);
  const order = top.length === 3 ? [1, 0, 2] : top.map((_, i) => i); // 2、1、3 的擺放順序
  order.forEach((i) => {
    const r = top[i];
    if (!r) return;
    const d = el('div', `pod p${r.rank}`);
    d.append(el('div', 'medal', MEDAL[r.rank - 1] || ''), el('div', 'pn', r.nick), el('div', 'ps', `${r.score} 分`),
      el('div', 'pm', `答對 ${r.correct}/${r.answered}${r.avgMs != null ? `・平均 ${fmtMs(r.avgMs)}` : ''}`));
    pod.append(d);
  });
  const tb = $('f-table');
  tb.replaceChildren();
  ranking.forEach((r) => {
    tb.append(rankRow({
      rank: r.rank, nick: r.nick, me: r.id === meId,
      sub: `答對 ${r.correct}/${r.answered}${r.avgMs != null ? `・平均 ${fmtMs(r.avgMs)}` : ''}`,
      right: `${r.score}`,
    }));
  });
}

/** 本題結果（揭曉時） */
export function renderReveal(m, meId) {
  const box = $('mreveal');
  box.replaceChildren();
  box.append(el('h3', null, `本題結果${m.reason === 'quorum' ? '（鎖定人數達標，倒數結束）' : m.reason === 'time' ? '（時間到）' : ''}`));
  const byId = new Map(m.rows.map((r) => [r.id, r]));
  const order = m.ranking.filter((r) => byId.has(r.id));
  order.forEach((rk) => {
    const row = byId.get(rk.id);
    const r = el('div', 'mrow' + (rk.id === meId ? ' me' : ''));
    r.append(el('span', 'rk', String(rk.rank)));
    const nm = el('span', 'nm', rk.nick);
    const pickText = row.failed ? '（本題影片無法播放）' : row.pick ? `選了「${row.pick}」` : '未作答';
    nm.append(el('small', null, pickText));
    const pt = el('span', 'pt ' + (row.correct ? 'ok' : row.points < 0 ? 'bad' : ''), row.failed ? '—' : (row.correct ? '✔ ' : row.answered ? '✘ ' : '') + (row.points > 0 ? `+${row.points}` : row.points < 0 ? `${row.points}` : '0'));
    r.append(nm, pt, el('span', 'tt', `${row.total}`));
    box.append(r);
  });
  box.classList.remove('hidden');
}
