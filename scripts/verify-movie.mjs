// 查核電影題庫：逐一讀 YouTube 影片頁，確認「影片標題／頻道／說明」真的提到這部作品。
// 用法：node scripts/verify-movie.mjs [--redo]
//  - 結果寫入 data/cache/verify-movie.json，並印出「沒在影片資訊裡找到作品名」的清單供人工檢查
//  - 判定：film = 影片資訊含作品名；artist = 影片標題／頻道含演唱者；兩者都沒有 → 可疑
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { ROOT, CACHE_DIR, CAT, norm } from './lib.mjs';

const REDO = process.argv.includes('--redo');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HEADERS = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36', 'accept-language': 'en;q=0.9', cookie: 'CONSENT=YES+1' };

const qs = JSON.parse(readFileSync(path.join(ROOT, 'data', (CAT === 'ost' ? 'ost' : 'movie') + '.json'), 'utf8'));
const cacheFile = path.join(CACHE_DIR, `verify-${CAT === 'ost' ? 'ost' : 'movie'}.json`);
const cache = existsSync(cacheFile) && !REDO ? JSON.parse(readFileSync(cacheFile, 'utf8')) : {};

async function info(id) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch('https://www.youtube.com/watch?hl=en&v=' + id, { headers: HEADERS });
      const html = await res.text();
      const d = html.match(/"shortDescription":"((?:[^"\\]|\\.)*)"/)?.[1] || '';
      const t = html.match(/<meta name="title" content="([^"]*)"/)?.[1] || '';
      if (!t && !d) throw new Error('empty');
      return { desc: JSON.parse('"' + d + '"').slice(0, 1500), title: t };
    } catch (e) {
      await sleep(1500 * (i + 1));
    }
  }
  return null;
}

/** 作品名可能出現的寫法 */
function names(work) {
  const m = work.match(/^(.*?)（(.*)）$/);
  const zh = (m ? m[1] : work).trim();
  const orig = (m ? m[2] : work).trim();
  const out = new Set();
  const add = (s) => { const n = norm(s); if (n.length >= 3) out.add(n); };
  add(orig); add(zh);
  for (const part of orig.split(/[:：–\-—&]/)) add(part.replace(/^the\s+/i, ''));
  add(zh.split('：')[0]);
  // 去掉年份、序號
  add(orig.replace(/\s*(1|2|3|4|5|6|7|8|9|ii|iii|iv|part \w+|vol\.? ?\d)$/i, ''));
  return [...out];
}

const todo = qs.filter((q) => !cache[q.id] || cache[q.id].yt !== q.ytId);
console.log(`待查 ${todo.length} / ${qs.length}`);
let n = 0;
let idx = 0;
await Promise.all(Array.from({ length: 4 }, async () => {
  while (idx < todo.length) {
    const q = todo[idx++];
    const r = await info(q.ytId);
    cache[q.id] = { yt: q.ytId, ...(r || { fail: true }) };
    if (++n % 25 === 0) { writeFileSync(cacheFile, JSON.stringify(cache)); console.log(`${n}/${todo.length}`); }
    await sleep(200);
  }
}));
writeFileSync(cacheFile, JSON.stringify(cache));

const bad = [];
let ok = 0;
for (const q of qs) {
  const c = cache[q.id];
  const hay = norm(`${q.video} ${q.channel} ${c?.title || ''} ${c?.desc || ''}`);
  const film = names(q.answer.work).some((x) => hay.includes(x));
  const who = (q.answer.artist || '').split(/[&,/、]|feat\.?/i).map((x) => norm(x)).filter((x) => x.length >= 2);
  const artist = who.some((x) => hay.includes(x));
  if (film) ok++;
  else bad.push({ id: q.id, work: q.answer.work.split('（')[0], song: q.answer.title, artist, video: q.video, channel: q.channel, yt: q.ytId });
}
console.log(`\n作品名有出現在影片資訊：${ok} / ${qs.length}`);
console.log(`找不到作品名（需人工確認）：${bad.length}`);
for (const b of bad) console.log(`${b.artist ? '○' : '✗'} ${b.work} / ${b.song} → [${b.channel}] ${b.video.slice(0, 70)} (${b.yt})`);
writeFileSync(path.join(CACHE_DIR, `verify-${CAT === 'ost' ? 'ost' : 'movie'}-suspects.json`), JSON.stringify(bad, null, 1));
