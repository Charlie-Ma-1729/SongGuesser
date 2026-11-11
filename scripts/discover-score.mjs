// 為電影題庫裡「只有歌」的作品，各找一首代表性的「純配樂」（主題曲／主旋律）。
// 用法：node scripts/discover-score.mjs --cat movie [--only 關鍵字]
//  - 去 YouTube 搜尋「作品名 + main theme / soundtrack」，挑官方／Topic 頻道、標題含作品名、沒人聲關鍵字的影片
//  - 結果寫到 data/cache/score-candidates.json（供人工檢查）與 data/seeds-movie/10-scores.txt（歌單格式）
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { parseSeeds, norm, CACHE_DIR, SEED_DIR } from './lib.mjs';

const args = process.argv.slice(2);
const ONLY = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HEADERS = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36', 'accept-language': 'en;q=0.9', cookie: 'CONSENT=YES+1' };

const BAD = /cover|piano|reaction|remix|slowed|reverb|nightcore|karaoke|tutorial|8d|loop|hours?|\bhour\b|live|concert|orchestra|symphony orchestra|tribute|arrange|medley|mashup|trailer|teaser|scene|clip|react|lyrics?|lyric|歌詞|ライブ|演奏|カバー|cover|violin|guitar|ukulele|flute|epic version|extended|1 ?hour|reaction|\bamv\b|mv\b|ending|opening credits|解説/i;
const VOCAL = /\bsong\b|feat\.?|ft\.?|vocal|sing|歌|主題歌|主题曲|ost\s*\d|duet|official video|music video/i;
const GOOD = /main (title|theme)|theme|suite|overture|prologue|opening|love theme|メインテーマ|テーマ|サウンドトラック|soundtrack|score/i;
const OFFICIAL = /- topic$|official|records|music|soundtrack|sony|warner|universal|disney|marvel|hbo|netflix|lakeshore|varese|decca|deutsche|milan|watertower|columbia|paramount|toho|ghibli|jvc|avex|pony ?canyon|king ?records/i;

function parseLen(t) { if (!t) return 0; return t.split(':').map(Number).reduce((a, b) => a * 60 + b, 0); }
async function search(q) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch('https://www.youtube.com/results?hl=en&search_query=' + encodeURIComponent(q), { headers: HEADERS });
      const html = await res.text();
      const m = html.match(/ytInitialData\s*=\s*(\{.+?\});\s*<\/script>/s);
      if (!m) throw new Error('no data');
      const out = [];
      const walk = (o) => {
        if (!o || typeof o !== 'object') return;
        if (o.videoRenderer) {
          const v = o.videoRenderer;
          out.push({ id: v.videoId, title: (v.title?.runs || []).map((r) => r.text).join(''), len: parseLen(v.lengthText?.simpleText), channel: (v.ownerText?.runs || []).map((r) => r.text).join('') });
          return;
        }
        for (const k in o) walk(o[k]);
      };
      walk(JSON.parse(m[1]));
      return out;
    } catch { await sleep(1500 * (i + 1)); }
  }
  return [];
}

function filmCores(work) {
  const orig = work.ja;
  const set = new Set();
  const add = (s) => { const n = norm(s); if (n.length >= 3) set.add(n); };
  add(orig);
  for (const p of orig.split(/[:：–\-—]/)) add(p.replace(/^the\s+/i, ''));
  add(work.zh.split('：')[0]);
  return [...set];
}

function scoreCand(c, cores) {
  const t = norm(c.title);
  const ch = c.channel.toLowerCase();
  if (!cores.some((x) => t.includes(x))) return -99;
  if (c.len < 60 || c.len > 600) return -99;
  // 作品名本身含有 bad 字眼時（例如 "Live" ）不算
  let strip = c.title;
  for (const w of cores) strip = strip.split(new RegExp(w.split('').join('\\W*'), 'i')).join(' ');
  if (BAD.test(strip) || BAD.test(c.channel)) return -50;
  let s = 0;
  if (GOOD.test(c.title)) s += 4;
  if (VOCAL.test(strip)) s -= 6;
  if (/- topic$/i.test(c.channel)) s += 6;
  else if (OFFICIAL.test(ch)) s += 3;
  if (/from ["“]|\(from/i.test(c.title)) s += 1;
  if (c.len >= 120 && c.len <= 420) s += 1;
  return s;
}

/** 影片標題 → 曲名 / 演出者 */
function clean(c, work) {
  let title = c.title.replace(/\((?:from|music from)[^)]*\)/ig, '').replace(/\[[^\]]*\]/g, '').replace(/\s*\|.*$/, '').replace(/official (audio|soundtrack|video)/ig, '').trim();
  let artist = /- topic$/i.test(c.channel) ? c.channel.replace(/\s*-\s*topic$/i, '') : null;
  const m = title.match(/^(.{2,40}?)\s+[-–]\s+(.+)$/);
  if (m) { if (!artist) artist = m[1].trim(); title = m[2].trim(); }
  title = title.replace(/\s*[-–]\s*$/, '').trim();
  return { title: title || c.title, artist };
}

const works = parseSeeds();
const todo = works.filter((w) => w.songs.some((s) => s.vocal) && !w.songs.some((s) => !s.vocal) && (!ONLY || w.work.includes(ONLY)));
console.log(`要找配樂的作品：${todo.length}`);
const outFile = path.join(CACHE_DIR, 'score-candidates.json');
const found = existsSync(outFile) ? JSON.parse(readFileSync(outFile, 'utf8')) : {};
let idx = 0;
let n = 0;
await Promise.all(Array.from({ length: 3 }, async () => {
  while (idx < todo.length) {
    const w = todo[idx++];
    if (found[w.work]) continue;
    const cores = filmCores(w);
    const jp = /[぀-ヿ一-鿿]/.test(w.ja);
    const queries = jp && !/[A-Za-z]{4}/.test(w.ja)
      ? [`${w.ja} メインテーマ サウンドトラック`, `${w.ja} OST main theme`]
      : [`${w.ja} main theme original soundtrack`, `${w.ja} main title score`];
    let best = null;
    for (const q of queries) {
      const rs = await search(q);
      for (const c of rs) {
        const s = scoreCand(c, cores);
        if (s > (best?.s ?? 1)) best = { s, ...c };
      }
      if (best && best.s >= 8) break;
      await sleep(300);
    }
    found[w.work] = best ? { ...best, ...clean(best, w), year: w.year } : { none: true };
    if (++n % 20 === 0) { writeFileSync(outFile, JSON.stringify(found, null, 1)); console.log(`${n}/${todo.length}`); }
    await sleep(250);
  }
}));
writeFileSync(outFile, JSON.stringify(found, null, 1));

// 輸出歌單
const lines = ['# 由 scripts/discover-score.mjs 自動挑選的純配樂（每部作品一首，已由人工檢查）', ''];
let ok = 0;
for (const w of todo) {
  const f = found[w.work];
  if (!f || f.none || f.skip) continue;
  const kv = [`q=${f.title} ${f.artist || ''} ${w.ja}`.replace(/\s+/g, ' ').trim(), `d=${Math.min(3, w.songs[0].difficulty + 1)}`].join(' ');
  lines.push(`# ${w.work} | ${w.year}`, `OST | ${f.title.replace(/\|/g, ' ')} | ${(f.artist || '?').replace(/\|/g, ' ')} | ${kv}`, '');
  ok++;
}
writeFileSync(path.join(SEED_DIR, '10-scores.txt'), lines.join('\n'));
console.log(`找到 ${ok} / ${todo.length}`);
