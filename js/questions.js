// 題庫載入與抽題
export const CATEGORIES = [
  { id: 'anime', label: '🎌 動漫歌曲 / OST', file: 'data/anime.json' },
  { id: 'song', label: '🎤 歌名 / 歌手', file: 'data/song.json' },
  { id: 'ost', label: '🎮 遊戲 / 其他 OST', file: 'data/ost.json' },
  { id: 'movie', label: '🎬 電影主題曲 / 配樂', file: 'data/movie.json' },
];

/** 回傳 { [categoryId]: Question[] }；讀不到或為空的題庫給空陣列 */
export async function loadBank() {
  const out = {};
  await Promise.all(CATEGORIES.map(async (c) => {
    try {
      const res = await fetch(c.file, { cache: 'no-cache' });
      out[c.id] = res.ok ? await res.json() : [];
    } catch {
      out[c.id] = [];
    }
  }));
  return out;
}

// 玩的時候回報「有問題」的題目（例如開頭不是音樂）：存在這台裝置，之後不再出現
const BAD_KEY = 'songguesser-bad';
export function loadBad() {
  try { return new Set(JSON.parse(localStorage.getItem(BAD_KEY) || '[]')); } catch { return new Set(); }
}
export function flagBad(id) {
  const s = loadBad();
  s.add(id);
  try { localStorage.setItem(BAD_KEY, JSON.stringify([...s])); } catch { /* ignore */ }
}

export function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * 依條件建立出題佇列：
 *  - 難度、類型篩選
 *  - 每部作品最多 maxPerWork 首
 *  - 盡量不讓同一作品連續出現
 * 多留幾題備用（影片失效時自動遞補）。
 */
export function buildQueue(pool, { kinds, maxDifficulty, maxPerWork, count }) {
  const bad = loadBad();
  let list = pool.filter((q) =>
    !q.disabled && !bad.has(q.id) &&
    (q.difficulty ?? 1) <= maxDifficulty &&
    (!q.kind || kinds.includes(q.kind)));
  list = shuffle(list);

  // 每部作品上限
  const perWork = new Map();
  list = list.filter((q) => {
    const n = perWork.get(q.workId) || 0;
    if (n >= maxPerWork) return false;
    perWork.set(q.workId, n + 1);
    return true;
  });

  // 避免同作品連續
  const want = Math.min(list.length, count + 12);
  const result = [];
  const rest = list.slice();
  while (result.length < want && rest.length) {
    const last = result.length ? result[result.length - 1].workId : null;
    let idx = rest.findIndex((q) => q.workId !== last);
    if (idx < 0) idx = 0;
    result.push(rest.splice(idx, 1)[0]);
  }
  return result;
}
