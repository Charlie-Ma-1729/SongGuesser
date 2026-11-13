// 伺服器端題庫：啟動時讀 data/*.json，收到 SIGHUP 時重新載入
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATEGORIES, choiceOf } from '../js/questions.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export { CATEGORIES };

/** { [catId]: Question[] } */
export let bank = {};
/** { [catId]: {k, main, sub}[] }：每個題庫的作品清單（打字搜尋用） */
export let works = {};

/** 作品的唯一鍵：歌名題庫用「歌名|歌手」，其他用 workId */
export function keyOf(q, cat) {
  if (cat === 'song') return `${q.answer?.title || ''}|${q.answer?.artist || ''}`;
  return q.workId;
}

export function loadBank() {
  const nb = {};
  const nw = {};
  for (const c of CATEGORIES) {
    const file = path.join(ROOT, c.file);
    let list = [];
    try { if (existsSync(file)) list = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { console.error('讀取題庫失敗', c.file, e.message); }
    nb[c.id] = list.filter((q) => !q.disabled);
    const seen = new Map();
    for (const q of nb[c.id]) {
      const k = keyOf(q, c.id);
      if (!k || seen.has(k)) continue;
      const ch = choiceOf(q, c.id);
      seen.set(k, { k, main: ch.main, sub: ch.sub });
    }
    nw[c.id] = [...seen.values()];
  }
  bank = nb;
  works = nw;
  const n = Object.values(nb).reduce((s, a) => s + a.length, 0);
  console.log(`題庫載入：${CATEGORIES.map((c) => `${c.id} ${nb[c.id].length}`).join('、')}（共 ${n} 題）`);
}

loadBank();
process.on('SIGHUP', () => { try { loadBank(); } catch (e) { console.error(e); } });
